import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AppError, ensure, CharacterSchema, SessionCreateSchema, MessageInputSchema, SettingsSchema,
  OutputSchemas, DecisionSchema, DraftSchema, ReviewSchema, MemorySchema, SourceSchema,
  type Character, type Intent, type Deferral, type RunKind, type ClaimedRun, type Context,
  type PublicAgent, type PublicMessage, type PublicSession, type PublicEvent, type Snapshot, type Usage, type ModelErrorCode,
} from '../contracts/index.js';
import { hash, coalesceDue, selectCandidate, retryDelay } from '../domain/index.js';
import { Store, characterOf, profileOf, settingsOf, intentOf,
  type SessionRow, type AgentRow, type CandidateRow, type RunRow, type MessageRow, type CallRow } from '../storage-sqlite/index.js';
import type { Config } from '../config/index.js';

type StoredDeferral = Deferral & { until: number };
const activeCandidateSQL = "SELECT * FROM candidates WHERE agent_id=? AND state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')";

/** Only this service writes conversation state. No asynchronous work occurs inside its transactions. */
export class SessionService {
  readonly changes = new EventEmitter();
  constructor(readonly store: Store, readonly config: Config, readonly now: () => number = Date.now,
    readonly random: () => number = Math.random) {
    this.changes.setMaxListeners(100);
    store.tx(() => {
      for (const slot of Object.keys(config.workerTokens)) store.run('INSERT OR IGNORE INTO workers(slot) VALUES(?)', slot);
      for (const character of config.characters) this.putCharacter(character);
    });
  }
  private write<T>(fn: () => T): T { const result = this.store.tx(fn); this.changes.emit('changed'); return result; }
  session(id: string): SessionRow { const s = this.store.get<SessionRow>('SELECT * FROM sessions WHERE id=?', id); ensure(s,404,'SESSION_NOT_FOUND'); return s; }
  agent(id: string): AgentRow { const a = this.store.get<AgentRow>('SELECT * FROM agent_instances WHERE id=?',id); ensure(a,404,'AGENT_NOT_FOUND'); return a; }
  agents(id: string): AgentRow[] { return this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE session_id=? ORDER BY rowid',id); }
  private candidate(id: string): CandidateRow|undefined { return this.store.get<CandidateRow>(activeCandidateSQL,id); }
  private emit(id: string, kind: string, data: Record<string,unknown>): void {
    this.store.run('INSERT INTO events(session_id,kind,revision,payload,created_at) VALUES(?,?,?,?,?)',id,kind,this.session(id).revision,JSON.stringify(data),this.now());
  }
  private trace(session: string, agent: string|null, run: string|null, code: string, detail: Record<string,unknown> = {}): void {
    this.store.run('INSERT INTO traces(session_id,agent_id,run_id,code,detail,created_at) VALUES(?,?,?,?,?,?)',session,agent,run,code,JSON.stringify(detail),this.now());
  }
  private receipt<T>(scope: string, key: string, payload: unknown, apply: () => T): T {
    ensure(/^[A-Za-z0-9_.:-]{8,128}$/.test(key),422,'IDEMPOTENCY_KEY_REQUIRED');
    return this.write(() => {
      const old = this.store.get<{request_hash:string;result_json:string}>('SELECT * FROM command_receipts WHERE scope=? AND key=?',scope,key);
      const digest = hash(payload);
      if (old) { ensure(old.request_hash===digest,409,'IDEMPOTENCY_CONFLICT'); return JSON.parse(old.result_json) as T; }
      const result = apply();
      this.store.run('INSERT INTO command_receipts(scope,key,request_hash,result_json) VALUES(?,?,?,?)',scope,key,digest,JSON.stringify(result));
      return result;
    });
  }
  commandReceipt(session: string, operation: string, key: string): unknown {
    this.session(session);
    const row = this.store.get<{result_json:string}>('SELECT result_json FROM command_receipts WHERE scope=? AND key=?',`operator:${session}:${operation}`,key);
    ensure(row,404,'COMMAND_NOT_FOUND'); return JSON.parse(row.result_json);
  }
  putCharacter(input: unknown): Character {
    const character = CharacterSchema.parse(input); const digest = hash(character);
    const old = this.store.get<{hash:string}>('SELECT hash FROM characters WHERE id=? AND version=?',character.id,character.version);
    if (old) ensure(old.hash===digest,409,'CHARACTER_VERSION_IMMUTABLE');
    else this.store.run('INSERT INTO characters(id,version,definition,hash) VALUES(?,?,?,?)',character.id,character.version,JSON.stringify(character),digest);
    return character;
  }
  characters(): Character[] {
    return this.store.all<{definition:string}>('SELECT c.definition FROM characters c WHERE c.version=(SELECT MAX(d.version) FROM characters d WHERE d.id=c.id) ORDER BY c.id').map(x=>JSON.parse(x.definition) as Character);
  }
  private selfWake(settings: ReturnType<typeof settingsOf>): number {
    return this.now()+settings.selfWakeMinMs+Math.floor(this.random()*(settings.selfWakeMaxMs-settings.selfWakeMinMs));
  }
  createSession(input: unknown, key: string): {id:string} {
    const data = SessionCreateSchema.parse(input);
    return this.receipt('operator:create',key,data,()=>{
      const id=randomUUID(), now=this.now();
      const definitions=this.characters();
      for (const p of data.participants) {
        ensure(definitions.some(c=>c.id===p.characterId),422,'UNKNOWN_CHARACTER');
        const profile=this.config.profiles.find(m=>m.id===p.profileId);
        ensure(profile,422,'UNKNOWN_MODEL_PROFILE'); ensure(profile.provider==='mock'||this.config.allowLive,403,'LIVE_DISABLED');
        ensure(this.config.workerTokens[p.slot],422,'UNKNOWN_WORKER_SLOT');
      }
      this.store.run('INSERT INTO sessions(id,title,created_at,last_activity_at,settings_json,lifecycle) VALUES(?,?,?,?,?,?)',id,data.title,now,now,JSON.stringify(data.settings),'DRAFT');
      for(const p of data.participants) {
        this.store.run('INSERT INTO agent_instances(id,session_id,slot,character_json,profile_json,next_self_at) VALUES(?,?,?,?,?,?)',
          randomUUID(),id,p.slot,JSON.stringify(definitions.find(c=>c.id===p.characterId)),JSON.stringify(this.config.profiles.find(m=>m.id===p.profileId)),this.selfWake(data.settings));
      }
      this.emit(id,'session.created',{}); return {id};
    });
  }
  private cancelRuns(sessionId: string, reason: string, slot?: string): void {
    const runs=this.store.all<RunRow>("SELECT * FROM runs WHERE session_id=? AND state='ACTIVE'"+(slot?' AND slot=?':''),...slot?[sessionId,slot]:[sessionId]);
    for(const run of runs) {
      this.store.run("UPDATE runs SET state='CANCELLED' WHERE id=?",run.id);
      // A cancelled local operation can still be running at the provider. Keep its slot until its deadline.
      this.store.run("UPDATE llm_calls SET status='ABANDONED' WHERE run_id=? AND status='RESERVED'",run.id);
      this.trace(sessionId,run.agent_id,run.id,reason);
    }
  }
  private pauseForLimit(id: string, reason: string): void {
    this.store.run("UPDATE sessions SET lifecycle='PAUSED',activity='BUDGET_PAUSED',stop_reason=?,epoch=epoch+1 WHERE id=?",reason,id);
    this.cancelRuns(id,'BUDGET_CANCELLED');
    this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE session_id=? AND state='READY'",id);
    this.store.run("UPDATE agent_instances SET state='paused' WHERE session_id=?",id);
    this.emit(id,'budget.paused',{reason});
  }
  private timeExceeded(s: SessionRow): boolean { return s.started_at!==null && this.now()-s.started_at>=settingsOf(s).maxDurationMs; }
  lifecycle(id: string, action: 'start'|'pause'|'resume'|'end', key: string): PublicSession {
    this.session(id);
    return this.receipt(`operator:${id}:lifecycle`,key,{action},()=>{
      const s=this.session(id);
      const allowed={start:['DRAFT'],pause:['RUNNING'],resume:['PAUSED'],end:['DRAFT','RUNNING','PAUSED']};
      ensure(allowed[action].includes(s.lifecycle),409,'INVALID_LIFECYCLE');
      if(action==='start'||action==='resume') {
        const st=settingsOf(s);
        ensure(s.call_count<st.maxCalls&&s.bot_count<st.maxMessages&&!this.timeExceeded(s),409,'LIMIT_ALREADY_REACHED');
        const count=this.store.get<{n:number}>("SELECT COUNT(*) n FROM sessions WHERE lifecycle='RUNNING' AND id<>?",id)!.n;
        ensure(count<this.config.maxRunning,409,'RUNNING_SESSION_LIMIT');
        this.store.run("UPDATE sessions SET lifecycle='RUNNING',activity='ACTIVE',stop_reason=NULL,epoch=epoch+1,started_at=COALESCE(started_at,?) WHERE id=?",this.now(),id);
      } else {
        this.store.run('UPDATE sessions SET lifecycle=?,epoch=epoch+1,stop_reason=? WHERE id=?',action==='end'?'ENDED':'PAUSED',action==='end'?'ENDED':'USER_PAUSED',id);
      }
      this.cancelRuns(id,'LIFECYCLE_CHANGED');
      this.store.run("UPDATE candidates SET state=? WHERE session_id=? AND state='READY'",action==='end'?'DROPPED':'NEEDS_REVIEW',id);
      if(action==='end') this.store.run("UPDATE candidates SET state='DROPPED',reason='ENDED' WHERE session_id=? AND state IN ('DRAFTING','NEEDS_REVIEW','DEFERRED')",id);
      for(const a of this.agents(id)) {
        this.store.run('UPDATE agent_instances SET state=?,next_self_at=? WHERE id=?',action==='end'?'ended':action==='pause'?'paused':'listening',this.selfWake(settingsOf(s)),a.id);
        if((action==='start'||action==='resume')&&a.enabled) this.wake(a.id,'RECOVERY');
      }
      this.emit(id,'session.'+action,{}); return this.publicSession(this.session(id));
    });
  }
  updateSettings(id: string, input: unknown, key: string): PublicSession {
    const settings=SettingsSchema.parse(input);
    return this.receipt(`operator:${id}:settings`,key,settings,()=>{
      const s=this.session(id); ensure(s.lifecycle==='DRAFT'||s.lifecycle==='PAUSED',409,'PAUSE_REQUIRED');
      this.store.run('UPDATE sessions SET settings_json=?,epoch=epoch+1 WHERE id=?',JSON.stringify(settings),id);
      this.cancelRuns(id,'SETTINGS_CHANGED'); this.emit(id,'session.settings',{}); return this.publicSession(this.session(id));
    });
  }
  setAgentEnabled(session: string, agentId: string, enabled: boolean, key: string): void {
    this.receipt(`operator:${session}:membership`,key,{agentId,enabled},()=>{
      const s=this.session(session),a=this.agent(agentId);
      ensure(a.session_id===session,403,'AGENT_SESSION_MISMATCH'); ensure(s.lifecycle==='DRAFT'||s.lifecycle==='PAUSED',409,'PAUSE_REQUIRED');
      this.cancelRuns(session,'MEMBERSHIP_CHANGED');
      this.store.run('UPDATE sessions SET epoch=epoch+1 WHERE id=?',session);
      this.store.run('UPDATE agent_instances SET enabled=?,state=? WHERE id=?',enabled?1:0,enabled?'listening':'disabled',agentId);
      this.store.run("UPDATE candidates SET state='DROPPED',reason='MEMBERSHIP_CHANGED' WHERE agent_id=? AND state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')",agentId);
      this.emit(session,'session.membership',{agentId,enabled}); return {ok:true};
    });
  }
  recover(): void {
    this.write(()=>{
      this.store.run('UPDATE workers SET epoch=epoch+1');
      this.store.run("UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED'");
      for(const s of this.store.all<SessionRow>('SELECT * FROM sessions')) {
        this.cancelRuns(s.id,'CORE_RECOVERY');
        if(s.lifecycle!=='RUNNING') continue;
        this.store.run('UPDATE sessions SET epoch=epoch+1 WHERE id=?',s.id);
        this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE session_id=? AND state='READY'",s.id);
        if(this.config.restartPolicy==='paused') {
          this.store.run("UPDATE sessions SET lifecycle='PAUSED',stop_reason='RECOVERY_REQUIRES_RESUME' WHERE id=?",s.id);
        } else for(const a of this.agents(s.id)) if(a.enabled) this.wake(a.id,'RECOVERY');
        this.emit(s.id,'session.recovered',{policy:this.config.restartPolicy});
      }
    });
  }
  private wake(agentId: string, trigger: string, author: string|null=null): void {
    let a=this.agent(agentId); if(!a.enabled) return;
    const s=this.session(a.session_id),st=settingsOf(s);
    let deferral=a.deferral_json?JSON.parse(a.deferral_json) as StoredDeferral:null;
    const isMessage=['MESSAGE','DIRECTED','EDIT'].includes(trigger);
    if(deferral&&(deferral.until<=this.now()||(deferral.kind==='new_message'&&isMessage)||
      (deferral.kind==='answer_from'&&isMessage&&author===deferral.agentId)||trigger==='RECOVERY')) {
      deferral=null;
      this.store.run('UPDATE agent_instances SET deferral_json=NULL,pending_since=NULL,due_at=NULL WHERE id=?',a.id);
      const c=this.candidate(a.id);
      if(c?.state==='DEFERRED') this.store.run('UPDATE candidates SET state=?,defer_json=NULL WHERE id=?',c.text?'NEEDS_REVIEW':'DRAFTING',c.id);
      a=this.agent(agentId);
    }
    const pending=a.wake_seq>a.processed_wake;
    const due=coalesceDue(pending?a.pending_since:null,pending?a.due_at:null,this.now(),trigger==='DIRECTED'?st.directedDebounceMs:st.debounceMs,st.maxCoalesceMs);
    this.store.run('UPDATE agent_instances SET dirty_revision=?,wake_seq=wake_seq+1,pending_since=?,due_at=?,trigger=?,error_count=0 WHERE id=?',
      s.revision,due.since,deferral?deferral.until:due.due,trigger,a.id);
    this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE agent_id=? AND state='READY'",a.id);
  }
  private validateIntent(session: string, self: string|null, intent: Intent): void {
    if(intent.replyTo) {
      const m=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',intent.replyTo);
      ensure(m&&m.session_id===session&&!m.deleted,422,'INVALID_REPLY_REFERENCE');
    }
    ensure(new Set(intent.addressedTo).size===intent.addressedTo.length,422,'DUPLICATE_ADDRESSEE');
    for(const id of intent.addressedTo) { const a=this.agent(id); ensure(a.session_id===session&&a.enabled&&a.id!==self,422,'INVALID_ADDRESSEE'); }
  }
  private append(session: string, author: string|null, text: string, intent: Intent, candidateId: string|null): PublicMessage {
    this.validateIntent(session,author,intent);
    const s=this.session(session),now=this.now();
    const episode=s.revision>0&&now-s.last_activity_at>=settingsOf(s).episodeGapMs?s.episode+1:s.episode;
    const id=randomUUID(),revision=s.revision+1;
    this.store.run('UPDATE sessions SET revision=?,last_activity_at=?,last_post_at=?,episode=?,activity=? WHERE id=?',revision,now,now,episode,'ACTIVE',session);
    this.store.run('INSERT INTO messages(id,session_id,revision,author_id,text,act,reply_to,addressed_json,candidate_id,episode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id,session,revision,author,text,intent.act,intent.replyTo,JSON.stringify(intent.addressedTo),candidateId,episode,now);
    this.store.run('INSERT INTO messages_fts(message_id,session_id,text) VALUES(?,?,?)',id,session,text);
    if(intent.act==='question') for(const target of intent.addressedTo.length?intent.addressedTo:['*']) this.store.run('INSERT INTO pending_questions(message_id,target) VALUES(?,?)',id,target);
    if(intent.replyTo&&['answer','correction'].includes(intent.act)) this.store.run("UPDATE pending_questions SET answered_by=? WHERE message_id=? AND (target=? OR target='*') AND answered_by IS NULL",id,intent.replyTo,author??'human');
    for(const a of this.agents(session)) {
      if(a.id===author) this.store.run('UPDATE agent_instances SET last_post_at=?,processed_revision=?,dirty_revision=? WHERE id=?',now,revision,revision,a.id);
      else this.wake(a.id,intent.addressedTo.includes(a.id)?'DIRECTED':'MESSAGE',author);
    }
    this.emit(session,'message.created',{messageId:id});
    return this.publicMessage(this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',id)!);
  }
  humanMessage(session: string, input: unknown, key: string): PublicMessage {
    const data=MessageInputSchema.parse(input);
    return this.receipt(`operator:${session}:message`,key,data,()=>{
      ensure(this.session(session).lifecycle!=='ENDED',409,'SESSION_ENDED');
      return this.append(session,null,data.text,{act:data.addressedTo.length?'question':'comment',intent:'Human contribution',replyTo:data.replyTo,addressedTo:data.addressedTo},null);
    });
  }
  changeMessage(session: string, messageId: string, text: string|null, key: string): PublicMessage {
    if(text!==null) text=MessageInputSchema.parse({text}).text;
    return this.receipt(`operator:${session}:edit`,key,{messageId,text},()=>{
      const s=this.session(session),m=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',messageId);
      ensure(s.lifecycle!=='ENDED',409,'SESSION_ENDED'); ensure(m&&m.session_id===session&&!m.deleted,404,'MESSAGE_NOT_FOUND');
      ensure(text===null||m.author_id===null,403,'BOT_TEXT_IMMUTABLE');
      this.store.run('UPDATE sessions SET revision=revision+1 WHERE id=?',session);
      this.store.run('UPDATE messages SET text=?,deleted=?,revision=? WHERE id=?',text??'',text===null?1:0,s.revision+1,messageId);
      this.store.run('DELETE FROM messages_fts WHERE message_id=?',messageId);
      if(text!==null) this.store.run('INSERT INTO messages_fts(message_id,session_id,text) VALUES(?,?,?)',messageId,session,text);
      for(const a of this.agents(session)) this.wake(a.id,'EDIT');
      this.emit(session,text===null?'message.deleted':'message.updated',{messageId});
      return this.publicMessage(this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',messageId)!);
    });
  }
  injectSource(session: string, input: unknown, externalId: string, source='manual'): {id:string} {
    const data=SourceSchema.parse(input);
    return this.receipt(`operator:${session}:source:${source}`,externalId,data,()=>{
      ensure(this.session(session).lifecycle!=='ENDED',409,'SESSION_ENDED');
      const old=this.store.get<{id:string}>('SELECT id FROM source_items WHERE session_id=? AND source=? AND external_id=?',session,source,externalId);
      if(old) return old;
      const id=randomUUID();
      this.store.run('INSERT INTO source_items(id,session_id,source,external_id,title,text,url,published_at,fetched_at) VALUES(?,?,?,?,?,?,?,?,?)',id,session,source,externalId,data.title,data.text,data.url,data.publishedAt,this.now());
      for(const a of this.agents(session)) this.wake(a.id,'SOURCE_AVAILABLE');
      this.emit(session,'source.available',{sourceId:id,title:data.title}); return {id};
    });
  }
  registerWorker(slot: string): {epoch:number} {
    ensure(this.config.workerTokens[slot],403,'WORKER_FORBIDDEN');
    return this.write(()=>{
      this.store.run('UPDATE workers SET epoch=epoch+1 WHERE slot=?',slot);
      for(const a of this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE slot=?',slot)) {
        this.cancelRuns(a.session_id,'WORKER_REPLACED',slot);
        if(this.session(a.session_id).lifecycle==='RUNNING') this.wake(a.id,'RECOVERY');
      }
      return {epoch:this.store.get<{epoch:number}>('SELECT epoch FROM workers WHERE slot=?',slot)!.epoch};
    });
  }
  private verifyEpoch(slot: string, epoch: number): void {
    ensure(this.store.get<{epoch:number}>('SELECT epoch FROM workers WHERE slot=?',slot)?.epoch===epoch,409,'STALE_WORKER');
  }
  private ownRun(slot: string, id: string, token: string): RunRow {
    const r=this.store.get<RunRow>('SELECT * FROM runs WHERE id=?',id); ensure(r,404,'RUN_NOT_FOUND');
    ensure(r.slot===slot&&r.token===token,403,'RUN_FORBIDDEN'); return r;
  }
  private validRun(slot: string, epoch: number, id: string, token: string): RunRow {
    const r=this.ownRun(slot,id,token); this.verifyEpoch(slot,epoch);
    const s=this.session(r.session_id),a=this.agent(r.agent_id);
    ensure(r.state==='ACTIVE'&&r.worker_epoch===epoch&&r.session_epoch===s.epoch&&s.lifecycle==='RUNNING'&&a.enabled&&r.lease_until>this.now(),409,'STALE_RUN');
    return r;
  }
  private context(agent: AgentRow, candidate?: CandidateRow): Context {
    const s=this.session(agent.session_id),st=settingsOf(s);
    let rows=this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? ORDER BY revision DESC LIMIT ?',s.id,st.contextMessages).reverse();
    let chars=rows.reduce((n,m)=>n+m.text.length,0);
    while(rows.length>1&&chars>st.contextChars/2) { chars-=rows[0].text.length; rows.shift(); }
    const messages=rows.map(m=>this.publicMessage(m));
    const memories=this.workerMemories(agent.slot,agent.id).slice(-12);
    const questions=this.store.all<{message_id:string;text:string;author_id:string|null}>(
      "SELECT q.message_id,m.text,m.author_id FROM pending_questions q JOIN messages m ON m.id=q.message_id WHERE m.session_id=? AND m.deleted=0 AND q.answered_by IS NULL AND (q.target=? OR q.target='*') ORDER BY m.revision DESC LIMIT 8",s.id,agent.id)
      .map(q=>({messageId:q.message_id,text:q.text.slice(0,800),from:q.author_id}));
    const sources=this.store.all<{id:string;title:string;text:string;url:string|null;published_at:string|null;fetched_at:number}>(
      'SELECT * FROM source_items WHERE session_id=? ORDER BY fetched_at DESC,rowid DESC LIMIT 4',s.id)
      .map(x=>({id:x.id,title:x.title,text:x.text.slice(0,1600),url:x.url,publishedAt:x.published_at,fetchedAt:x.fetched_at}));
    const delta=candidate?this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND revision>? ORDER BY revision LIMIT 100',s.id,candidate.reviewed_revision).map(m=>this.publicMessage(m)):[];
    return {self:{id:agent.id,character:characterOf(agent)},participants:this.agents(s.id).filter(a=>a.enabled).map(a=>this.publicAgent(a)),
      revision:s.revision,trigger:agent.trigger,messages,delta,historyTruncated:rows.length>0&&rows[0].revision>1,
      memories,questions,sources,candidate:candidate?{id:candidate.id,version:candidate.version,intent:intentOf(candidate),text:candidate.text,reviewedRevision:candidate.reviewed_revision}:null};
  }
  private claimed(r: RunRow): ClaimedRun {
    const a=this.agent(r.agent_id),st=settingsOf(this.session(r.session_id));
    return {id:r.id,token:r.token,kind:r.kind,workerEpoch:r.worker_epoch,sessionEpoch:r.session_epoch,
      leaseMs:st.leaseMs,timeoutMs:st.requestTimeoutMs,contextChars:st.contextChars,profile:profileOf(a),context:JSON.parse(r.context_json) as Context};
  }
  claim(slot: string, epoch: number): ClaimedRun|null {
    this.tick();
    return this.write(()=>{
      this.verifyEpoch(slot,epoch);
      const old=this.store.get<RunRow>("SELECT * FROM runs WHERE slot=? AND state='ACTIVE'",slot);
      if(old) return this.claimed(old);
      for(const a of this.store.all<AgentRow>("SELECT a.* FROM agent_instances a JOIN sessions s ON s.id=a.session_id WHERE a.slot=? AND a.enabled=1 AND s.lifecycle='RUNNING' ORDER BY a.rowid",slot)) {
        const s=this.session(a.session_id),st=settingsOf(s),c=this.candidate(a.id);
        if(a.error_count>st.maxRetries||a.deferral_json||(a.due_at!==null&&a.due_at>this.now())) continue;
        let kind: RunKind|undefined;
        if(c?.state==='DRAFTING') kind='draft';
        else if(c?.state==='NEEDS_REVIEW') kind=c.text?'review':'draft';
        else if(c) continue;
        else if(a.wake_seq>a.processed_wake&&this.now()>=a.last_post_at+st.agentCooldownMs) kind='decide';
        else if(a.wake_seq===a.processed_wake&&s.revision-a.memory_revision>=st.memoryEvery) kind='memory';
        if(!kind) continue;
        const id=randomUUID(),token=randomUUID(),context=this.context(a,c);
        this.store.run('INSERT INTO runs(id,agent_id,session_id,slot,worker_epoch,session_epoch,kind,token,state,snapshot_revision,wake_seq,candidate_id,candidate_version,created_at,lease_until,context_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id,a.id,s.id,slot,epoch,s.epoch,kind,token,'ACTIVE',s.revision,a.wake_seq,c?.id??null,c?.version??null,this.now(),this.now()+st.leaseMs,JSON.stringify(context));
        this.store.run('UPDATE agent_instances SET state=? WHERE id=?',kind==='review'?'reviewing':kind==='memory'?'remembering':'thinking',a.id);
        this.trace(s.id,a.id,id,'RUN_STARTED',{kind,revision:s.revision}); this.emit(s.id,'agent.status',{agentId:a.id,status:kind==='review'?'reviewing':'thinking'});
        return this.claimed(this.store.get<RunRow>('SELECT * FROM runs WHERE id=?',id)!);
      }
      return null;
    });
  }
  heartbeat(slot: string, epoch: number, id: string, token: string): {ok:true} {
    return this.write(()=>{ const r=this.validRun(slot,epoch,id,token); this.store.run('UPDATE runs SET lease_until=? WHERE id=?',this.now()+settingsOf(this.session(r.session_id)).leaseMs,id); return {ok:true}; });
  }
  reserveCall(slot: string, epoch: number, id: string, token: string, requestKey: string, stage: 'primary'|'repair'): {id:string} {
    const result=this.write(()=>{
      const r=this.validRun(slot,epoch,id,token),s=this.session(r.session_id),p=profileOf(this.agent(r.agent_id)),st=settingsOf(s);
      const old=this.store.get<CallRow>('SELECT * FROM llm_calls WHERE run_id=? AND request_key=?',id,requestKey);
      if(old) { ensure(old.stage===stage,409,'IDEMPOTENCY_CONFLICT'); return {id:old.id}; }
      if(this.timeExceeded(s)||s.call_count>=st.maxCalls) { this.pauseForLimit(s.id,this.timeExceeded(s)?'MAX_DURATION':'MAX_CALLS'); return {blocked:true}; }
      const previous=this.store.all<CallRow>('SELECT * FROM llm_calls WHERE run_id=?',id);
      ensure(previous.length<2&&!previous.some(c=>c.stage===stage),409,'CALL_ATTEMPT_LIMIT');
      ensure(stage==='primary'?previous.length===0:previous.some(c=>c.stage==='primary'&&c.status==='FINISHED'&&!c.error_code),409,'INVALID_REPAIR');
      const scope=p.provider==='mock'?'mock':new URL(p.baseUrl!).origin;
      const active=this.store.get<{n:number}>("SELECT COUNT(*) n FROM llm_calls WHERE scope=? AND status IN ('RESERVED','ABANDONED') AND expires_at>?",scope,this.now())!.n;
      ensure(active<this.config.maxConcurrentProvider,429,'PROVIDER_BUSY');
      ensure(!previous.some(c=>['RESERVED','ABANDONED'].includes(c.status)&&c.expires_at>this.now()),429,'RUN_BUSY');
      const callId=randomUUID();
      this.store.run('INSERT INTO llm_calls(id,run_id,request_key,scope,stage,status,started_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',callId,id,requestKey,scope,stage,'RESERVED',this.now(),this.now()+st.requestTimeoutMs+10000);
      this.store.run('UPDATE sessions SET call_count=call_count+1 WHERE id=?',s.id);
      this.trace(s.id,r.agent_id,r.id,'CALL_RESERVED',{kind:r.kind,stage,provider:p.provider}); return {id:callId};
    });
    if('blocked' in result) throw new AppError(409,'BUDGET_STOPPED'); return result;
  }
  finishCall(slot: string, id: string, token: string, callId: string, usage: Usage, error: ModelErrorCode|null): {ok:true} {
    return this.write(()=>{
      const r=this.ownRun(slot,id,token),c=this.store.get<CallRow>('SELECT * FROM llm_calls WHERE id=?',callId);
      ensure(c&&c.run_id===r.id,403,'CALL_FORBIDDEN'); const digest=hash({usage,error});
      if(c.result_hash) { ensure(c.result_hash===digest,409,'IDEMPOTENCY_CONFLICT'); return {ok:true}; }
      this.store.run('UPDATE llm_calls SET status=?,finished_at=?,input_tokens=?,output_tokens=?,error_code=?,result_hash=? WHERE id=?',
        error==='TIMEOUT'||error==='CANCELLED'?'ABANDONED':'FINISHED',this.now(),usage.inputTokens,usage.outputTokens,error,digest,callId);
      return {ok:true};
    });
  }
  private defer(agentId: string, value: Deferral): void {
    const a=this.agent(agentId);
    if(value.agentId) ensure(this.agent(value.agentId).session_id===a.session_id&&value.agentId!==agentId,422,'INVALID_DEFER_TARGET');
    const stored:StoredDeferral={...value,until:this.now()+value.afterMs};
    this.store.run("UPDATE agent_instances SET deferral_json=?,due_at=?,state='waiting' WHERE id=?",JSON.stringify(stored),stored.until,agentId);
    const c=this.candidate(agentId); if(c) this.store.run("UPDATE candidates SET state='DEFERRED',defer_json=? WHERE id=?",JSON.stringify(stored),c.id);
  }
  completeRun(slot: string, epoch: number, id: string, token: string, output: unknown): {ok:true} {
    const before=this.ownRun(slot,id,token),parsed=OutputSchemas[before.kind].parse(output),digest=hash(parsed);
    return this.write(()=>{
      const existing=this.ownRun(slot,id,token);
      if(existing.state==='DONE') { ensure(existing.result_hash===digest,409,'IDEMPOTENCY_CONFLICT'); return {ok:true}; }
      const r=this.validRun(slot,epoch,id,token),s=this.session(r.session_id),st=settingsOf(s),a=this.agent(r.agent_id);
      ensure(this.store.get<{n:number}>("SELECT COUNT(*) n FROM llm_calls WHERE run_id=? AND status='FINISHED' AND error_code IS NULL",id)!.n>0,409,'MODEL_CALL_NOT_RECORDED');
      const c=r.candidate_id?this.store.get<CandidateRow>('SELECT * FROM candidates WHERE id=?',r.candidate_id):undefined;
      if(r.candidate_id) ensure(c&&c.version===r.candidate_version&&c.agent_id===r.agent_id&&!['COMMITTED','DROPPED'].includes(c.state),409,'STALE_CANDIDATE');
      const ready=r.snapshot_revision===s.revision&&r.wake_seq===a.wake_seq;
      const notBefore=Math.max(this.now()+st.arbitrationMs+Math.floor(this.random()*Math.min(500,st.arbitrationMs)),a.last_post_at+st.agentCooldownMs);
      if(r.kind==='decide') {
        const result=DecisionSchema.parse(parsed);
        if(result.decision==='SPEAK') {
          this.validateIntent(s.id,a.id,result.intent);
          ensure(!this.candidate(a.id),409,'CANDIDATE_ALREADY_EXISTS');
          this.store.run('INSERT INTO candidates(id,agent_id,session_id,state,intent_json,reviewed_revision,reviewed_wake,first_interested_at,not_before,review_due_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            randomUUID(),a.id,s.id,'DRAFTING',JSON.stringify(result.intent),r.snapshot_revision,r.wake_seq,this.now(),notBefore,this.now()+st.reviewTtlMs);
        } else if(result.decision==='DEFER') this.defer(a.id,result.defer);
        this.trace(s.id,a.id,id,result.decision);
      } else if(r.kind==='draft') {
        const result=DraftSchema.parse(parsed); ensure(c,409,'CANDIDATE_MISSING');
        if(result.decision==='DROP') this.store.run("UPDATE candidates SET state='DROPPED',reason='MODEL_DROP' WHERE id=?",c.id);
        else this.store.run('UPDATE candidates SET text=?,version=version+1,state=?,reviewed_revision=?,reviewed_wake=?,not_before=?,review_due_at=? WHERE id=?',
          result.text,ready?'READY':'NEEDS_REVIEW',r.snapshot_revision,r.wake_seq,notBefore,this.now()+st.reviewTtlMs,c.id);
        this.trace(s.id,a.id,id,result.decision,{stale:!ready});
      } else if(r.kind==='review') {
        const result=ReviewSchema.parse(parsed); ensure(c,409,'CANDIDATE_MISSING');
        if(result.decision==='DROP') this.store.run("UPDATE candidates SET state='DROPPED',reason='MODEL_DROP' WHERE id=?",c.id);
        else if(result.decision==='DEFER') this.defer(a.id,result.defer);
        else {
          if(result.decision==='REWRITE') this.validateIntent(s.id,a.id,result.intent);
          this.store.run('UPDATE candidates SET text=?,intent_json=?,version=version+1,state=?,reviewed_revision=?,reviewed_wake=?,not_before=?,review_due_at=? WHERE id=?',
            result.decision==='REWRITE'?result.text:c.text,result.decision==='REWRITE'?JSON.stringify(result.intent):c.intent_json,
            ready?'READY':'NEEDS_REVIEW',r.snapshot_revision,r.wake_seq,notBefore,this.now()+st.reviewTtlMs,c.id);
        }
        this.trace(s.id,a.id,id,'REVIEW_'+result.decision,{from:c.reviewed_revision,to:r.snapshot_revision,stale:!ready});
      } else {
        const result=MemorySchema.parse(parsed);
        for(const note of result.notes) {
          for(const ref of note.sourceMessageIds) {
            const m=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',ref);
            ensure(m&&m.session_id===s.id&&!m.deleted&&m.revision<=r.snapshot_revision,422,'INVALID_MEMORY_SOURCE');
          }
          const sources=JSON.stringify([...new Set(note.sourceMessageIds)].sort());
          if(!this.store.get('SELECT id FROM memories WHERE agent_id=? AND text=? AND sources_json=?',a.id,note.text,sources))
            this.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at) VALUES(?,?,?,?,?)',randomUUID(),a.id,note.text,sources,this.now());
        }
        this.store.run('DELETE FROM memories WHERE agent_id=? AND id NOT IN (SELECT id FROM memories WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50)',a.id,a.id);
        this.store.run('UPDATE agent_instances SET memory_revision=? WHERE id=?',r.snapshot_revision,a.id);
        this.trace(s.id,a.id,id,'MEMORY_SAVED',{notes:result.notes.length});
      }
      this.store.run("UPDATE runs SET state='DONE',result_hash=?,result_json=? WHERE id=?",digest,JSON.stringify({ok:true}),id);
      if(r.kind!=='memory') this.store.run('UPDATE agent_instances SET processed_revision=MAX(processed_revision,?),processed_wake=MAX(processed_wake,?) WHERE id=?',r.snapshot_revision,r.wake_seq,a.id);
      const next=this.agent(a.id),cand=this.candidate(a.id);
      const status=next.deferral_json||cand?'waiting':'listening';
      const due=next.deferral_json?next.due_at:cand&&cand.state!=='READY'?this.now():next.wake_seq>next.processed_wake?(next.due_at??this.now()):null;
      this.store.run('UPDATE agent_instances SET error_count=0,state=?,due_at=?,pending_since=CASE WHEN wake_seq<=processed_wake THEN NULL ELSE pending_since END WHERE id=?',status,due,a.id);
      this.emit(s.id,'agent.status',{agentId:a.id,status}); return {ok:true};
    });
  }
  failRun(slot: string, epoch: number, id: string, token: string, code: ModelErrorCode): {ok:true} {
    return this.write(()=>{
      const previous=this.ownRun(slot,id,token); if(previous.state==='FAILED') return {ok:true};
      const r=this.validRun(slot,epoch,id,token),a=this.agent(r.agent_id),st=settingsOf(this.session(r.session_id));
      this.store.run("UPDATE runs SET state='FAILED',result_json=? WHERE id=?",JSON.stringify({code}),id);
      this.store.run("UPDATE llm_calls SET status='ABANDONED' WHERE run_id=? AND status='RESERVED'",id);
      const count=a.error_count+1;
      this.store.run('UPDATE agent_instances SET error_count=?,state=?,due_at=?,wake_seq=wake_seq+1 WHERE id=?',count,count>st.maxRetries?'error':'retrying',this.now()+retryDelay(count),a.id);
      this.store.run("UPDATE sessions SET activity='DEGRADED' WHERE id=?",r.session_id);
      this.trace(r.session_id,a.id,id,code,{retry:count<=st.maxRetries}); this.emit(r.session_id,'agent.status',{agentId:a.id,status:'error',code}); return {ok:true};
    });
  }
  private commitOne(id: string): PublicMessage|null {
    let s=this.session(id); if(s.lifecycle!=='RUNNING') return null;
    const st=settingsOf(s);
    if(this.timeExceeded(s)) { this.pauseForLimit(id,'MAX_DURATION'); return null; }
    if(s.bot_count>=st.maxMessages) { this.pauseForLimit(id,'MAX_MESSAGES'); return null; }
    if(this.now()<s.last_post_at+st.postGapMs) return null;
    const latest=this.store.get<MessageRow>('SELECT * FROM messages WHERE session_id=? AND deleted=0 ORDER BY revision DESC LIMIT 1',id);
    const targets=latest?JSON.parse(latest.addressed_json) as string[]:[];
    const all=this.store.all<CandidateRow>("SELECT * FROM candidates WHERE session_id=? AND state='READY'",id);
    const eligible=all.map(c=>{ const a=this.agent(c.agent_id); return {
      id:c.id,agentId:a.id,state:a.enabled?c.state:'DISABLED',reviewedRevision:c.reviewed_revision,reviewedWake:c.reviewed_wake,
      currentWake:a.wake_seq,firstInterestedAt:c.first_interested_at,notBefore:c.not_before,directed:targets.includes(a.id),
    }; });
    const selected=selectCandidate(eligible,s.revision,this.now(),st.agingMs,targets,latest?latest.created_at+st.replyGraceMs:0);
    if(!selected) return null;
    const c=all.find(c=>c.id===selected.id)!;
    if(c.review_due_at<=this.now()) { this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE id=?",c.id); return null; }
    ensure(c.text,409,'EMPTY_CANDIDATE');
    try { this.validateIntent(id,c.agent_id,intentOf(c)); }
    catch(e) { if(!(e instanceof AppError)) throw e; this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE id=?",c.id); this.trace(id,c.agent_id,null,'REFERENCE_REVIEW_REQUIRED'); return null; }
    const message=this.append(id,c.agent_id,c.text,intentOf(c),c.id);
    this.store.run("UPDATE candidates SET state='COMMITTED' WHERE id=?",c.id);
    this.store.run('UPDATE sessions SET bot_count=bot_count+1 WHERE id=?',id);
    this.store.run("UPDATE agent_instances SET state='listening' WHERE id=?",c.agent_id);
    this.trace(id,c.agent_id,null,'COMMITTED',{candidateId:c.id,version:c.version,revision:message.revision,waitMs:this.now()-c.first_interested_at});
    s=this.session(id); if(s.bot_count>=st.maxMessages) this.pauseForLimit(id,'MAX_MESSAGES');
    return message;
  }
  commitNext(id: string): PublicMessage|null { return this.write(()=>this.commitOne(id)); }
  tick(): void {
    this.write(()=>{
      for(const run of this.store.all<RunRow>("SELECT * FROM runs WHERE state='ACTIVE' AND lease_until<=?",this.now())) {
        this.store.run("UPDATE runs SET state='CANCELLED' WHERE id=?",run.id);
        this.store.run("UPDATE llm_calls SET status='ABANDONED' WHERE run_id=? AND status='RESERVED'",run.id);
        if(this.session(run.session_id).lifecycle==='RUNNING') this.wake(run.agent_id,'RECOVERY');
        this.trace(run.session_id,run.agent_id,run.id,'LEASE_EXPIRED');
      }
      for(let s of this.store.all<SessionRow>("SELECT * FROM sessions WHERE lifecycle='RUNNING'")) {
        if(this.timeExceeded(s)) { this.pauseForLimit(s.id,'MAX_DURATION'); continue; }
        for(const a of this.agents(s.id)) {
          if(!a.enabled) continue;
          const st=settingsOf(s),c=this.candidate(a.id);
          if(a.deferral_json&&(JSON.parse(a.deferral_json) as StoredDeferral).until<=this.now()) this.wake(a.id,'DEFER_DUE');
          if(c?.state==='READY'&&(c.review_due_at<=this.now()||c.reviewed_revision!==s.revision||c.reviewed_wake!==a.wake_seq)) {
            this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE id=?",c.id);
          }
          const busy=!!c||!!this.store.get("SELECT id FROM runs WHERE agent_id=? AND state='ACTIVE'",a.id);
          if(!busy&&!a.deferral_json&&a.wake_seq===a.processed_wake&&a.error_count===0) {
            if(this.now()-s.last_activity_at>=st.idleMs&&a.idle_checked<s.revision) {
              this.store.run('UPDATE agent_instances SET idle_checked=? WHERE id=?',s.revision,a.id); this.wake(a.id,'IDLE');
            } else if(this.now()>=a.next_self_at) {
              this.store.run('UPDATE agent_instances SET next_self_at=? WHERE id=?',this.selfWake(st),a.id); this.wake(a.id,'SELF_WAKE');
            }
          }
        }
        this.commitOne(s.id); s=this.session(s.id); if(s.lifecycle!=='RUNNING') continue;
        const agents=this.agents(s.id).filter(a=>a.enabled);
        const busy=agents.some(a=>a.wake_seq>a.processed_wake&&a.error_count<=settingsOf(s).maxRetries||!!this.candidate(a.id))||
          !!this.store.get("SELECT id FROM runs WHERE session_id=? AND state='ACTIVE'",s.id);
        const activity=agents.some(a=>a.error_count>0)?'DEGRADED':busy?'ACTIVE':'QUIET';
        if(activity!==s.activity) { this.store.run('UPDATE sessions SET activity=? WHERE id=?',activity,s.id); this.emit(s.id,'session.activity',{activity}); }
      }
    });
  }
  workerMemories(slot: string, agentId: string): {id:string;text:string;sourceMessageIds:string[]}[] {
    const a=this.agent(agentId); ensure(a.slot===slot,403,'PRIVATE_STATE_FORBIDDEN');
    return this.store.all<{id:string;text:string;sources_json:string}>('SELECT * FROM memories WHERE agent_id=? ORDER BY created_at,rowid',agentId)
      .map(m=>({id:m.id,text:m.text,sourceMessageIds:JSON.parse(m.sources_json) as string[]}))
      .filter(m=>m.sourceMessageIds.every(id=>!!this.store.get('SELECT id FROM messages WHERE id=? AND session_id=? AND deleted=0',id,a.session_id)));
  }
  archiveMessage(session: string, id: string): PublicMessage {
    this.session(session); const m=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?',id,session);
    ensure(m,404,'MESSAGE_NOT_FOUND'); ensure(!m.deleted,410,'MESSAGE_DELETED'); return this.publicMessage(m);
  }
  searchArchive(session: string, query: string): PublicMessage[] {
    this.session(session); ensure(query.trim().length>0&&query.length<=200,422,'INVALID_QUERY');
    const rows=[...query].length>=3?this.store.all<MessageRow>(
      'SELECT m.* FROM messages_fts f JOIN messages m ON m.id=f.message_id WHERE messages_fts MATCH ? AND m.session_id=? AND m.deleted=0 ORDER BY m.revision DESC LIMIT 50',
      '"'+query.replaceAll('"','""')+'"',session):this.store.all<MessageRow>(
      'SELECT * FROM messages WHERE session_id=? AND deleted=0 AND instr(text,?)>0 ORDER BY revision DESC LIMIT 50',session,query);
    return rows.map(m=>this.publicMessage(m));
  }
  publicAgent(a: AgentRow): PublicAgent { const c=characterOf(a); return {id:a.id,slot:a.slot,characterId:c.id,characterVersion:c.version,name:c.name,presentationRef:c.presentationRef,profileId:profileOf(a).id,enabled:!!a.enabled,status:a.state}; }
  publicSession(s: SessionRow): PublicSession { return {id:s.id,title:s.title,lifecycle:s.lifecycle,activity:s.activity,revision:s.revision,epoch:s.epoch,createdAt:s.created_at,startedAt:s.started_at,stopReason:s.stop_reason,calls:s.call_count,botMessages:s.bot_count,settings:settingsOf(s),mode:this.agents(s.id).some(a=>profileOf(a).provider!=='mock')?'live':'mock'}; }
  publicMessage(m: MessageRow): PublicMessage {
    const a=m.author_id?this.agent(m.author_id):null,c=a?characterOf(a):null;
    return {id:m.id,sessionId:m.session_id,revision:m.revision,authorId:m.author_id,authorName:c?.name??'あなた',characterId:c?.id??null,characterVersion:c?.version??null,text:m.deleted?'':m.text,act:m.act,replyTo:m.reply_to,addressedTo:JSON.parse(m.addressed_json) as string[],deleted:!!m.deleted,episode:m.episode,createdAt:m.created_at};
  }
  listSessions(): PublicSession[] { return this.store.all<SessionRow>('SELECT * FROM sessions ORDER BY created_at DESC,rowid DESC').map(s=>this.publicSession(s)); }
  private cursor(session: string, n: number): string { return session+':'+n; }
  snapshot(id: string): Snapshot {
    return this.store.tx(()=>({session:this.publicSession(this.session(id)),agents:this.agents(id).map(a=>this.publicAgent(a)),
      messages:this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? ORDER BY revision DESC LIMIT 200',id).reverse().map(m=>this.publicMessage(m)),
      cursor:this.cursor(id,this.store.get<{n:number}>('SELECT COALESCE(MAX(id),0) n FROM events WHERE session_id=?',id)!.n)}));
  }
  eventsAfter(id: string, cursor: string, limit=100): PublicEvent[] {
    this.session(id); const prefix=id+':'; ensure(cursor.startsWith(prefix),409,'RESYNC_REQUIRED');
    const value=cursor.slice(prefix.length); ensure(/^\d+$/.test(value),409,'RESYNC_REQUIRED'); const n=Number(value);
    const max=this.store.get<{n:number}>('SELECT COALESCE(MAX(id),0) n FROM events WHERE session_id=?',id)!.n;
    ensure(Number.isSafeInteger(n)&&n<=max,409,'RESYNC_REQUIRED');
    return this.store.all<{id:number;kind:string;revision:number;payload:string;created_at:number}>(
      'SELECT * FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT ?',id,n,limit).map(e=>{
      const data=JSON.parse(e.payload) as Record<string,unknown>;
      const m=typeof data.messageId==='string'?this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?',data.messageId,id):undefined;
      return {id:this.cursor(id,e.id),sessionId:id,kind:e.kind,revision:e.revision,createdAt:e.created_at,data,...m?{message:this.publicMessage(m)}:{}};
    });
  }
  diagnostics(id: string): Record<string,unknown> {
    this.session(id);
    return {agents:this.agents(id).map(a=>({id:a.id,slot:a.slot,state:a.state,processedRevision:a.processed_revision,dirtyRevision:a.dirty_revision,wakeSeq:a.wake_seq,processedWake:a.processed_wake,dueAt:a.due_at,errorCount:a.error_count,deferral:a.deferral_json?JSON.parse(a.deferral_json):null})),
      candidates:this.store.all<CandidateRow>('SELECT * FROM candidates WHERE session_id=? ORDER BY first_interested_at DESC LIMIT 30',id),
      runs:this.store.all('SELECT id,agent_id,kind,state,snapshot_revision,created_at,lease_until FROM runs WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30',id),
      traces:this.store.all('SELECT agent_id,run_id,code,detail,created_at FROM traces WHERE session_id=? ORDER BY id DESC LIMIT 150',id),metrics:this.metrics(id)};
  }
  metrics(id: string): Record<string,unknown> {
    return {calls:this.store.all('SELECT r.kind,c.stage,c.status,c.error_code,COUNT(*) count,SUM(c.input_tokens) inputTokens,SUM(c.output_tokens) outputTokens FROM llm_calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=? GROUP BY r.kind,c.stage,c.status,c.error_code',id),
      posts:this.store.all('SELECT author_id,COUNT(*) count FROM messages WHERE session_id=? AND author_id IS NOT NULL GROUP BY author_id',id),
      control:this.store.all('SELECT code,COUNT(*) count FROM traces WHERE session_id=? GROUP BY code',id)};
  }
  exportSession(id: string): Record<string,unknown> {
    const s=this.session(id); return {manifest:{schemaVersion:1,commit:process.env.GITHUB_SHA??'local',session:this.publicSession(s),sqliteVersion:this.store.sqliteVersion,
      characterHashes:this.agents(id).map(a=>({id:a.id,character:hash(characterOf(a)),profile:hash(profileOf(a))})),exportedAt:new Date(this.now()).toISOString()},
      transcript:this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? ORDER BY revision',id).map(m=>this.publicMessage(m)),metrics:this.metrics(id)};
  }
}
