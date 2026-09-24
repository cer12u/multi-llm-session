import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {saveOwnerExperience,selection,replace} from './fixtures/membership.js';
import {characterOf,profileOf} from '../packages/storage-sqlite/index.js';

it('R7-MEMBERS-001: a replacement reuses only the Worker slot, never the retired owner state; results and commands remain fenced',()=>{
  const f=fixture(3,{memoryEvery:3,memoryFlushMs:86400000});
  try{
    const {owner,original}=saveOwnerExperience(f),beforeState=f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',owner),beforeMemory=f.store.all('SELECT * FROM memories WHERE agent_id=?',owner);
    f.say('未完了の処理を開始');const old=f.claim()!;
    const call=f.service.reserveCall('worker-0',old.workerEpoch,old.id,old.token,randomUUID(),'primary');
    const peer=f.claim('worker-1')!;f.speak(peer);
    f.service.lifecycle(f.id,'pause',randomUUID());
    const command=selection(f),previousIds=command.participants.map(p=>p.agentId),key=randomUUID();
    command.participants[0]=replace(command.participants[0],{id:f.config.characters[1].id,version:1});
    const result=f.service.updateMembership(f.id,command,key),added=result.current.find(row=>row.agent.slot==='worker-0')!.agent.id;
    expect(added).not.toBe(owner);expect(result.archived.map(row=>row.agent.id)).toEqual([owner]);
    expect(f.service.agent(owner)).toMatchObject({enabled:0,retired_at:f.now(),state:'retired'});
    expect(f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',owner)).toEqual(beforeState);
    expect(f.store.all('SELECT * FROM memories WHERE agent_id=?',owner)).toEqual(beforeMemory);
    expect(result.current.filter(row=>row.agent.slot!=='worker-0').map(row=>row.agent.id)).toEqual(previousIds.slice(1));
    expect(f.store.all("SELECT * FROM candidates WHERE state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')")).toEqual([]);
    expect(f.store.get<{status:string}>('SELECT status FROM llm_calls WHERE id=?',call.id)!.status).toBe('ABANDONED');
    expect(()=>f.service.completeRun('worker-0',old.workerEpoch,old.id,old.token,{decision:'ABSTAIN',reason:'late'})).toThrow('STALE_RUN');
    expect(()=>f.service.workerMemories('worker-0',owner)).toThrow('PRIVATE_STATE_FORBIDDEN');
    expect(()=>f.service.retryAgent(f.id,owner,randomUUID())).toThrow('AGENT_RETIRED');
    expect(()=>f.service.setAgentEnabled(f.id,owner,true,randomUUID())).toThrow('AGENT_RETIRED');
    expect(f.service.updateMembership(f.id,command,key)).toEqual(result);
    expect(f.service.membership(f.id).archived).toHaveLength(1);
    expect(()=>f.service.updateMembership(f.id,command,randomUUID())).toThrow('MEMBERSHIP_CHANGED_RELOAD');
    const modified=structuredClone(command);modified.participants[0].enabled=false;
    expect(()=>f.service.updateMembership(f.id,modified,key)).toThrow('IDEMPOTENCY_CONFLICT');
    f.service.finishCall('worker-0',old.id,old.token,call.id,{inputTokens:12,outputTokens:4},null);
    f.service.lifecycle(f.id,'resume',randomUUID());const next=f.claim()!;
    expect(next.context.self.id).toBe(added);expect(next.context.self.privateState).toMatchObject({version:0,entries:[]});
    expect(next.context.messages.some(m=>m.id===original.id)).toBe(true);
    expect(JSON.stringify(next.context)).not.toContain('OWNER_PRIVATE_');
    expect(f.service.session(f.id).bot_count).toBe(0);expect(f.store.db.pragma('foreign_key_check')).toEqual([]);
  }finally{f.close();}
});

it.each([3,5,8])('R7-MEMBERS-002: %i participant version apply preserves identity, memory and published author metadata',count=>{
  const f=fixture(count,{memoryEvery:3,memoryFlushMs:86400000});
  try{
    const {owner}=saveOwnerExperience(f);f.say('発言してから人格の版を適用');f.speak(f.claim()!);
    const draft=f.claim()!;expect(draft.kind).toBe('draft');f.finish(draft,{decision:'DRAFT',text:'旧版の人格で投稿した原文'});
    const published=f.service.commitNext(f.id)!;expect(published.authorId).toBe(owner);expect(published.characterVersion).toBe(1);
    const prior=f.service.agent(owner),v2={...characterOf(prior),version:2,name:'明示適用した新しい表示名',persona:'新しい人格の合成定義'};
    const p2={...profileOf(prior),version:2,model:'new-synthetic-model'};f.service.putCharacter(v2);f.service.putModelProfile(p2);
    expect(characterOf(f.service.agent(owner)).version).toBe(1);
    f.service.lifecycle(f.id,'pause',randomUUID());
    const state=f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',owner),memory=f.store.all('SELECT * FROM memories WHERE agent_id=?',owner),cursor=f.store.get('SELECT * FROM agent_input_cursors WHERE agent_id=?',owner);
    const input=selection(f);input.participants[0].character.version=2;input.participants[0].profile.version=2;
    const applied=f.service.updateMembership(f.id,input,randomUUID());expect(applied.current).toHaveLength(count);expect(applied.archived).toEqual([]);
    expect(applied.current[0].agent).toMatchObject({id:owner,name:v2.name,characterVersion:2});
    expect(f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',owner)).toEqual(state);
    expect(f.store.all('SELECT * FROM memories WHERE agent_id=?',owner)).toEqual(memory);
    expect(f.store.get('SELECT * FROM agent_input_cursors WHERE agent_id=?',owner)).toEqual(cursor);
    expect(f.service.archiveMessage(f.id,published.id)).toEqual(published);
    expect(f.service.searchArchive(f.id,'旧版')[0]).toEqual(published);
    expect(f.service.eventsAfter(f.id,f.id+':0').find(e=>e.message?.id===published.id)?.message).toEqual(published);
    f.service.lifecycle(f.id,'resume',randomUUID());const next=f.claim()!;
    expect(next.profile).toEqual(p2);expect(next.context.self.character).toEqual(v2);
    expect(JSON.stringify(next.context.self.privateState)).toContain('OWNER_PRIVATE_UNRESOLVED_KEEP');
    expect(next.context.participants).toHaveLength(count);expect(f.service.membership(f.id).counts).toMatchObject({current:count,enabled:count,online:count});
  }finally{f.close();}
});

it('R7-MEMBERS-003: invalid membership is atomic; counts report disabled/offline/error without pretending three are active',()=>{
  const f=fixture();
  try{
    const other=f.service.createSession(f.input,randomUUID()).id,valid=selection(f),before=f.service.membership(f.id);
    const invalid=[
      {...valid,participants:valid.participants.slice(1)},
      {...valid,participants:[valid.participants[0],valid.participants[0],valid.participants[2]]},
      {...valid,participants:valid.participants.map((p,i)=>i===0?{...p,agentId:f.service.agents(other)[0].id}:p)},
      {...valid,participants:valid.participants.map((p,i)=>i===0?{...p,character:valid.participants[1].character}:p)},
      {...valid,participants:valid.participants.map((p,i)=>i===0?{...p,profile:{id:'mock',version:99}}:p)},
      {...valid,participants:valid.participants.map((p,i)=>i===0?{...p,slot:'unknown-worker'}:p)},
      {...valid,expectedEpoch:valid.expectedEpoch+1},
    ];
    for(const value of invalid){expect(()=>f.service.updateMembership(f.id,value,randomUUID())).toThrow();expect(f.service.membership(f.id)).toEqual(before);expect(f.store.all('SELECT * FROM session_member_changes')).toEqual([]);}
    expect(f.service.updateMembership(f.id,valid,randomUUID())).toEqual(before);expect(f.service.session(f.id).epoch).toBe(valid.expectedEpoch);
    f.start();expect(()=>f.service.updateMembership(f.id,selection(f),randomUUID())).toThrow('PAUSE_REQUIRED');f.service.lifecycle(f.id,'pause',randomUUID());
    const changed=selection(f);changed.participants[0].enabled=false;f.service.updateMembership(f.id,changed,randomUUID());
    f.store.run('UPDATE workers SET last_seen_at=NULL WHERE slot=?','worker-1');
    const last=f.service.agents(f.id)[2];f.store.run("UPDATE agent_instances SET error_count=1,last_error='AUTH_ERROR' WHERE id=?",last.id);
    expect(f.service.membership(f.id).counts).toEqual({current:3,enabled:2,online:1,disabled:1,offline:1,errors:1});
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});

it('R7-MEMBERS-004: episode ranges and explicit definition-only cloning retain originals, not private experience',()=>{
  const f=fixture(3,{memoryEvery:3,memoryFlushMs:86400000,selfWakeEnabled:false});
  try{
    const {owner,original}=saveOwnerExperience(f);const old=characterOf(f.service.agent(owner));
    f.service.putCharacter({...old,version:2,name:'catalog only'});
    f.service.lifecycle(f.id,'pause',randomUUID());const state=f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',owner),calls=f.service.session(f.id).call_count;
    f.advance(10000);const next=f.say('長い休止後の次のエピソード');
    expect(next.episode).toBe(2);const episode=f.service.episodes(f.id);
    expect(episode[0]).toMatchObject({number:1,startedAt:1000000,firstSequence:1,lastSequence:3,closedAt:f.now(),endSequence:3});
    expect(episode[1]).toMatchObject({number:2,startedAt:f.now(),firstSequence:4,lastSequence:4,closedAt:null});
    f.service.renewBudget(f.id,randomUUID());expect(f.service.session(f.id).call_count).toBe(calls);
    expect(f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',owner)).toEqual(state);
    f.service.lifecycle(f.id,'resume',randomUUID());expect(f.claim()!.context.self.privateState!.entries[0].text).toBe('OWNER_PRIVATE_UNRESOLVED_KEEP');
    f.service.lifecycle(f.id,'end',randomUUID());expect(f.service.episodes(f.id)[1].closedAt).toBe(f.now());
    const ended=f.service.session(f.id),copy={title:'定義のみの新しい部屋',copy:'definitions-only'},key=randomUUID();
    const cloned=f.service.cloneSession(f.id,copy,key);expect(f.service.cloneSession(f.id,copy,key)).toEqual(cloned);
    expect(f.service.session(f.id)).toEqual(ended);expect(f.service.archiveMessage(f.id,original.id).text).toBe(original.text);
    expect(f.service.snapshot(cloned.id).messages).toEqual([]);expect(f.service.session(cloned.id)).toMatchObject({lifecycle:'DRAFT',call_count:0,bot_count:0});
    const agents=f.service.agents(cloned.id);expect(agents.every(a=>!f.service.agents(f.id).some(old=>old.id===a.id))).toBe(true);
    expect(characterOf(agents[0]).version).toBe(1);
    for(const a of agents){expect(f.store.all('SELECT * FROM memories WHERE agent_id=?',a.id)).toEqual([]);expect(f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',a.id)).toBeUndefined();expect(f.store.all('SELECT * FROM agent_agenda WHERE agent_id=?',a.id)).toEqual([]);}
    expect(()=>f.service.cloneSession(f.id,{title:'wrong scope',copy:'all'},randomUUID())).toThrow();
    expect(()=>f.service.updateMembership(f.id,selection(f),randomUUID())).toThrow('SESSION_ENDED');
    expect(()=>f.say('終了後の投稿')).toThrow('SESSION_ENDED');
    expect(()=>f.service.changeMessage(f.id,original.id,null,randomUUID())).toThrow('SESSION_ENDED');
    expect(f.service.snapshot(f.id).messages).toHaveLength(4);
  }finally{f.close();}
});
