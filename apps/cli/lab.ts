import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { startCluster } from './cluster.js';
import { CoreClient, delay } from '../agent-worker/runtime.js';
import { SettingsSchema, type Snapshot } from '../../packages/contracts/index.js';

async function freePort():Promise<number>{const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));return port;}
const live=process.argv.includes('--live');
if(live&&process.env.ALLOW_LIVE_MODELS!=='1')throw new Error('Explicit ALLOW_LIVE_MODELS=1 is required');
if(live&&(!process.env.MODEL_PROVIDER||!process.env.MODEL_NAME||!process.env.MODEL_BASE_URL))throw new Error('MODEL_PROVIDER, MODEL_NAME and MODEL_BASE_URL are required');
const counts=live?[3]:[3,5,8];const root=await mkdtemp(join(tmpdir(),'multi-llm-lab-'));
const artifacts=resolve(process.env.ARTIFACT_DIR??'artifacts/lab');await mkdir(artifacts,{recursive:true});
const results:Record<string,unknown>[]=[];
try{
  for(const count of counts){
    const port=await freePort(),configPath=join(root,`config-${count}.json`);
    const slots=Array.from({length:count},(_,i)=>({id:`worker-${i}`,tokenEnv:`WORKER_${i}_TOKEN`}));
    await writeFile(configPath,JSON.stringify({workerSlots:slots}));
    const env:NodeJS.ProcessEnv={...process.env,APP_CONFIG:configPath,PORT:String(port),PUBLIC_ORIGIN:`http://127.0.0.1:${port}`,DB_PATH:join(root,`lab-${count}.sqlite`)};
    if(!live){delete env.MODEL_PROVIDER;delete env.MODEL_NAME;delete env.MODEL_BASE_URL;delete env.LLM_API_KEY;env.ALLOW_LIVE_MODELS='0';}
    const cluster=await startCluster(env,true),client=new CoreClient(cluster.base,cluster.token);
    try{
      const settings=SettingsSchema.parse(live?{maxDurationMs:900000,selfWakeMinMs:60000,selfWakeMaxMs:180000}:{debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0,arbitrationMs:10,postGapMs:30,agentCooldownMs:40,replyGraceMs:0,idleMs:3000,selfWakeMinMs:60000,selfWakeMaxMs:60000,maxMessages:count*2,maxCalls:3000,maxDurationMs:120000,reviewTtlMs:30000,memoryEvery:100});
      const created=await fetch(cluster.base+'/v1/sessions',{method:'POST',headers:{authorization:'Bearer '+cluster.token,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({title:`${live?'Live':'Mock'} ${count}-agent session`,participants:slots.map((s,i)=>({slot:s.id,characterId:['sora','nagi','rin'][i%3],profileId:live?'live':'mock'})),settings})});
      if(!created.ok)throw new Error('Session creation failed: '+created.status);
      const {id}=await created.json() as {id:string};
      const post=async(path:string,body:unknown)=>{
        const response=await fetch(cluster.base+path,{method:'POST',headers:{authorization:'Bearer '+cluster.token,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(body)});
        if(!response.ok)throw new Error('Lab command failed: '+response.status);return response.json();
      };
      await post(`/v1/sessions/${id}/messages`,{text:'最近気になった身近なことについて、自由に話してみてください。意見が違っても、聞いているだけでも構いません。'});
      await post(`/v1/sessions/${id}/start`,{});
      const deadline=Date.now()+settings.maxDurationMs+5000;let snapshot:Snapshot;let quietSince:number|null=null;
      for(;;){
        snapshot=await client.request<Snapshot>(`/v1/sessions/${id}/snapshot`);
        if(snapshot.session.lifecycle!=='RUNNING')break;
        if(snapshot.session.activity==='QUIET')quietSince??=Date.now();else quietSince=null;
        if(quietSince&&Date.now()-quietSince>(live?65000:4000)){await post(`/v1/sessions/${id}/pause`,{});break;}
        if(Date.now()>deadline){await post(`/v1/sessions/${id}/pause`,{});throw new Error('Lab watchdog exceeded');}
        await delay(100);
      }
      const exported=await client.request<Record<string,unknown>>(`/v1/sessions/${id}/export`);
      const diagnostic=await client.request<{metrics:Record<string,unknown>;traces:{code:string}[]}>(`/v1/sessions/${id}/diagnostics`);
      const authors=new Set(snapshot.messages.filter(m=>m.authorId).map(m=>m.authorId));
      const summary={agents:count,mode:live?'live':'mock',messages:snapshot.session.botMessages,participatingAgents:authors.size,status:snapshot.session.activity,stopReason:snapshot.session.stopReason,calls:snapshot.session.calls,metrics:diagnostic.metrics};
      results.push(summary);
      if(!live){
        if(authors.size!==count)throw new Error(`Only ${authors.size}/${count} mock agents participated`);
        if(!diagnostic.traces.some(t=>t.code.startsWith('REVIEW_')))throw new Error('Candidate review was not exercised');
        await writeFile(join(artifacts,`mock-${count}.json`),JSON.stringify(exported,null,2));
      }else if(process.env.EXPORT_LIVE_TRANSCRIPT==='1')await writeFile(join(artifacts,'live-transcript.json'),JSON.stringify(exported,null,2));
      await writeFile(join(artifacts,`${live?'live':'mock'}-${count}-metrics.json`),JSON.stringify(summary,null,2));
      console.log(JSON.stringify(summary));
    }finally{await cluster.stop();}
  }
}finally{await rm(root,{recursive:true,force:true});}
await writeFile(join(artifacts,'summary.json'),JSON.stringify(results,null,2));
