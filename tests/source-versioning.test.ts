import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {lookupSource} from '../packages/session-service/source-access.js';
import {operations} from '../packages/session-service/operations.js';
import {selection,replace} from './fixtures/membership.js';
import type {ClaimedRun,PrivateStateEntry} from '../packages/contracts/index.js';

type F=ReturnType<typeof fixture>;
function claim(f:F,slot='worker-0'){const run=f.claim(slot);expect(run).not.toBeNull();return run!;}
function recorded(f:F,run:ClaimedRun,stage:'primary'|'lookup'='primary'){
  const slot=f.service.agent(run.context.self.id).slot;
  const call=f.service.reserveCall(slot,run.workerEpoch,run.id,run.token,randomUUID(),stage);
  f.service.finishCall(slot,run.id,run.token,call.id,{inputTokens:3,outputTokens:2},null);
}
function assessed(run:ClaimedRun,entry:PrivateStateEntry){return {action:{decision:'ABSTAIN',reason:'synthetic owner interpretation'},statePatch:{
  agentId:run.context.self.id,sessionId:run.context.self.privateState!.sessionId,expectedVersion:run.context.self.privateState!.version,
  observationId:run.context.observation!.id,upsert:[entry],remove:[]}};}
function revision(f:F,id:string,changes:Record<string,unknown>){const {id:_,version,fetchedAt:__,...input}=f.service.sources.get(f.id,id);return {...input,...changes,expectedVersion:version};}
function state(f:F,owner:string):PrivateStateEntry[]{return JSON.parse(f.store.get<{entries_json:string}>('SELECT entries_json FROM agent_private_states WHERE agent_id=?',owner)!.entries_json);}

it('R6-SOURCE-001: private input for A neither reaches C nor stalls a previously eligible B candidate',()=>{
  const f=fixture(3,{selfWakeEnabled:false,memoryEvery:1000});
  try{
    f.say('public conversation');f.start();const [a,b,c]=f.service.agents(f.id);
    f.speak(claim(f,b.slot));const draft=claim(f,b.slot),wake=f.service.agent(b.id).wake_seq;
    const source=f.service.injectSource(f.id,{title:'PRIVATE_SOURCE_TITLE',text:'PRIVATE_SOURCE_BODY',audience:[a.id]},randomUUID());
    expect(f.service.agent(b.id).wake_seq).toBe(wake);expect(draft.context.sources).toEqual([]);
    f.finish(draft,{decision:'DRAFT',text:'B may still publish its public contribution'});
    expect(f.service.commitNext(f.id)?.authorId).toBe(b.id);
    const own=claim(f,a.slot),peer=claim(f,c.slot);
    expect(own.context.sources.find(s=>s.id===source.id)).toMatchObject({version:1,fetchedAt:f.now(),offset:0});
    expect(own.context.observation!.sources).toContainEqual({kind:'source',id:source.id,version:1});
    expect(JSON.stringify(peer.context)).not.toContain(source.id);expect(JSON.stringify(peer.context)).not.toContain('PRIVATE_SOURCE_');
    expect(peer.context.delivery!.entries.every(e=>e.kind==='message')).toBe(true);
    f.finish(own,{decision:'ABSTAIN',reason:'source is not an obligation to speak'});f.finish(peer,{decision:'ABSTAIN',reason:'C heard only public input'});
    expect(operations(f.service,f.id).agents.find(row=>row.agent.id===c.id)?.memoryPending).toBe(2);
    for(const projection of [f.service.snapshot(f.id),f.service.eventsAfter(f.id,f.id+':0'),f.service.exportSession(f.id)]){
      expect(JSON.stringify(projection)).not.toContain(source.id);expect(JSON.stringify(projection)).not.toContain('PRIVATE_SOURCE_');
    }
    expect(f.service.session(f.id).bot_count).toBe(1);
  }finally{f.close();}
});

it('R6-SOURCE-002: version-bound segmented LOOKUP preserves Unicode, publication time and actual original evidence',()=>{
  const f=fixture(3,{selfWakeEnabled:false,contextTokens:131072});
  try{
    const text='前'.repeat(1599)+'😀'+'中'.repeat(1000)+'原文末尾',publishedAt='2020-01-02T03:04:05Z';
    const source=f.service.injectSource(f.id,{title:'older original',text,publishedAt},randomUUID());f.start();let run=claim(f);
    const first=run.context.sources.find(s=>s.id===source.id)!;
    expect(first.text).toHaveLength(1599);expect(first.totalChars).toBe(text.length);expect(first.nextCursor).toBeTruthy();
    expect(run.context.delivery!.entries[0]).toMatchObject({kind:'source',version:1,excerpt:true});recorded(f,run);
    const looked=f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,'source-next-segment',[{kind:'source',query:source.id,cursor:first.nextCursor!}]);
    const last=looked.retrieved!.at(-1)!.sources![0];
    expect(first.text+last.text).toBe(text);expect(last).toMatchObject({version:1,offset:1599,nextCursor:null,publishedAt,fetchedAt:f.now()});
    expect(looked.observation!.sources).toEqual([{kind:'source',id:source.id,version:1}]);run={...run,context:looked};recorded(f,run,'lookup');
    const again=f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,'source-first-segment',[{kind:'source',query:source.id,cursor:null}]);
    expect(again.sources).toHaveLength(2);run={...run,context:again};recorded(f,run,'lookup');
    expect(()=>f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,'source-third-round',[{kind:'source',query:source.id,cursor:null}])).toThrow('LOOKUP_LIMIT');
    const entry:PrivateStateEntry={id:'material-interest',kind:'interest',text:'後半を実際に取得した本人の関心',resume:null,evidence:[{kind:'source',id:source.id,version:1}]};
    f.service.completeRun('worker-0',run.workerEpoch,run.id,run.token,assessed(run,entry));
    expect(state(f,run.context.self.id)[0].text).toContain('後半');expect(f.service.sources.get(f.id,source.id).text).toBe(text);
    expect(f.service.session(f.id).bot_count).toBe(0);
  }finally{f.close();}
});

it('R6-SOURCE-003: revision and audience changes revoke stale run/cache/state/agenda without deleting old originals',()=>{
  const f=fixture(3,{selfWakeEnabled:false,memoryEvery:1000});
  try{
    const [a,b]=f.service.agents(f.id),source=f.service.injectSource(f.id,{title:'private',text:'OLD_PRIVATE_ORIGINAL',audience:[a.id]},randomUUID());f.start();
    const first=claim(f);f.finish(first,assessed(first,{id:'source-belief',kind:'understanding',text:'OLD_PRIVATE_BELIEF',
      evidence:[{kind:'source',id:source.id,version:source.version}],resume:{kind:'related_topic',topic:'later',agentId:null,notBefore:null}}));
    f.say('public trigger');const run=claim(f);recorded(f,run);
    f.service.retrieve(a.slot,run.workerEpoch,run.id,run.token,'before-source-revoke',[{kind:'source',query:source.id,cursor:null}]);
    const body=revision(f,source.id,{text:'NEW_FOR_B_ONLY',audience:[b.id]}),key=randomUUID();
    expect(f.service.sources.update(f.id,source.id,body,key)).toEqual({id:source.id,version:2});
    expect(f.service.sources.update(f.id,source.id,body,key)).toEqual({id:source.id,version:2});
    expect(f.service.sources.versions(f.id,source.id)).toHaveLength(2);expect(f.service.sources.get(f.id,source.id,1).text).toBe('OLD_PRIVATE_ORIGINAL');
    expect(f.service.sources.get(f.id,source.id).fetchedAt).toBe(f.now());expect(state(f,a.id)).toEqual([]);
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',run.id)!.state).toBe('CANCELLED');
    expect(f.store.all('SELECT * FROM command_receipts WHERE scope=?',`worker:${a.slot}:${run.id}:lookup`)).toHaveLength(0);
    expect(()=>f.service.retrieve(a.slot,run.workerEpoch,run.id,run.token,'before-source-revoke',[{kind:'source',query:source.id,cursor:null}])).toThrow('STALE_RUN');
    expect(()=>f.service.completeRun(a.slot,run.workerEpoch,run.id,run.token,{decision:'ABSTAIN',reason:'old'})).toThrow('STALE_RUN');
    expect(()=>lookupSource(f.store,f.id,a.id,source.id,null)).toThrow('SOURCE_NOT_FOUND');
    const next=claim(f,b.slot);expect(next.context.sources[0].text).toBe('NEW_FOR_B_ONLY');
    expect(next.context.delivery!.entries.filter(e=>e.kind==='source').map(e=>e.eventVersion)).toEqual([2]);
    expect(JSON.stringify(next.context)).not.toContain('OLD_PRIVATE');f.finish(next,{decision:'ABSTAIN',reason:'B may ignore material'});
    expect(()=>f.service.sources.update(f.id,source.id,body,randomUUID())).toThrow('STALE_SOURCE_VERSION');
    f.service.sources.update(f.id,source.id,revision(f,source.id,{enabled:false}),randomUUID());
    expect(()=>lookupSource(f.store,f.id,b.id,source.id,null)).toThrow('SOURCE_NOT_FOUND');
    const fresh=claim(f,a.slot);expect(fresh.context.sources).toEqual([]);expect(JSON.stringify(fresh.context)).not.toContain('OLD_PRIVATE');
    f.finish(fresh,{decision:'ABSTAIN',reason:'revoked material unavailable'});
    expect(f.store.all("SELECT * FROM agent_state_updates WHERE kind='SOURCE_INVALIDATED'")).not.toHaveLength(0);
    expect(f.store.get<{status:string}>('SELECT status FROM agent_agenda WHERE agent_id=?',a.id)!.status).toBe('CANCELLED');
  }finally{f.close();}
});

it('R6-SOURCE-004: foreign/other-owner cursors and unfit LOOKUP fail atomically without invented observation',()=>{
  const f=fixture(3,{selfWakeEnabled:false,contextChars:12000,contextTokens:131072});
  try{
    const source=f.service.injectSource(f.id,{title:'segmented original',text:'x'.repeat(12000)},randomUUID());
    const foreignSession=f.service.createSession(f.input,randomUUID()).id,foreign=f.service.injectSource(foreignSession,{title:'foreign',text:'FOREIGN_SOURCE'},randomUUID());
    for(let i=0;i<10;i++)f.say('内容 '+i+' '+'x'.repeat(1800));f.start();
    const a=claim(f),b=claim(f,'worker-1');recorded(f,b);
    const before=f.store.get<{context_json:string;retrieval_count:number}>('SELECT context_json,retrieval_count FROM runs WHERE id=?',b.id);
    const lookup=(requests:{kind:'source';query:string;cursor:string|null}[])=>f.service.retrieve('worker-1',b.workerEpoch,b.id,b.token,'rejected-source-lookup',requests);
    expect(()=>lookup([{kind:'source',query:source.id,cursor:a.context.sources[0].nextCursor!}])).toThrow('SOURCE_RESYNC_REQUIRED');
    expect(()=>lookup([{kind:'source',query:foreign.id,cursor:null}])).toThrow('SOURCE_NOT_FOUND');
    expect(()=>f.service.retrieve('worker-0',b.workerEpoch,b.id,b.token,'forged-slot-lookup',[{kind:'source',query:source.id,cursor:null}])).toThrow('RUN_FORBIDDEN');
    const cursors:string[]=[];let cursor=b.context.sources[0].nextCursor!;
    for(let i=0;i<3;i++){cursors.push(cursor);cursor=lookupSource(f.store,f.id,b.context.self.id,source.id,cursor).nextCursor!;}
    expect(()=>lookup(cursors.map(cursor=>({kind:'source',query:source.id,cursor})))).toThrow('CONTEXT_LIMIT');
    expect(f.store.get('SELECT context_json,retrieval_count FROM runs WHERE id=?',b.id)).toEqual(before);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',b.id)).toHaveLength(0);
    expect(f.store.all('SELECT * FROM command_receipts WHERE key=?','rejected-source-lookup')).toHaveLength(0);
  }finally{f.close();}
});

it('R6-SOURCE-005: a replacement using the same worker slot never inherits a retired owner private source',()=>{
  const f=fixture(3,{selfWakeEnabled:false});
  try{
    const owner=f.service.agents(f.id)[0],source=f.service.injectSource(f.id,{title:'private',text:'FORMER_OWNER_SOURCE',audience:[owner.id]},randomUUID());
    const command=selection(f);command.participants[0]=replace(command.participants[0],{id:f.config.characters[1].id,version:1});
    f.service.updateMembership(f.id,command,randomUUID());const replacement=f.service.agents(f.id).find(a=>a.slot===owner.slot)!;
    expect(replacement.id).not.toBe(owner.id);
    for(const id of [owner.id,replacement.id])expect(()=>lookupSource(f.store,f.id,id,source.id,null)).toThrow('SOURCE_NOT_FOUND');
    expect(()=>f.service.sources.update(f.id,source.id,revision(f,source.id,{text:'still retired'}),randomUUID())).toThrow('SOURCE_AUDIENCE_FORBIDDEN');
    f.start();const run=claim(f,owner.slot);expect(run.context.self.id).toBe(replacement.id);expect(JSON.stringify(run.context)).not.toContain('FORMER_OWNER_SOURCE');
  }finally{f.close();}
});
