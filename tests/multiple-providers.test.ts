import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {ModelProfileSchema, type ModelProfile} from '../packages/contracts/index.js';
import {buildServer} from '../apps/core/server.js';
import {CoreClient,WorkerRuntime} from '../apps/agent-worker/runtime.js';

it('routes three workers through three actual local HTTP endpoints with separate keys, model IDs and personas (no real LLM)',async()=>{
  const f=fixture(),servers:ReturnType<typeof createServer>[]=[],received:{model:string;authorization:string|undefined;system:string;path:string|undefined}[]=[];
  const app=buildServer(f.service,{timers:false});
  try{
    const profiles:ModelProfile[]=[];
    for(let i=0;i<3;i++){
      const server=createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=String(chunk);const body=JSON.parse(raw);
        received.push({model:body.model,authorization:req.headers.authorization,system:body.messages[0].content,path:req.url});
        const content=JSON.stringify({decision:'ABSTAIN',reason:'実HTTP配送だけの合成試験'});
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(i===0?{message:{content}}:{choices:[{message:{content}}]}));
      });
      servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('port');
      profiles.push(ModelProfileSchema.parse({id:'provider-'+i,provider:i===0?'ollama':'openai',model:'synthetic-'+i,baseUrl:`http://127.0.0.1:${address.port}/${i===0?'api':'v1'}`,apiKeyEnv:'SYNTHETIC_KEY_'+i,allowLocalHttp:true}));
    }
    for(const p of profiles)f.service.putModelProfile(p);f.config.allowLive=true;
    const id=f.service.createSession({...f.input,participants:f.input.participants.map((p,i)=>({...p,profileId:profiles[i].id}))},randomUUID()).id;
    await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();if(!address||typeof address==='string')throw new Error('port');
    const workers=profiles.map((p,i)=>new WorkerRuntime(new CoreClient(`http://127.0.0.1:${address.port}`,f.config.workerTokens['worker-'+i]),{ALLOW_LIVE_MODELS:'1',[p.apiKeyEnv!]:'synthetic-key-'+i}));
    await Promise.all(workers.map(w=>w.register()));f.service.lifecycle(id,'start',randomUUID());await Promise.all(workers.map(w=>w.once()));
    expect(received).toHaveLength(3);
    for(let i=0;i<3;i++){
      const call=received.find(x=>x.model==='synthetic-'+i)!;expect(call.authorization).toBe('Bearer synthetic-key-'+i);
      expect(call.path).toBe(i===0?'/api/chat':'/v1/chat/completions');expect(call.system).toContain(f.config.characters[i].persona);
    }
    expect(f.service.session(id).call_count).toBe(3);expect(f.service.agents(id).every(a=>a.error_count===0)).toBe(true);
  }finally{await app.close();for(const server of servers){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}f.close();}
},20000);
