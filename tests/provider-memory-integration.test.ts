import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';
import {CoreClient,WorkerRuntime} from '../apps/agent-worker/runtime.js';
import {ModelProfileSchema,type Context,type MemoryMeaning,type ClaimedRun} from '../packages/contracts/index.js';
import {estimatedRequestTokens,modelRequest} from '../packages/models/index.js';

type RequestBody=Record<string,unknown>&{messages:{role:string;content:string}[]};
it.each(['none','schema'] as const)('R8-MEMORY-001: %s actual Worker HTTP retains old owner evidence, declared parameters and the shared request budget',async jsonMode=>{
  const f=fixture(3,{memoryEvery:1000,memoryFlushMs:86400000,selfWakeEnabled:false,contextTokens:131072});
  const app=buildServer(f.service,{timers:false});let captured:RequestBody|undefined,authorization='';
  const provider=createServer(async(req,res)=>{
    try{
      let text='';for await(const chunk of req){text+=String(chunk);if(text.length>1048576)throw new Error('SYNTHETIC_TOO_LARGE');}
      captured=JSON.parse(text);authorization=req.headers.authorization??'';
      const action={decision:'ABSTAIN',reason:'synthetic transport proof only'};
      res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(jsonMode==='schema'?{result:action}:action)}}],usage:{prompt_tokens:33,completion_tokens:9}}));
    }catch{res.statusCode=500;res.end('{}');}
  });
  try{
    await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const remote=provider.address();if(!remote||typeof remote==='string')throw new Error('No synthetic Provider port');
    const profile=ModelProfileSchema.parse({id:'memory-integrated',provider:'openai',model:'synthetic-memory-model',baseUrl:`http://127.0.0.1:${remote.port}/v1`,allowLocalHttp:true,apiKeyEnv:'SYNTHETIC_MEMORY_KEY',contextWindowTokens:131072,jsonMode,
      capabilities:{jsonModes:[jsonMode],outputTokenParameter:'max_completion_tokens',temperatureSupported:false,usage:'reported'}});
    f.config.allowLive=true;f.service.putModelProfile(profile);
    const id=f.service.createSession({...f.input,participants:f.input.participants.map(p=>({...p,profileId:profile.id}))},randomUUID()).id;
    const source=f.service.humanMessage(id,{text:'対話の約束の時刻は午後四時'},randomUUID());
    for(let i=0;i<245;i++)f.service.humanMessage(id,{text:'無関係な日々の挨拶 '+i},randomUUID());
    const [owner,peer]=f.service.agents(id),ownMemory=randomUUID(),peerMemory=randomUUID();
    const meaning:MemoryMeaning={subjectId:null,topic:'連絡',key:'appointment.time',value:'16:00',epistemic:'self_report',validFrom:null,validTo:null,aliases:['アポイントメント']};
    // Seed established semantic memory independently; its production write/attribution contract is tested in R5-MEANING.
    f.store.tx(()=>{
      for(const [agent,memory,text] of [[owner.id,ownMemory,'保存された本人用の連絡事項'],[peer.id,peerMemory,'PEER_PRIVATE_MUST_NEVER_REACH_OWNER']] as const){
        f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',memory,agent,text,JSON.stringify([source.id]),f.now(),1);
        f.store.run('INSERT INTO memory_metadata(memory_id,status,meaning_json,evidence_json) VALUES(?,?,?,?)',memory,'ACTIVE',JSON.stringify(meaning),JSON.stringify([{kind:'message',id:source.id,version:source.revision}]));
        f.store.run('UPDATE agent_instances SET memory_seq=1 WHERE id=?',agent);
      }
    });
    f.service.lifecycle(id,'start',randomUUID());
    for(let i=0;i<100;i++){
      const run=f.claim();if(!run)break;
      expect(['observe','decide','memory']).toContain(run.kind);
      f.finish(run,run.kind==='memory'?{notes:[]}:{decision:'ABSTAIN',reason:'synthetic chronological catch-up'});
      if(i===99)throw new Error('Synthetic catch-up did not finish');
    }
    const query=f.service.humanMessage(id,{text:'アポイントメントを確認したい'},randomUUID());
    expect(f.service.snapshot(id).messages.some(m=>m.id===source.id)).toBe(false);
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No synthetic Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const client=new CoreClient(base,f.config.workerTokens[owner.slot]);
    const worker=new WorkerRuntime(client,{ALLOW_LIVE_MODELS:'1',SYNTHETIC_MEMORY_KEY:'synthetic-credential-not-for-production'});
    await worker.register();const count=f.service.session(id).call_count;
    expect(await worker.once()).toBe(true);expect(captured).toBeDefined();
    expect(authorization).toBe('Bearer synthetic-credential-not-for-production');
    expect(captured).toHaveProperty('max_completion_tokens',profile.maxOutputTokens);
    expect(captured).not.toHaveProperty('max_tokens');expect(captured).not.toHaveProperty('temperature');
    const supplied=JSON.parse(captured!.messages.find(m=>m.role==='user')!.content) as Context;
    expect(supplied.self.id).toBe(owner.id);expect(supplied.messages.some(m=>m.id===query.id)).toBe(true);
    expect(supplied.memories.some(m=>m.id===ownMemory)).toBe(true);
    expect(JSON.stringify(supplied)).not.toContain('PEER_PRIVATE_MUST_NEVER_REACH_OWNER');
    expect(supplied.retrieved!.flatMap(r=>r.messages).find(m=>m.id===source.id)).toMatchObject({revision:source.revision,text:source.text,deleted:false});
    expect(supplied.observation!.messages).toContainEqual({kind:'message',id:source.id,version:source.revision});
    const stored=f.store.get<{kind:ClaimedRun['kind'];context_json:string;state:string}>('SELECT kind,context_json,state FROM runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 1',owner.id)!;
    expect(stored.state).toBe('DONE');expect(JSON.parse(stored.context_json)).toEqual(supplied);
    expect(captured).toEqual(modelRequest(profile,stored.kind,supplied,{maxChars:f.config.defaults.contextChars}));
    expect(estimatedRequestTokens(captured!)+profile.maxOutputTokens).toBeLessThanOrEqual(supplied.inputBudget!.maxTokens);
    expect(supplied.inputBudget!.maxTokens).toBe(131072);expect(f.service.session(id).call_count).toBe(count+1);
    expect(f.service.session(id).bot_count).toBe(0);
  }finally{await app.close();f.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));}
},15000);
