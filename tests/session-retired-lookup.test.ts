import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {saveOwnerExperience,selection,replace} from './fixtures/membership.js';
import {buildServer} from '../apps/core/server.js';

it('R7-MEMBERS-010: a reused Worker slot cannot replay a retired-owner cached LOOKUP; private audit records are retained',async()=>{
  const f=fixture(3,{memoryEvery:3}),app=buildServer(f.service,{timers:false});
  try{
    const {owner,original}=saveOwnerExperience(f);f.say('取得する原文');const run=f.claim()!;
    const call=f.service.reserveCall('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),'primary');
    f.service.finishCall('worker-0',run.id,run.token,call.id,{inputTokens:1,outputTokens:1},null);
    const key=run.id+':lookup:0',requests=[{kind:'message' as const,query:original.id,cursor:null}];
    const previous=f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,key,requests);
    expect(JSON.stringify(previous)).toContain('OWNER_PRIVATE_UNRESOLVED_KEEP');
    expect(f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,key,requests)).toEqual(previous);
    const audit=f.store.get<{context_json:string}>('SELECT context_json FROM runs WHERE id=?',run.id)!.context_json;
    f.service.lifecycle(f.id,'pause',randomUUID());const command=selection(f);command.participants[0]=replace(command.participants[0],{id:f.config.characters[1].id,version:1});
    f.service.updateMembership(f.id,command,randomUUID());
    expect(f.store.get('SELECT * FROM command_receipts WHERE scope=? AND key=?',`worker:worker-0:${run.id}:lookup`,key)).toBeUndefined();
    const response=await app.inject({method:'POST',url:`/v1/worker/runs/${run.id}/lookup`,headers:{host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.workerTokens['worker-0']},payload:{epoch:run.workerEpoch,token:run.token,requestKey:key,requests}});
    expect(response.statusCode).toBe(409);expect(response.json().code).toBe('STALE_RUN');expect(response.body).not.toContain('OWNER_PRIVATE_');
    expect(f.store.get<{context_json:string}>('SELECT context_json FROM runs WHERE id=?',run.id)!.context_json).toBe(audit);
    expect(f.store.get<{entries_json:string}>('SELECT entries_json FROM agent_private_states WHERE agent_id=?',owner)!.entries_json).toContain('OWNER_PRIVATE_UNRESOLVED_KEEP');
    expect(f.store.all('SELECT * FROM memories WHERE agent_id=?',owner)).toHaveLength(1);
  }finally{await app.close();f.close();}
});
