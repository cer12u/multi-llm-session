import {expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';
import {CoreClient,WorkerRuntime} from '../apps/agent-worker/runtime.js';
import {ModelProfileSchema} from '../packages/contracts/index.js';
import {providerScope} from '../packages/provider-state/index.js';
import {operations} from '../packages/session-service/operations.js';

async function listening(server:Server){await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('No synthetic port');return `http://127.0.0.1:${address.port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}

it.each(['rate-limit','timeout','disconnect','missing-key','bad-output'] as const)('R8-HTTP-001: %s through real Worker/Core/Provider HTTP preserves isolation and bounded accounting',async mode=>{
  const f=fixture(3,{requestTimeoutMs:1000,leaseMs:5000,selfWakeEnabled:false,idleMs:100000,memoryEvery:1000,maxRetries:1});
  const requests=new Map<string,number>();
  const provider=createServer(async(req,res)=>{
    for await(const _chunk of req){};
    const key=req.headers.authorization??'';requests.set(key,(requests.get(key)??0)+1);
    if(key==='Bearer synthetic-a'){
      if(mode==='rate-limit'){res.writeHead(429,{'content-type':'application/json','retry-after':'2'});res.end('{"error":"private-fixture-provider-detail"}');return;}
      if(mode==='timeout')return;
      if(mode==='disconnect'){req.socket.destroy();return;}
    }
    res.setHeader('content-type','application/json');
    const content=key==='Bearer synthetic-a'&&mode==='bad-output'?'not valid model JSON':JSON.stringify({decision:'ABSTAIN',reason:'independent synthetic success'});
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:13,completion_tokens:7}}));
  });
  const app=buildServer(f.service,{timers:false});
  try{
    const providerUrl=await listening(provider);f.config.allowLive=true;
    const profiles=['A','B','C'].map(letter=>ModelProfileSchema.parse({id:'http-'+letter,provider:'openai',model:'synthetic',baseUrl:providerUrl+'/v1',allowLocalHttp:true,apiKeyEnv:'SYNTHETIC_HTTP_'+letter,maxConcurrent:1,circuitCooldownMs:1000}));
    for(const p of profiles)f.service.putModelProfile(p);
    const id=f.service.createSession({...f.input,participants:f.input.participants.map((p,i)=>({...p,profileId:profiles[i].id}))},randomUUID()).id;
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const clients=f.input.participants.map(p=>new CoreClient(base,f.config.workerTokens[p.slot]));
    const workers=clients.map((client,i)=>new WorkerRuntime(client,{ALLOW_LIVE_MODELS:'1',...(i===0&&mode==='missing-key'?{}:{['SYNTHETIC_HTTP_'+['A','B','C'][i]]:'synthetic-'+['a','b','c'][i]})}));
    await Promise.all(workers.map(w=>w.register()));f.service.lifecycle(id,'start',randomUUID());
    await Promise.all(workers.map(w=>w.once()));const agents=f.service.agents(id),first=agents[0];
    const code=({'rate-limit':'RATE_LIMIT',timeout:'TIMEOUT',disconnect:'DELIVERY_UNKNOWN','missing-key':'CONFIG_ERROR','bad-output':'FORMAT_ERROR'} as const)[mode];
    expect(first.last_error).toBe(code);expect(first.error_count).toBe(1);
    expect(agents.slice(1).every(a=>a.error_count===0&&a.last_error===null)).toBe(true);
    expect(requests.get('Bearer synthetic-b')).toBe(1);expect(requests.get('Bearer synthetic-c')).toBe(1);
    expect(requests.get('Bearer synthetic-a')??0).toBe(mode==='missing-key'?0:mode==='bad-output'?2:1);
    const calls=f.store.all<{status:string;expires_at:number;stage:string;input_tokens:number|null;output_tokens:number|null}>("SELECT c.* FROM llm_calls c JOIN runs r ON r.id=c.run_id WHERE r.agent_id=? ORDER BY c.started_at,c.rowid",first.id);
    if(mode==='missing-key'){
      expect(calls).toHaveLength(0);expect(f.service.providers.status(profiles[0]).state).toBe('BLOCKED');
      expect(operations(f.service,id).agents[0].reason).toBe('CONFIG_ERROR');
    }else if(mode==='bad-output'){
      expect(calls.map(c=>c.stage)).toEqual(['primary','repair']);expect(calls.every(c=>c.input_tokens===13&&c.output_tokens===7)).toBe(true);
      expect(f.store.all('SELECT * FROM agent_input_receipts WHERE agent_id=?',first.id)).toHaveLength(0);
    }else if(mode==='rate-limit'){
      expect(f.service.providers.status(profiles[0]).retryAt).toBe(f.now()+2000);
      expect(operations(f.service,id).agents[0]).toMatchObject({reason:'RATE_LIMIT',nextOpportunityAt:first.retry_at});
    }else{
      expect(calls).toHaveLength(1);expect(calls[0].status).toBe('ABANDONED');expect(calls[0].expires_at).toBeGreaterThan(f.now());
      const active=f.store.get<{n:number}>("SELECT COUNT(*) n FROM llm_calls WHERE scope=? AND status IN ('RESERVED','ABANDONED') AND expires_at>?",providerScope(profiles[0]),f.now())!.n;
      expect(active).toBe(1);
    }
    const before={count:first.error_count,retry:first.retry_at},total=f.service.session(id).call_count;
    f.service.humanMessage(id,{text:'new public input cannot reset an outage'},randomUUID());
    f.service.injectSource(id,{title:'new source',text:'new source also cannot reset the outage'},randomUUID());
    expect(f.service.agent(first.id)).toMatchObject({error_count:before.count,retry_at:before.retry});
    expect(await workers[0].once()).toBe(false);expect(f.service.session(id).call_count).toBe(total);
    const diag=await fetch(`${base}/v1/sessions/${id}/operations`,{headers:{authorization:'Bearer '+f.config.adminToken}});expect(diag.ok).toBe(true);
    const text=await diag.text();expect(text).not.toContain('private-fixture-provider-detail');expect(text).not.toContain('Bearer synthetic-');
    expect(f.service.session(id).bot_count).toBe(0);
  }finally{await app.close();f.close();await close(provider);}
},15000);

it('R8-SCOPE-001: same credential reference shares a single probe; distinct references isolate and frozen policy conflicts are rejected',()=>{
  const f=fixture();
  try{
    const a=ModelProfileSchema.parse({id:'a',provider:'openai',model:'first',baseUrl:'https://synthetic.invalid/v1',apiKeyEnv:'KEY_A',maxConcurrent:1});
    const same={...a,id:'same',model:'different-model'},different={...a,id:'different',apiKeyEnv:'KEY_B'};
    for(const p of [a,same,different])f.service.putModelProfile(p);
    expect(providerScope(a)).toBe(providerScope(same));expect(providerScope(a)).not.toBe(providerScope(different));
    f.config.allowLive=true;const id=f.service.createSession({...f.input,participants:f.input.participants.map((p,i)=>({...p,profileId:[a,same,different][i].id}))},randomUUID()).id;
    f.service.providers.finish(a,'failed','AUTH_ERROR');f.service.retryProvider(a.id,randomUUID(),1);
    f.service.lifecycle(id,'start',randomUUID());const r0=f.claim('worker-0')!,r1=f.claim('worker-1')!,r2=f.claim('worker-2')!;
    const call=f.service.reserveCall('worker-0',r0.workerEpoch,r0.id,r0.token,randomUUID(),'primary');
    expect(()=>f.service.reserveCall('worker-1',r1.workerEpoch,r1.id,r1.token,randomUUID(),'primary')).toThrow('PROVIDER_COOLDOWN');
    expect(()=>f.service.reserveCall('worker-2',r2.workerEpoch,r2.id,r2.token,randomUUID(),'primary')).not.toThrow();
    f.service.finishCall('worker-0',r0.id,r0.token,call.id,{inputTokens:1,outputTokens:1},null);expect(f.service.providers.status(same).state).toBe('CLOSED');
    expect(()=>f.service.putModelProfile({...a,version:2,maxConcurrent:2})).toThrow();
    expect(providerScope({...a,limitGroup:'explicit-shared'})).toBe(providerScope({...different,limitGroup:'explicit-shared'}));
  }finally{f.close();}
});
