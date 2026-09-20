import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { LookupSchema } from '../packages/contracts/index.js';
import { buildServer } from '../apps/core/server.js';
import { WorkerRuntime, CoreClient } from '../apps/agent-worker/runtime.js';
import { ScriptedModel } from '../packages/models/index.js';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

it('runs a bounded archive lookup through a real worker and stores retrieved originals with the run',async()=>{
  const f=fixture();cleanup.push(f.close);const first=f.say('最古の取り決めは午後四時');for(let i=0;i<240;i++)f.say('その後の会話 '+i);f.start();
  const app=buildServer(f.service,{timers:false});await app.listen({host:'127.0.0.1',port:0});cleanup.push(()=>app.close());
  const address=app.server.address();if(!address||typeof address==='string')throw new Error('port');
  const client=new CoreClient(`http://127.0.0.1:${address.port}`,f.config.workerTokens['worker-0']);
  const model=new ScriptedModel([JSON.stringify({decision:'LOOKUP',requests:[{kind:'messages',query:'最古の取り決め',cursor:null}]}),context=>{
    expect(context.retrieved?.[0].messages[0].id).toBe(first.id);expect(context.retrieved?.[0].messages[0].text).toContain('午後四時');
    return JSON.stringify({decision:'ABSTAIN',reason:'過去の原文を確認した'});
  }]);
  const worker=new WorkerRuntime(client,{},()=>model);await worker.register();await worker.once();
  expect(f.store.all('SELECT * FROM llm_calls')).toHaveLength(2);
  const row=f.store.get<{context_json:string;retrieval_count:number;state:string}>('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1')!;
  expect(row.retrieval_count).toBe(1);expect(row.state).toBe('DONE');expect(JSON.parse(row.context_json).retrieved[0].messages[0].id).toBe(first.id);
});
it('lookup cannot fetch another session or another agent memory, and retries do not consume extra rounds',()=>{
  const f=fixture();cleanup.push(f.close);const one=f.say('このセッション');const other=f.service.createSession(f.input,randomUUID()).id;
  const foreign=f.service.humanMessage(other,{text:'他セッションの秘密'},randomUUID());f.start();const r=f.claim()!;
  const call=f.service.reserveCall('worker-0',r.workerEpoch,r.id,r.token,randomUUID(),'primary');f.service.finishCall('worker-0',r.id,r.token,call.id,{inputTokens:null,outputTokens:null},null);
  const query=LookupSchema.parse({decision:'LOOKUP',requests:[{kind:'message',query:one.id}]}).requests,key=randomUUID();
  const found=f.service.retrieve('worker-0',r.workerEpoch,r.id,r.token,key,query);expect(found.retrieved?.[0].messages[0].id).toBe(one.id);
  expect(f.service.retrieve('worker-0',r.workerEpoch,r.id,r.token,key,query)).toEqual(found);
  expect(f.store.get<{retrieval_count:number}>('SELECT retrieval_count FROM runs WHERE id=?',r.id)?.retrieval_count).toBe(1);
  expect(()=>f.service.retrieve('worker-0',r.workerEpoch,r.id,r.token,randomUUID(),[{kind:'message',query:foreign.id,cursor:null}])).toThrow('MESSAGE_NOT_FOUND');
  expect(()=>f.service.retrieve('worker-1',r.workerEpoch,r.id,r.token,randomUUID(),query)).toThrow('RUN_FORBIDDEN');
});
