import { randomUUID } from 'node:crypto';
import { MembershipUpdateSchema, SessionCloneSchema } from '../contracts/session-membership.js';
import { applyMembership, cloneDefinitions, closeEpisode, episodes as sessionEpisodes, membershipReport, publishedAuthor } from './membership.js';
import { AgentAgenda } from './agenda.js';
import { MemoryLedger, memoryNote, memoriesCurrent, currentMemoryPredicate, type MemoryRow } from './memory-ledger.js';
import { boundedContext } from '../models/context-budget.js';
import { AgentInputs } from './inputs.js';
import { PrivateStates } from './private-state.js';
import { questionHints } from './questions.js';
import { requireReviewReconstruction } from './candidate-integrity.js';
import { ArchivePages } from './pages.js';
import { ProviderState, providerScope } from '../provider-state/index.js';
import { validateProfileUrl } from '../config/credentials.js';
import { EventEmitter } from 'node:events';
import {
  AppError, ensure, CharacterSchema, SessionCreateSchema, MessageInputSchema, SettingsSchema,
  ModelProfileSchema, LookupSchema, type ModelProfile, type LookupRequest, type RetrievalResult,
  OutputSchemas, ObserveSchema, DecisionSchema, DraftSchema, ReviewSchema, MemorySchema, SourceSchema,
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
  readonly pages: ArchivePages;
  readonly providers: ProviderState;
  private readonly privateStates: PrivateStates;
  private readonly inputs: AgentInputs;
  private readonly agenda: AgentAgenda;
  private readonly memoryLedger: MemoryLedger;
  constructor(readonly store: Store, readonly config: Config, readonly now: () => number = Date.now,
    readonly random: () => number = Math.random) {
    this.pages = new ArchivePages(store, row => this.publicMessage(row));
    this.providers = new ProviderState(store, now);
    this.privateStates = new PrivateStates(store, now);
    this.inputs = new AgentInputs(store, now, row => this.publicMessage(row));
    this.agenda = new AgentAgenda(store, now);
    this.memoryLedger = new MemoryLedger(store, now);
    this.changes.setMaxListeners(100);
    store.tx(() => {
      for (const slot of Object.keys(config.workerTokens)) store.run('INSERT OR IGNORE INTO workers(slot) VALUES(?)', slot);
      for (const character of config.characters) this.putCharacter(character);
      for (const profile of config.profiles) this.putModelProfile(profile);
    });
  }
  private write<T>(fn: () => T): T { const result = this.store.tx(fn); this.changes.emit('changed'); return result; }
  session(id: string): SessionRow { const s = this.store.get<SessionRow>('SELECT * FROM sessions WHERE id=?', id); ensure(s,404,'SESSION_NOT_FOUND'); return s; }
  agent(id: string): AgentRow { const a = this.store.get<AgentRow>('SELECT * FROM agent_instances WHERE id=?',id); ensure(a,404,'AGENT_NOT_FOUND'); return a; }
  agents(id: string): AgentRow[] { return this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE session_id=? AND retired_at IS NULL ORDER BY rowid',id); }
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
  modelProfiles(): ModelProfile[] {
    return this.store.all<{definition:string}>('SELECT p.definition FROM model_profiles p WHERE p.version=(SELECT MAX(q.version) FROM model_profiles q WHERE q.id=p.id) ORDER BY p.id').map(p=>ModelProfileSchema.parse(JSON.parse(p.definition)));
  }
  putModelProfile(input:unknown):ModelProfile {
    const p=ModelProfileSchema.parse(input); validateProfileUrl(p);
    return this.store.tx(()=>{
      const old=this.store.get<{hash:string}>('SELECT hash FROM model_profiles WHERE id=? AND version=?',p.id,p.version);
      if(old) ensure(old.hash===hash(p),409,'PROFILE_VERSION_IMMUTABLE');
      else {
        const policy=(x:ModelProfile)=>JSON.stringify([x.maxConcurrent,x.failureThreshold,x.circuitCooldownMs]);
        for(const other of this.modelProfiles().filter(x=>x.id!==p.id)) ensure(providerScope(other)!==providerScope(p)||policy(other)===policy(p),422,'CONFLICTING_PROVIDER_POLICY');
        for(const agent of this.store.all<AgentRow>("SELECT a.* FROM agent_instances a JOIN sessions s ON s.id=a.session_id WHERE s.lifecycle!='ENDED' AND a.retired_at IS NULL")) {
          const frozen=profileOf(agent);
          ensure(providerScope(frozen)!==providerScope(p)||policy(frozen)===policy(p),422,'ACTIVE_PROVIDER_POLICY_CONFLICT');
        }
        this.store.run('INSERT INTO model_profiles(id,version,definition,hash) VALUES(?,?,?,?)',p.id,p.version,JSON.stringify(p),hash(p));
      }
      return p;
    });
  }
  providerDiagnostics() { return this.modelProfiles().map(profile=>({profile,health:this.providers.status(profile)})); }
  retryProvider(profileId:string,key:string,version?:number) {
    return this.receipt('operator:provider',key,{profileId,...version===undefined?{}:{version}},()=>{
      const row=version===undefined?undefined:this.store.get<{definition:string}>('SELECT definition FROM model_profiles WHERE id=? AND version=?',profileId,version);
      const p=version===undefined?this.modelProfiles().find(x=>x.id===profileId):row?ModelProfileSchema.parse(JSON.parse(row.definition)):undefined;
      ensure(p,404,'PROFILE_NOT_FOUND');
      this.providers.requestProbe(p);
      for(const a of this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE retired_at IS NULL')) if(this.session(a.session_id).lifecycle!=='ENDED'&&providerScope(profileOf(a))===providerScope(p)) {
        this.cancelRuns(a.session_id,'PROVIDER_RETRY',a.slot);
        this.store.run('UPDATE agent_instances SET error_count=0,retry_at=NULL,last_error=NULL WHERE id=?',a.id);
        this.wake(a.id,'RECOVERY'); this.trace(a.session_id,a.id,null,'PROVIDER_PROBE_REQUESTED');
      }
      return this.providers.status(p);
    });
  }
  retryAgent(session:string,agentId:string,key:string) {
    return this.receipt(`operator:${session}:agent-retry`,key,{agentId},()=>{
      const a=this.agent(agentId); ensure(a.session_id===session,403,'AGENT_SESSION_MISMATCH');
      ensure(this.session(session).lifecycle!=='ENDED',409,'SESSION_ENDED');
      ensure(a.retired_at===null,409,'AGENT_RETIRED');
      this.cancelRuns(session,'AGENT_RETRY',a.slot);
      this.store.run("UPDATE agent_instances SET error_count=0,retry_at=NULL,last_error=NULL,state='listening' WHERE id=?",agentId);
      this.wake(agentId,'RECOVERY'); this.trace(session,agentId,null,'MANUAL_AGENT_RETRY'); return {ok:true};
    });
  }
  private activeElapsed(s:SessionRow):number { return s.active_elapsed_ms+(s.active_since!==null?Math.max(0,this.now()-s.active_since):0); }
  private stopClock(id:string):void {
    const s=this.session(id); this.store.run('UPDATE sessions SET active_elapsed_ms=?,active_since=NULL WHERE id=?',this.activeElapsed(s),id);
  }
  renewBudget(id:string,key:string):PublicSession {
    return this.receipt(`operator:${id}:budget`,key,{},()=>{
      const s=this.session(id); ensure(s.lifecycle==='DRAFT'||s.lifecycle==='PAUSED',409,'PAUSE_REQUIRED');
      this.stopClock(id);
      this.store.run("UPDATE sessions SET active_elapsed_ms=0,window_call_start=call_count,window_post_start=bot_count,stop_reason=NULL,activity='QUIET',epoch=epoch+1 WHERE id=?",id);
      this.cancelRuns(id,'BUDGET_RENEWED'); this.emit(id,'budget.renewed',{}); return this.publicSession(this.session(id));
    });
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
        const profile=this.modelProfiles().find(m=>m.id===p.profileId);
        ensure(profile,422,'UNKNOWN_MODEL_PROFILE'); ensure(profile.provider==='mock'||this.config.allowLive,403,'LIVE_DISABLED');
        ensure(this.config.workerTokens[p.slot],422,'UNKNOWN_WORKER_SLOT');
      }
      this.store.run('INSERT INTO sessions(id,title,created_at,last_activity_at,settings_json,lifecycle) VALUES(?,?,?,?,?,?)',id,data.title,now,now,JSON.stringify(data.settings),'DRAFT');
      for(const p of data.participants) {
        this.store.run('INSERT INTO agent_instances(id,session_id,slot,character_json,profile_json,next_self_at) VALUES(?,?,?,?,?,?)',
          randomUUID(),id,p.slot,JSON.stringify(definitions.find(c=>c.id===p.characterId)),JSON.stringify(this.modelProfiles().find(m=>m.id===p.profileId)),this.selfWake(data.settings));
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
    this.stopClock(id);
    this.store.run("UPDATE sessions SET lifecycle='PAUSED',activity='BUDGET_PAUSED',stop_reason=?,epoch=epoch+1 WHERE id=?",reason,id);
    this.cancelRuns(id,'BUDGET_CANCELLED');
    this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE session_id=? AND state='READY'",id);
    this.store.run("UPDATE agent_instances SET state='paused' WHERE session_id=? AND retired_at IS NULL",id);
    this.emit(id,'budget.paused',{reason});
  }
  private timeExceeded(s: SessionRow): boolean { return this.activeElapsed(s)>=settingsOf(s).maxDurationMs; }
  lifecycle(id: string, action: 'start'|'pause'|'resume'|'end', key: string): PublicSession {
    this.session(id);
    return this.receipt(`operator:${id}:lifecycle`,key,{action},()=>{
      const s=this.session(id);
      const allowed={start:['DRAFT'],pause:['RUNNING'],resume:['PAUSED'],end:['DRAFT','RUNNING','PAUSED']};
      ensure(allowed[action].includes(s.lifecycle),409,'INVALID_LIFECYCLE');
      if(action==='start'||action==='resume') {
        const st=settingsOf(s);
        ensure(s.call_count-s.window_call_start<st.maxCalls&&s.bot_count-s.window_post_start<st.maxMessages&&!this.timeExceeded(s),409,'LIMIT_ALREADY_REACHED');
        const count=this.store.get<{n:number}>("SELECT COUNT(*) n FROM sessions WHERE lifecycle='RUNNING' AND id<>?",id)!.n;
        ensure(count<this.config.maxRunning,409,'RUNNING_SESSION_LIMIT');
        this.store.run("UPDATE sessions SET lifecycle='RUNNING',activity='ACTIVE',stop_reason=NULL,epoch=epoch+1,started_at=COALESCE(started_at,?),active_since=? WHERE id=?",this.now(),this.now(),id);
      } else {
        this.stopClock(id);
        this.store.run('UPDATE sessions SET lifecycle=?,epoch=epoch+1,stop_reason=? WHERE id=?',action==='end'?'ENDED':'PAUSED',action==='end'?'ENDED':'USER_PAUSED',id);
      }
      this.cancelRuns(id,'LIFECYCLE_CHANGED');
      this.store.run("UPDATE candidates SET state=? WHERE session_id=? AND state='READY'",action==='end'?'DROPPED':'NEEDS_REVIEW',id);
      if(action==='end') { this.agenda.endSession(id); closeEpisode(this.store,id,this.now()); }
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
      ensure(a.retired_at===null,409,'AGENT_RETIRED');
      this.cancelRuns(session,'MEMBERSHIP_CHANGED');
      this.store.run('UPDATE sessions SET epoch=epoch+1 WHERE id=?',session);
      this.store.run('UPDATE agent_instances SET enabled=?,state=? WHERE id=?',enabled?1:0,enabled?'listening':'disabled',agentId);
      this.store.run("UPDATE candidates SET state='DROPPED',reason='MEMBERSHIP_CHANGED' WHERE agent_id=? AND state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')",agentId);
      this.emit(session,'session.membership',{agentId,enabled}); return {ok:true};
    });
  }
  membership(id: string) { return this.store.tx(()=>membershipReport(this,id)); }
  episodes(id: string) { return this.store.tx(()=>sessionEpisodes(this.store,id)); }
  updateMembership(id: string, input: unknown, key: string) {
    const data=MembershipUpdateSchema.parse(input);
    return this.receipt(`operator:${id}:participants`,key,data,()=>{
      const changes=applyMembership(this,id,data,settings=>this.selfWake(settings));
      if(changes.changed) {
        this.cancelRuns(id,'MEMBERSHIP_RECONCILED');
        this.store.run("UPDATE candidates SET state='DROPPED',reason='MEMBERSHIP_RECONCILED' WHERE session_id=? AND state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')",id);
        this.emit(id,'session.membership',changes); this.trace(id,null,null,'MEMBERSHIP_RECONCILED',changes);
      }
      return membershipReport(this,id);
    });
  }
  cloneSession(id: string, input: unknown, key: string): {id:string;copy:'definitions-only'} {
    const data=SessionCloneSchema.parse(input);
    return this.receipt(`operator:${id}:clone`,key,data,()=>{
      const result=cloneDefinitions(this,id,data.title,settings=>this.selfWake(settings));
      this.emit(result.id,'session.created',{copiedFrom:id,copy:result.copy});
      return result;
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
          this.stopClock(s.id);
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
      (deferral.kind==='answer_from'&&isMessage&&author===deferral.agentId)||trigger==='RECOVERY'||trigger==='AGENDA')) {
      deferral=null;
      this.store.run('UPDATE agent_instances SET deferral_json=NULL,pending_since=NULL,due_at=NULL WHERE id=?',a.id);
      const c=this.candidate(a.id);
      if(c?.state==='DEFERRED') this.store.run('UPDATE candidates SET state=?,defer_json=NULL WHERE id=?',c.text?'NEEDS_REVIEW':'DRAFTING',c.id);
      a=this.agent(agentId);
    }
    const pending=a.wake_seq>a.processed_wake;
    const due=coalesceDue(pending?a.pending_since:null,pending?a.due_at:null,this.now(),trigger==='DIRECTED'?st.directedDebounceMs:st.debounceMs,st.maxCoalesceMs);
    this.store.run('UPDATE agent_instances SET dirty_revision=?,wake_seq=wake_seq+1,pending_since=?,due_at=?,trigger=? WHERE id=?',
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
    const sequence=this.store.get<{message_seq:number}>('SELECT message_seq FROM sessions WHERE id=?',session)!.message_seq+1;
    const threadRoot=intent.replyTo?this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',intent.replyTo)!.thread_root:id;
    this.store.run('UPDATE sessions SET message_seq=? WHERE id=?',sequence,session);
    this.store.run('UPDATE sessions SET revision=?,last_activity_at=?,last_post_at=?,episode=?,activity=? WHERE id=?',revision,now,now,episode,'ACTIVE',session);
    this.store.run('INSERT INTO messages(id,session_id,revision,author_id,text,act,reply_to,addressed_json,candidate_id,episode,created_at,sequence,thread_root) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,session,revision,author,text,intent.act,intent.replyTo,JSON.stringify(intent.addressedTo),candidateId,episode,now,sequence,threadRoot);
    this.store.run('INSERT INTO messages_fts(message_id,session_id,text) VALUES(?,?,?)',id,session,text);
    if(intent.act==='question') for(const target of intent.addressedTo.length?intent.addressedTo:['*']) this.store.run('INSERT INTO pending_questions(message_id,target) VALUES(?,?)',id,target);
    // A reply/answer declaration is not proof of semantic resolution. Each Agent records its own assessment.
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
      return this.append(session,null,data.text,{act:data.act??'comment',intent:'Human contribution',replyTo:data.replyTo,addressedTo:data.addressedTo},null);
    });
  }
  changeMessage(session: string, messageId: string, text: string|null, key: string): PublicMessage {
    if(text!==null) text=MessageInputSchema.parse({text}).text;
    return this.receipt(`operator:${session}:edit`,key,{messageId,text},()=>{
      const s=this.session(session),m=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=?',messageId);
      ensure(s.lifecycle!=='ENDED',409,'SESSION_ENDED'); ensure(m&&m.session_id===session&&!m.deleted,404,'MESSAGE_NOT_FOUND');
      ensure(text===null||m.author_id===null,403,'BOT_TEXT_IMMUTABLE');
      this.store.run('UPDATE sessions SET revision=revision+1,edit_generation=edit_generation+1 WHERE id=?',session);
      this.store.run('UPDATE messages SET text=?,deleted=?,revision=? WHERE id=?',text??'',text===null?1:0,s.revision+1,messageId);
      this.store.run("UPDATE agent_input_log SET created_at=? WHERE session_id=? AND kind='message' AND entity_id=? AND version=?",this.now(),session,messageId,s.revision+1);
      this.privateStates.invalidateMessage(session,messageId);
      this.store.run('DELETE FROM messages_fts WHERE message_id=?',messageId);
      this.privateStates.invalidateMemories(session,this.memoryLedger.invalidateMessage(session,messageId));
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
      this.store.run('UPDATE workers SET epoch=epoch+1,last_seen_at=? WHERE slot=?',this.now(),slot);
      for(const a of this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE slot=? AND retired_at IS NULL',slot)) {
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
  private context(agent: AgentRow, candidate?: CandidateRow, kind: RunKind='decide'): Context {
    const s=this.session(agent.session_id),st=settingsOf(s);
    let rows=this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? ORDER BY sequence DESC LIMIT ?',s.id,st.contextMessages).reverse();
    let chars=rows.reduce((n,m)=>n+m.text.length,0);
    while(rows.length>1&&chars>st.contextChars/2) { chars-=rows[0].text.length; rows.shift(); }
    const messages=rows.map(m=>this.publicMessage(m));
    const memories=this.pages.memories(agent.id,'',{limit:12}).items.reverse();
    const questions=questionHints(this.store,agent,this.privateStates.read(agent.id,s.id));
    const sources=this.store.all<{id:string;title:string;text:string;url:string|null;published_at:string|null;fetched_at:number}>(
      'SELECT * FROM source_items WHERE session_id=? ORDER BY fetched_at DESC,rowid DESC LIMIT 4',s.id)
      .map(x=>({id:x.id,title:x.title,text:x.text.slice(0,1600),url:x.url,publishedAt:x.published_at,fetchedAt:x.fetched_at}));
    const changed=candidate?this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND revision>? ORDER BY revision LIMIT 101',s.id,candidate.reviewed_revision):[];
    const delta:PublicMessage[]=[]; let size=0;
    for(const row of changed) {
      const m=this.publicMessage(row),cost=JSON.stringify(m).length;
      if(delta.length&&(delta.length>=100||size+cost>st.contextChars/3)) break;
      delta.push(m);size+=cost;
    }
    const complete=delta.length===changed.length;
    const through=candidate?(complete?s.revision:delta.at(-1)!.revision):s.revision;
    const coverage=candidate?{fromRevision:candidate.reviewed_revision,throughRevision:through,targetRevision:s.revision,complete}:undefined;
    const selected=this.privateStates.prepare(agent,{self:{id:agent.id,character:characterOf(agent)},participants:this.agents(s.id).filter(a=>a.enabled).map(a=>this.publicAgent(a)),
      revision:s.revision,trigger:agent.trigger,messages,delta,...coverage?{coverage}:{},historyTruncated:rows.length>0&&rows[0].revision>1,
      agenda:this.agenda.view(agent.id,st,Math.max(0,st.maxDurationMs-this.activeElapsed(s))),
      memories,questions,sources,candidate:candidate?{id:candidate.id,version:candidate.version,intent:intentOf(candidate),text:candidate.text,reviewedRevision:candidate.reviewed_revision}:null});
    return this.privateStates.prepare(agent,this.inputs.context(agent,selected,kind,st));
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
      this.store.run('UPDATE workers SET last_seen_at=? WHERE slot=?',this.now(),slot);
      const old=this.store.get<RunRow>("SELECT * FROM runs WHERE slot=? AND state='ACTIVE'",slot);
      if(old) {
        if(this.inputs.reusable(old)&&this.agenda.reusable(old)) return this.claimed(old);
        this.cancelRuns(old.session_id,'INPUT_INVALIDATED',slot);
        this.wake(old.agent_id,'INPUT_CHANGED');
      }
      for(const a of this.store.all<AgentRow>("SELECT a.* FROM agent_instances a JOIN sessions s ON s.id=a.session_id WHERE a.slot=? AND a.enabled=1 AND s.lifecycle='RUNNING' ORDER BY a.rowid",slot)) {
        const s=this.session(a.session_id),st=settingsOf(s),c=this.candidate(a.id);
        if(!this.providers.mayClaim(profileOf(a),a.error_count,st.maxRetries)||(a.retry_at!==null&&a.retry_at>this.now())) continue;
        const pendingInput=this.inputs.progress(a.id,s.id).observationPending>0;
        const holding=!!a.deferral_json||this.now()<a.last_post_at+st.agentCooldownMs;
        let kind: RunKind|undefined;
        if(pendingInput&&holding) kind='observe';
        else if(!holding&&(a.due_at===null||a.due_at<=this.now())) {
          if(c?.state==='DRAFTING') kind='draft';
          else if(c?.state==='NEEDS_REVIEW') kind=c.text?'review':'draft';
          else if(!c&&a.wake_seq>a.processed_wake) kind='decide';
          else if(pendingInput) kind='observe';
        }
        if(this.inputs.memoryTurn(a,st)||(!kind&&this.inputs.memoryDue(a,st))) kind='memory';
        if(!kind) continue;
        let context:Context;
        try {
          context=this.context(a,kind==='memory'||kind==='observe'?undefined:c,kind);
          if(kind==='decide'&&!context.delivery!.complete) { kind='observe';context=this.context(a,undefined,kind); }
        } catch(error) {
          if(!(error instanceof AppError)||error.code!=='CONTEXT_LIMIT') throw error;
          this.store.run("UPDATE agent_instances SET state='error',last_error='CONTEXT_LIMIT',error_count=?,retry_at=NULL WHERE id=?",st.maxRetries+1,a.id);
          this.trace(s.id,a.id,null,'INPUT_CONTEXT_LIMIT');this.emit(s.id,'agent.status',{agentId:a.id,status:'error',code:'CONTEXT_LIMIT'});continue;
        }
        const id=randomUUID(),token=randomUUID();
        const runCandidate=kind==='memory'||kind==='observe'?undefined:c;
        this.store.run('INSERT INTO runs(id,agent_id,session_id,slot,worker_epoch,session_epoch,kind,token,state,snapshot_revision,wake_seq,candidate_id,candidate_version,created_at,lease_until,context_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id,a.id,s.id,slot,epoch,s.epoch,kind,token,'ACTIVE',context.coverage?.throughRevision??s.revision,a.wake_seq,runCandidate?.id??null,runCandidate?.version??null,this.now(),this.now()+st.leaseMs,JSON.stringify(context));
        this.store.run('UPDATE agent_instances SET state=? WHERE id=?',kind==='review'?'reviewing':kind==='memory'?'remembering':kind==='observe'?'observing':'thinking',a.id);
        this.trace(s.id,a.id,id,'RUN_STARTED',{kind,revision:s.revision}); this.emit(s.id,'agent.status',{agentId:a.id,status:kind==='review'?'reviewing':'thinking'});
        return this.claimed(this.store.get<RunRow>('SELECT * FROM runs WHERE id=?',id)!);
      }
      return null;
    });
  }
  heartbeat(slot: string, epoch: number, id: string, token: string): {ok:true} {
    return this.write(()=>{ const r=this.validRun(slot,epoch,id,token); this.store.run('UPDATE workers SET last_seen_at=? WHERE slot=?',this.now(),slot); this.store.run('UPDATE runs SET lease_until=? WHERE id=?',this.now()+settingsOf(this.session(r.session_id)).leaseMs,id); return {ok:true}; });
  }
  reserveCall(slot: string, epoch: number, id: string, token: string, requestKey: string, stage: 'primary'|'repair'|'lookup'): {id:string} {
    const result=this.write(()=>{
      const r=this.validRun(slot,epoch,id,token),s=this.session(r.session_id),p=profileOf(this.agent(r.agent_id)),st=settingsOf(s);
      const old=this.store.get<CallRow>('SELECT * FROM llm_calls WHERE run_id=? AND request_key=?',id,requestKey);
      if(old) { ensure(old.stage===stage,409,'IDEMPOTENCY_CONFLICT'); return {id:old.id}; }
      if(this.timeExceeded(s)||s.call_count-s.window_call_start>=st.maxCalls) { this.pauseForLimit(s.id,this.timeExceeded(s)?'MAX_DURATION':'MAX_CALLS'); return {blocked:true}; }
      const previous=this.store.all<CallRow>('SELECT * FROM llm_calls WHERE run_id=?',id);
      ensure(previous.length<4,409,'CALL_ATTEMPT_LIMIT');
      ensure(stage==='primary'?previous.length===0:stage==='repair'?!previous.some(c=>c.stage==='repair')&&previous.some(c=>c.status==='FINISHED'&&!c.error_code):r.retrieval_count>previous.filter(c=>c.stage==='lookup').length&&r.retrieval_count<=2,409,'INVALID_CALL_STAGE');
      ensure(!previous.some(c=>['RESERVED','ABANDONED'].includes(c.status)&&c.expires_at>this.now()),429,'RUN_BUSY');
      const scope=providerScope(p),callId=randomUUID();
      this.providers.reserve(p,callId,this.now()+st.requestTimeoutMs+10000,Math.min(p.maxConcurrent,this.config.maxConcurrentProvider));
      this.store.run('INSERT INTO llm_calls(id,run_id,request_key,scope,stage,status,started_at,expires_at,context_hash) VALUES(?,?,?,?,?,?,?,?,?)',callId,id,requestKey,scope,stage,'RESERVED',this.now(),this.now()+st.requestTimeoutMs+10000,hash(r.context_json));
      this.store.run('UPDATE sessions SET call_count=call_count+1 WHERE id=?',s.id);
      this.trace(s.id,r.agent_id,r.id,'CALL_RESERVED',{kind:r.kind,stage,provider:p.provider}); return {id:callId};
    });
    if('blocked' in result) throw new AppError(409,'BUDGET_STOPPED'); return result;
  }
  finishCall(slot: string, id: string, token: string, callId: string, usage: Usage, error: ModelErrorCode|null, retryAfterMs=0): {ok:true} {
    return this.write(()=>{
      const r=this.ownRun(slot,id,token),c=this.store.get<CallRow>('SELECT * FROM llm_calls WHERE id=?',callId);
      ensure(c&&c.run_id===r.id,403,'CALL_FORBIDDEN'); const digest=hash({usage,error,retryAfterMs});
      if(c.result_hash) { ensure(c.result_hash===digest,409,'IDEMPOTENCY_CONFLICT'); return {ok:true}; }
      this.store.run('UPDATE llm_calls SET status=?,finished_at=?,input_tokens=?,output_tokens=?,error_code=?,result_hash=? WHERE id=?',
        error==='TIMEOUT'||error==='CANCELLED'||error==='DELIVERY_UNKNOWN'?'ABANDONED':'FINISHED',this.now(),usage.inputTokens,usage.outputTokens,error,digest,callId);
      // Meter late replies, but a fenced request cannot mutate the new circuit generation.
      if(r.state==='ACTIVE') this.providers.finish(profileOf(this.agent(r.agent_id)),callId,error,retryAfterMs);
      return {ok:true};
    });
  }
  retrieve(slot:string,epoch:number,id:string,token:string,key:string,requests:LookupRequest[]):Context {
    const parsed=LookupSchema.parse({decision:'LOOKUP',requests});
    return this.receipt(`worker:${slot}:${id}:lookup`,key,parsed,()=>{
      const r=this.validRun(slot,epoch,id,token); ensure(r.retrieval_count<2&&r.kind!=='memory',409,'LOOKUP_LIMIT');
      ensure(this.store.get('SELECT id FROM llm_calls WHERE run_id=? AND status=\'FINISHED\' AND error_code IS NULL',id),409,'MODEL_CALL_NOT_RECORDED');
      const results:RetrievalResult[]=parsed.requests.map(request=>{
        if(request.kind==='message') return {request,messages:[this.archiveMessage(r.session_id,request.query)],memories:[],nextCursor:null};
        if(request.kind==='memories') {
          const page=this.pages.memories(r.agent_id,request.query,{limit:2,cursor:request.cursor});
          const sources=[...new Set(page.items.flatMap(x=>x.sourceMessageIds))];
          return {request,memories:page.items,messages:sources.map(x=>this.archiveMessage(r.session_id,x)),nextCursor:page.nextCursor};
        }
        const page=this.pages.search(r.session_id,request.query,{limit:2,cursor:request.cursor});
        return {request,messages:page.items,memories:[],nextCursor:page.nextCursor};
      });
      let context=JSON.parse(r.context_json) as Context;
      ensure(context.self.privateState?.version===this.privateStates.read(r.agent_id,r.session_id).version,409,'STALE_PRIVATE_STATE');
      context.retrieved=[...(context.retrieved??[]),...results];
      ensure(JSON.stringify(context.retrieved).length<=settingsOf(this.session(r.session_id)).contextChars,422,'LOOKUP_CONTEXT_LIMIT');
      const owner=this.agent(r.agent_id);
      context=this.privateStates.prepare(owner,boundedContext(context,r.kind,profileOf(owner),settingsOf(this.session(r.session_id))));
      this.store.run('UPDATE runs SET context_json=?,retrieval_count=retrieval_count+1 WHERE id=?',JSON.stringify(context),id);
      this.trace(r.session_id,r.agent_id,id,'ARCHIVE_RETRIEVED',{requests:requests.length}); return context;
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
    const action='action' in parsed?parsed.action:parsed;
    const statePatch='statePatch' in parsed?parsed.statePatch:undefined;
    return this.write(()=>{
      const existing=this.ownRun(slot,id,token);
      if(existing.state==='DONE') { ensure(existing.result_hash===digest,409,'IDEMPOTENCY_CONFLICT'); return {ok:true}; }
      const r=this.validRun(slot,epoch,id,token),s=this.session(r.session_id),st=settingsOf(s),a=this.agent(r.agent_id);
      ensure(this.store.get<{n:number}>("SELECT COUNT(*) n FROM llm_calls WHERE run_id=? AND status='FINISHED' AND error_code IS NULL AND context_hash=?",id,hash(r.context_json))!.n>0,409,'MODEL_CALL_NOT_RECORDED');
      const c=r.candidate_id?this.store.get<CandidateRow>('SELECT * FROM candidates WHERE id=?',r.candidate_id):undefined;
      if(r.candidate_id) ensure(c&&c.version===r.candidate_version&&c.agent_id===r.agent_id&&!['COMMITTED','DROPPED'].includes(c.state),409,'STALE_CANDIDATE');
      const delivery=(JSON.parse(r.context_json) as Context).delivery!;
      const ready=r.snapshot_revision===s.revision&&r.wake_seq===a.wake_seq&&delivery.complete&&delivery.targetInput===this.inputs.high(s.id);
      const notBefore=Math.max(this.now()+st.arbitrationMs+Math.floor(this.random()*Math.min(500,st.arbitrationMs)),a.last_post_at+st.agentCooldownMs);
      if(r.kind==='observe') {
        ObserveSchema.parse(action);this.trace(s.id,a.id,id,'OBSERVED_WITHOUT_PUBLICATION');
      } else if(r.kind==='decide') {
        const result=DecisionSchema.parse(action);
        if(result.decision==='SPEAK') {
          this.validateIntent(s.id,a.id,result.intent);
          ensure(!this.candidate(a.id),409,'CANDIDATE_ALREADY_EXISTS');
          this.store.run('INSERT INTO candidates(id,agent_id,session_id,state,intent_json,reviewed_revision,reviewed_wake,first_interested_at,not_before,review_due_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            randomUUID(),a.id,s.id,'DRAFTING',JSON.stringify(result.intent),r.snapshot_revision,r.wake_seq,this.now(),notBefore,this.now()+st.reviewTtlMs);
        } else if(result.decision==='DEFER') this.defer(a.id,result.defer);
        this.trace(s.id,a.id,id,result.decision);
      } else if(r.kind==='draft') {
        const result=DraftSchema.parse(action); ensure(c,409,'CANDIDATE_MISSING');
        if(result.decision==='DROP') this.store.run("UPDATE candidates SET state='DROPPED',reason='MODEL_DROP' WHERE id=?",c.id);
        else this.store.run('UPDATE candidates SET text=?,version=version+1,state=?,reviewed_revision=?,reviewed_wake=?,not_before=?,review_due_at=? WHERE id=?',
          result.text,ready?'READY':'NEEDS_REVIEW',r.snapshot_revision,r.wake_seq,notBefore,this.now()+st.reviewTtlMs,c.id);
        this.trace(s.id,a.id,id,result.decision,{stale:!ready});
      } else if(r.kind==='review') {
        const result=ReviewSchema.parse(action); ensure(c,409,'CANDIDATE_MISSING');
        requireReviewReconstruction(JSON.parse(r.context_json) as Context,result.decision);
        if(result.decision==='DROP') this.store.run("UPDATE candidates SET state='DROPPED',reason='MODEL_DROP' WHERE id=?",c.id);
        else if(result.decision==='DEFER') this.defer(a.id,result.defer);
        else {
          if(result.decision==='REWRITE') this.validateIntent(s.id,a.id,result.intent);
          this.store.run('UPDATE candidates SET text=?,intent_json=?,version=version+1,state=?,reviewed_revision=?,reviewed_wake=?,not_before=?,review_due_at=? WHERE id=?',
            result.decision==='REWRITE'?result.text:c.text,result.decision==='REWRITE'?JSON.stringify(result.intent):c.intent_json,
            ready?'READY':'NEEDS_REVIEW',r.snapshot_revision,r.wake_seq,notBefore,this.now()+st.reviewTtlMs,c.id);
        }
        this.trace(s.id,a.id,id,'REVIEW_'+result.decision,{from:c.reviewed_revision,to:r.snapshot_revision,stale:!ready});
      } else MemorySchema.parse(action);
      ensure(memoriesCurrent(this.store,r),409,'STALE_MEMORY_EVIDENCE');
      const stateResult=this.privateStates.complete(r,statePatch);
      if(r.kind==='memory'){
        const result=MemorySchema.parse(action);
        const invalidated=this.memoryLedger.save(r,result);
        this.privateStates.invalidateMemories(s.id,invalidated);
        const finalVersion=this.privateStates.read(a.id,s.id).version;
        stateResult.changed ||= finalVersion!==stateResult.version;stateResult.version=finalVersion;
        const supplied=(JSON.parse(r.context_json) as Context).messages;
        this.store.run('UPDATE agent_instances SET memory_revision=MAX(memory_revision,?) WHERE id=?',Math.max(0,...supplied.map(m=>m.revision)),a.id);
        if(result.notes.length||(result.changes?.length??0)>0)this.store.run("UPDATE candidates SET state='NEEDS_REVIEW',reason='MEMORY_CHANGED' WHERE agent_id=? AND state='READY'",a.id);
        this.trace(s.id,a.id,id,'MEMORY_SAVED',{notes:result.notes.length,changes:result.changes?.length??0,invalidated:invalidated.length});
      }
      this.trace(s.id,a.id,id,'PRIVATE_STATE_APPLIED',stateResult);
      this.inputs.complete(r);
      this.agenda.complete(r);
      this.agenda.sync(a,this.privateStates.read(a.id,s.id),st,delivery.throughInput);
      const active=this.candidate(a.id);
      if(active&&['decide','draft','review'].includes(r.kind)) this.inputs.bindCandidate(active.id,stateResult.version);
      else if(active?.state==='READY'&&stateResult.changed) this.store.run("UPDATE candidates SET state='NEEDS_REVIEW',reason='PRIVATE_STATE_CHANGED' WHERE agent_id=? AND state='READY'",a.id);
      this.store.run("UPDATE runs SET state='DONE',result_hash=?,result_json=? WHERE id=?",digest,JSON.stringify({ok:true}),id);
      if(r.kind!=='memory'&&r.kind!=='observe') this.store.run('UPDATE agent_instances SET processed_revision=MAX(processed_revision,?),processed_wake=MAX(processed_wake,?) WHERE id=?',r.snapshot_revision,delivery.complete?r.wake_seq:a.processed_wake,a.id);
      const next=this.agent(a.id),cand=this.candidate(a.id);
      const status=next.deferral_json||cand?'waiting':'listening';
      const due=next.deferral_json?next.due_at:cand&&cand.state!=='READY'?this.now():next.wake_seq>next.processed_wake?(next.due_at??this.now()):null;
      this.store.run('UPDATE agent_instances SET error_count=0,retry_at=NULL,last_error=NULL,state=?,due_at=?,pending_since=CASE WHEN wake_seq<=processed_wake THEN NULL ELSE pending_since END WHERE id=?',status,due,a.id);
      this.emit(s.id,'agent.status',{agentId:a.id,status}); return {ok:true};
    });
  }
  failRun(slot: string, epoch: number, id: string, token: string, code: ModelErrorCode): {ok:true} {
    return this.write(()=>{
      const previous=this.ownRun(slot,id,token); if(previous.state==='FAILED') return {ok:true};
      const r=this.validRun(slot,epoch,id,token),a=this.agent(r.agent_id),st=settingsOf(this.session(r.session_id));
      // An external input/state invalidation is not a provider failure or a successful observation.
      if(!this.inputs.reusable(r)||!this.agenda.reusable(r)) {
        this.cancelRuns(r.session_id,'INPUT_INVALIDATED',slot);
        this.wake(a.id,'INPUT_CHANGED');
        return {ok:true};
      }
      this.store.run("UPDATE runs SET state='FAILED',result_json=? WHERE id=?",JSON.stringify({code}),id);
      this.store.run("UPDATE llm_calls SET status='ABANDONED' WHERE run_id=? AND status='RESERVED'",id);
      if(code==='CONFIG_ERROR')this.providers.finish(profileOf(a),id,code);
      const count=a.error_count+1;
      this.store.run('UPDATE agent_instances SET error_count=?,state=?,retry_at=?,last_error=?,wake_seq=wake_seq+1 WHERE id=?',count,count>st.maxRetries?'error':'retrying',Math.max(this.now()+retryDelay(count),this.providers.status(profileOf(a)).retryAt??0),code,a.id);
      this.store.run("UPDATE sessions SET activity='DEGRADED' WHERE id=?",r.session_id);
      this.trace(r.session_id,a.id,id,code,{retry:count<=st.maxRetries}); this.emit(r.session_id,'agent.status',{agentId:a.id,status:'error',code}); return {ok:true};
    });
  }
  private commitOne(id: string): PublicMessage|null {
    let s=this.session(id); if(s.lifecycle!=='RUNNING') return null;
    const st=settingsOf(s);
    if(this.timeExceeded(s)) { this.pauseForLimit(id,'MAX_DURATION'); return null; }
    if(s.bot_count-s.window_post_start>=st.maxMessages) { this.pauseForLimit(id,'MAX_MESSAGES'); return null; }
    if(this.now()<s.last_post_at+st.postGapMs) return null;
    const latest=this.store.get<MessageRow>('SELECT * FROM messages WHERE session_id=? AND deleted=0 ORDER BY sequence DESC LIMIT 1',id);
    const targets=latest?JSON.parse(latest.addressed_json) as string[]:[];
    const all=this.store.all<CandidateRow>("SELECT * FROM candidates WHERE session_id=? AND state='READY'",id);
    const eligible=all.map(c=>{ const a=this.agent(c.agent_id); return {
      id:c.id,agentId:a.id,state:a.enabled?c.state:'DISABLED',reviewedRevision:c.reviewed_revision,reviewedWake:c.reviewed_wake,
      currentWake:a.wake_seq,firstInterestedAt:c.first_interested_at,notBefore:c.not_before,directed:targets.includes(a.id),
    }; });
    const selected=selectCandidate(eligible,s.revision,this.now(),st.agingMs,targets,latest?latest.created_at+st.replyGraceMs:0);
    if(!selected) return null;
    const c=all.find(c=>c.id===selected.id)!;
    if(c.review_due_at<=this.now()||!this.inputs.candidateCurrent(c.id,c.agent_id)) { this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE id=?",c.id); return null; }
    ensure(c.text,409,'EMPTY_CANDIDATE');
    try { this.validateIntent(id,c.agent_id,intentOf(c)); }
    catch(e) { if(!(e instanceof AppError)) throw e; this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE id=?",c.id); this.trace(id,c.agent_id,null,'REFERENCE_REVIEW_REQUIRED'); return null; }
    const message=this.append(id,c.agent_id,c.text,intentOf(c),c.id);
    this.store.run("UPDATE candidates SET state='COMMITTED' WHERE id=?",c.id);
    this.store.run('UPDATE sessions SET bot_count=bot_count+1 WHERE id=?',id);
    this.store.run("UPDATE agent_instances SET state='listening' WHERE id=?",c.agent_id);
    this.trace(id,c.agent_id,null,'COMMITTED',{candidateId:c.id,version:c.version,revision:message.revision,waitMs:this.now()-c.first_interested_at});
    s=this.session(id); if(s.bot_count-s.window_post_start>=st.maxMessages) this.pauseForLimit(id,'MAX_MESSAGES');
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
        for(let a of this.agents(s.id)) {
          if(!a.enabled) continue;
          const st=settingsOf(s);
          this.agenda.sync(a,this.privateStates.read(a.id,s.id),st,this.inputs.high(s.id));
          if(s.call_count-s.window_call_start<st.maxCalls&&s.bot_count-s.window_post_start<st.maxMessages&&
            this.providers.mayClaim(profileOf(a),a.error_count,st.maxRetries)&&
            (a.retry_at===null||a.retry_at<=this.now())&&this.agenda.dispatch(a,st)) {
            this.wake(a.id,'AGENDA');
            this.store.run('UPDATE agent_instances SET next_self_at=? WHERE id=?',this.selfWake(st),a.id);
            this.trace(s.id,a.id,null,'AGENDA_WAKE');
            a=this.agent(a.id);
          }
          const c=this.candidate(a.id);
          if(a.deferral_json&&(JSON.parse(a.deferral_json) as StoredDeferral).until<=this.now()) this.wake(a.id,'DEFER_DUE');
          if(c?.state==='READY'&&(c.review_due_at<=this.now()||c.reviewed_revision!==s.revision||c.reviewed_wake!==a.wake_seq)) {
            this.store.run("UPDATE candidates SET state='NEEDS_REVIEW' WHERE id=?",c.id);
          }
          const busy=!!c||!!this.store.get("SELECT id FROM runs WHERE agent_id=? AND state='ACTIVE'",a.id);
          if(!busy&&!a.deferral_json&&a.wake_seq===a.processed_wake&&a.error_count===0) {
            if(this.now()-s.last_activity_at>=st.idleMs&&a.idle_checked<s.revision) {
              this.store.run('UPDATE agent_instances SET idle_checked=? WHERE id=?',s.revision,a.id); this.wake(a.id,'IDLE');
            } else if(st.selfWakeEnabled&&this.now()>=a.next_self_at) {
              this.store.run('UPDATE agent_instances SET next_self_at=? WHERE id=?',this.selfWake(st),a.id); this.wake(a.id,'SELF_WAKE');
            }
          }
        }
        this.commitOne(s.id); s=this.session(s.id); if(s.lifecycle!=='RUNNING') continue;
        const agents=this.agents(s.id).filter(a=>a.enabled);
        const busy=agents.some(a=>(!a.deferral_json&&a.wake_seq>a.processed_wake&&a.error_count<=settingsOf(s).maxRetries)||this.inputs.progress(a.id,s.id).observationPending>0||this.inputs.memoryDue(a,settingsOf(s))||!!this.candidate(a.id))||
          !!this.store.get("SELECT id FROM runs WHERE session_id=? AND state='ACTIVE'",s.id);
        const activity=agents.some(a=>a.error_count>0||!this.publicAgent(a).workerOnline)?'DEGRADED':busy?'ACTIVE':'QUIET';
        if(activity!==s.activity) { this.store.run('UPDATE sessions SET activity=?,stop_reason=stop_reason WHERE id=?',activity,s.id); this.emit(s.id,'session.activity',{activity}); }
      }
    });
  }
  workerMemories(slot: string, agentId: string) {
    const a=this.agent(agentId); ensure(a.slot===slot&&a.retired_at===null,403,'PRIVATE_STATE_FORBIDDEN');
    return this.store.all<MemoryRow>(`SELECT m.* FROM memories m WHERE m.agent_id=? AND ${currentMemoryPredicate()} ORDER BY m.created_at,m.rowid`,agentId)
      .map(m=>memoryNote(this.store,m));
  }
  archiveMessage(session: string, id: string): PublicMessage {
    this.session(session);
    const m=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?',id,session);
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
  publicAgent(a: AgentRow): PublicAgent {
    const c=characterOf(a),last=this.store.get<{last_seen_at:number|null}>('SELECT last_seen_at FROM workers WHERE slot=?',a.slot)?.last_seen_at??null;
    return {id:a.id,slot:a.slot,characterId:c.id,characterVersion:c.version,name:c.name,presentationRef:c.presentationRef,profileId:profileOf(a).id,enabled:!!a.enabled,status:a.state,
      workerOnline:a.retired_at===null&&last!==null&&this.now()-last<=Math.max(15000,settingsOf(this.session(a.session_id)).leaseMs),lastSeenAt:last,nextRetryAt:a.retry_at};
  }
  publicSession(s: SessionRow): PublicSession { return {id:s.id,title:s.title,lifecycle:s.lifecycle,activity:s.activity,revision:s.revision,epoch:s.epoch,createdAt:s.created_at,startedAt:s.started_at,stopReason:s.stop_reason,calls:s.call_count,botMessages:s.bot_count,
    budget:{callsUsed:s.call_count-s.window_call_start,messagesUsed:s.bot_count-s.window_post_start,activeMs:this.activeElapsed(s)},settings:settingsOf(s),mode:this.agents(s.id).some(a=>profileOf(a).provider!=='mock')?'live':'mock'}; }
  publicMessage(m: MessageRow): PublicMessage {
    const author=publishedAuthor(this.store,m);
    return {id:m.id,sessionId:m.session_id,sequence:m.sequence,threadRootId:m.thread_root,revision:m.revision,authorId:m.author_id,...author,text:m.deleted?'':m.text,act:m.act,replyTo:m.reply_to,addressedTo:JSON.parse(m.addressed_json) as string[],deleted:!!m.deleted,episode:m.episode,createdAt:m.created_at};
  }
  listSessions(): PublicSession[] { return this.store.all<SessionRow>('SELECT * FROM sessions ORDER BY created_at DESC,rowid DESC').map(s=>this.publicSession(s)); }
  private cursor(session: string, n: number): string { return session+':'+n; }
  snapshot(id: string): Snapshot {
    return this.store.tx(()=>({session:this.publicSession(this.session(id)),agents:this.agents(id).map(a=>this.publicAgent(a)),
      messages:this.pages.history(id,{limit:200}).items,historyCursor:this.pages.history(id,{limit:200}).nextCursor,
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
    return {providers:this.providerDiagnostics(),agents:this.agents(id).map(a=>({id:a.id,slot:a.slot,state:a.state,workerOnline:this.publicAgent(a).workerOnline,nextRetryAt:a.retry_at,lastError:a.last_error,processedRevision:a.processed_revision,dirtyRevision:a.dirty_revision,wakeSeq:a.wake_seq,processedWake:a.processed_wake,dueAt:a.due_at,errorCount:a.error_count,inputProgress:this.inputs.progress(a.id,id),agenda:this.agenda.view(a.id,settingsOf(this.session(id)),Math.max(0,settingsOf(this.session(id)).maxDurationMs-this.activeElapsed(this.session(id)))),deferral:a.deferral_json?JSON.parse(a.deferral_json):null})),
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
      transcript:this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? ORDER BY sequence',id).map(m=>this.publicMessage(m)),metrics:this.metrics(id)};
  }
}
