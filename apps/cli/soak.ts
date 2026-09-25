import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync,readdirSync,readlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startCluster} from './cluster.js';
import {ReplayStream} from '../../packages/observability/replay.js';
import type {Context,Intent,Snapshot,PublicMessage,Page} from '../../packages/contracts/index.js';
import type {SessionService} from '../../packages/session-service/index.js';

type Usage=ReturnType<SessionService['budgetReport']>;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const seconds=Number(process.argv[2]??600),reportPath=resolve(process.argv[3]??'artifacts/operational-soak.json');
assert(Number.isSafeInteger(seconds)&&seconds>=60&&seconds<=21600,'SOAK_DURATION_MUST_BE_60_TO_21600_SECONDS');
const root=mkdtempSync(join(tmpdir(),'mls-operational-soak-')),dbPath=join(root,'session.sqlite');
// Declared before execution; the report names the actual duration, never claims a 24-hour run.
const limits={durationSeconds:seconds,initialOriginals:240,inputIntervalMs:5000,maxRssKiB:524288,maxSocketsPerProcess:128,maxDatabaseBytes:536870912,maxRestartMs:20000,drainDeadlineMs:60000,maxRequests:10000};
let injected=false,faults=0,requests=0,providerFailure:string|null=null;
const ownerRequests=new Map<string,number>();
const provider=createServer((req,res)=>{void (async()=>{
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;assert(bytes<=1048576,'SOAK_REQUEST_TOO_LARGE');chunks.push(b);}
  const request=JSON.parse(Buffer.concat(chunks).toString()),system=String(request.messages[0].content),context:Context=JSON.parse(request.messages.find((m:{role:string})=>m.role==='user').content);
  const index=Number(String(request.model).split('-').at(-1));assert(index>=0&&index<3,'SOAK_MODEL_ID');
  assert.equal(req.headers.authorization,'Bearer synthetic-soak-key-'+index,'SOAK_CREDENTIAL_ROUTING');
  requests++;assert(requests<=limits.maxRequests,'SOAK_REQUEST_CAP');ownerRequests.set(context.self.id,(ownerRequests.get(context.self.id)??0)+1);
  await sleep(index===2?100:20);
  if(injected&&index===2){injected=false;faults++;res.writeHead(429,{'retry-after':'1'});res.end('synthetic failure');return;}
  const original=context.messages.find(m=>m.authorId===null&&!m.deleted),state=context.self.privateState!;
  let action:unknown;
  if(system.includes('Process exactly the supplied unprocessed delivery window'))action={notes:original?[{text:'Synthetic retained original '+original.sequence,sourceMessageIds:[original.id]}]:[]};
  else if(system.includes('Write only your own proposed utterance'))action={decision:'DRAFT',text:context.candidate?.intent.intent??'Synthetic contribution'};
  else if(system.includes('Read the new context and delta'))action=context.coverage?.complete?{decision:'KEEP'}:{decision:'REWRITE',text:context.candidate!.text,intent:context.candidate!.intent};
  else {
    const topic=context.messages.filter(m=>m.authorId===null&&m.text.startsWith('SOAK_TOPIC_')).at(-1);
    const previous=state.entries.find(e=>e.id==='soak-topic')?.text;
    const speak=system.includes('Choose whether YOU want to speak now')&&topic&&previous!==topic.text;
    const intent:Intent={act:'comment',intent:'Synthetic contribution to '+(topic?.text??'initial input'),replyTo:topic?.id??null,addressedTo:[]};
    action={action:speak?{decision:'SPEAK',intent}:{decision:'ABSTAIN',reason:'synthetic owner chooses quiet'},statePatch:{agentId:state.agentId,sessionId:state.sessionId,expectedVersion:state.version,observationId:context.observation!.id,
      upsert:[{id:'soak-retained',kind:'interest',text:'SOAK_PRIVATE_OWNER_'+index,evidence:[],resume:null},...speak?[{id:'soak-topic',kind:'interest',text:topic!.text,evidence:[],resume:null}]:[]],remove:[]}};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(action)}}],...(index===1?{}:{usage:{prompt_tokens:23,completion_tokens:13}})}));
})().catch(error=>{providerFailure=error instanceof Error?error.message:'SOAK_PROVIDER_FAILURE';if(!res.headersSent)res.writeHead(500);res.end('synthetic fixture failure');});});
function processSample(pid:number|undefined){
  if(!pid)return {pid:null,rssKiB:null,cpuTicks:null,sockets:null};
  try{const status=readFileSync(`/proc/${pid}/status`,'utf8'),stat=readFileSync(`/proc/${pid}/stat`,'utf8').replace(/^.*\) /,'').split(' ');
    let sockets=0;for(const fd of readdirSync(`/proc/${pid}/fd`))try{if(readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith('socket:'))sockets++;}catch{}
    return {pid,rssKiB:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0),cpuTicks:Number(stat[11])+Number(stat[12]),sockets};
  }catch{return {pid,rssKiB:null,cpuTicks:null,sockets:null};}
}
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const n=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return n;}
let cluster:Awaited<ReturnType<typeof startCluster>>|undefined;
const samples:{elapsedMs:number;databaseBytes:number;walBytes:number;agents:Usage['runtime']['agents'];processes:ReturnType<typeof processSample>[];calls:number;posts:number}[]=[];
let restartMs:number|null=null,elapsedMs=0,final:Usage|undefined,outcome='FAILED',failure:string|null=null;
const originalIds:string[]=[],events:{elapsedMs:number;kind:string}[]=[],windows=new Set<string>();
let firstOwners:string[]=[];let statePreserved=false,memoryPreserved=false,originalsVerified=false;
try{
  await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const endpoint=(provider.address() as {port:number}).port,corePort=await port();
  const profiles=Array.from({length:3},(_,i)=>({id:'soak-'+i,provider:'openai',model:'synthetic-soak-'+i,baseUrl:`http://127.0.0.1:${endpoint}/v1`,jsonMode:'json',maxOutputTokens:128,authRequired:true,apiKeyEnv:'SYNTHETIC_SOAK_KEY_'+i,allowLocalHttp:true,failureThreshold:1,circuitCooldownMs:1000}));
  const config=join(root,'config.json');writeFileSync(config,JSON.stringify({profiles}),{mode:0o600});
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,APP_CONFIG:config,APP_BIND:'127.0.0.1',PORT:String(corePort),PUBLIC_ORIGIN:`http://127.0.0.1:${corePort}`,DB_PATH:dbPath,ALLOW_LIVE_MODELS:'1',RESTART_POLICY:'paused',BUILD_SHA:process.env.GITHUB_SHA??'local',DIAGNOSTIC_EVIDENCE_MODE:'synthetic'};
  profiles.forEach((p,i)=>{env[p.apiKeyEnv]='synthetic-soak-key-'+i;});
  const bindings=Object.fromEntries(['a','b','c'].map((s,i)=>['worker-'+s,[profiles[i].apiKeyEnv]]));
  cluster=await startCluster(env,true,bindings);
  const api=async<T=any>(path:string,body?:unknown):Promise<T>=>{
    const current=cluster!;const response=await fetch(current.base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+current.token,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});
    assert(response.ok,'SOAK_API_'+response.status+'_'+path);return response.json();
  };
  const caps=await api('/v1/capabilities'),characters=await api('/v1/characters');
  const windowMs=Math.max(10000,Math.min(30000,Math.floor(seconds*1000/6)));
  const settings={...caps.defaults,selfWakeEnabled:false,idleMs:60000,memoryEvery:3,memoryFlushMs:500,memoryShareEvery:2,contextMessages:20,debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0,postGapMs:30,agentCooldownMs:50,replyGraceMs:0,arbitrationMs:10,episodeGapMs:1000,maxCalls:3000,maxMessages:1000,maxDurationMs:Math.min(21600000,seconds*1000+120000),operationalBudget:{mode:'continuous',windowMs,autoRenew:true,maxTokens:50000000,scopeMaxCalls:null,scopeMaxTokens:null}};
  const {id}=await api('/v1/sessions',{title:'Synthetic operational workload',participants:caps.slots.map((slot:string,i:number)=>({slot,characterId:characters[i].id,profileId:profiles[i].id})),settings});
  const rootPath=`/v1/sessions/${id}`;
  const post=async(text:string)=>{const message=await api<PublicMessage>(rootPath+'/messages',{text});originalIds.push(message.id);return message;};
  for(let i=0;i<limits.initialOriginals;i++)await post('SOAK_ARCHIVE_'+i);
  firstOwners=(await api<Snapshot>(rootPath+'/snapshot')).agents.map(a=>a.id);
  await api(rootPath+'/start',{});const started=Date.now(),deadline=started+seconds*1000;
  let nextInput=started,nextSample=started,faultStarted=false,faultRecovered=false,restarted=false,sequence=0;
  const waitFor=async(check:()=>Promise<boolean>,code:string,ms=limits.drainDeadlineMs)=>{const end=Date.now()+ms;while(Date.now()<end){assert.equal(providerFailure,null);if(await check())return;await sleep(200);}throw new Error(code);};
  const recording=async()=>{const response=await fetch(cluster!.base+rootPath+'/diagnostic-export',{headers:{authorization:'Bearer '+cluster!.token},signal:AbortSignal.timeout(60000)});assert(response.ok,'SOAK_RECORDING_FAILED');const parser=new ReplayStream();for(const line of (await response.text()).trimEnd().split('\n'))parser.push(line);return parser.finish();};
  while(Date.now()<deadline){
    elapsedMs=Date.now()-started;assert.equal(providerFailure,null);
    if(!faultStarted&&elapsedMs>=seconds*200){faultStarted=true;injected=true;events.push({elapsedMs,kind:'INJECT_ONE_PROVIDER_429'});}
    if(faults&&!faultRecovered){await api('/v1/model-profiles/soak-2/versions/1/retry',{});faultRecovered=true;events.push({elapsedMs,kind:'EXPLICIT_PROVIDER_RECOVERY'});}
    if(!restarted&&elapsedMs>=seconds*500){
      await waitFor(async()=>{const u=await api<Usage>(rootPath+'/usage');return u.calls.every(c=>c.inflight===0)&&u.runtime.agents.every(a=>a.input.memoryPending===0&&a.input.observationPending===0);},'SOAK_PRE_RESTART_DRAIN');
      await api(rootPath+'/pause',{});
      const before=await recording();const state=before.state.find(t=>t.table==='agent_private_states')!,memory=before.state.find(t=>t.table==='memories')!;
      assert.equal(state.rows.length,3);assert(memory.rows.length>=3,'SOAK_MEMORY_WAS_NOT_WRITTEN');
      const restarting=Date.now();cluster!.children[0].kill('SIGKILL');await cluster!.stop();cluster=await startCluster(env,true,bindings);restartMs=Date.now()-restarting;
      assert(restartMs<=limits.maxRestartMs,'SOAK_RESTART_LIMIT');
      assert.equal((await api<Snapshot>(rootPath+'/snapshot')).session.lifecycle,'PAUSED');
      const after=await recording();assert.deepEqual(after.state.find(t=>t.table==='agent_private_states'),state);assert.deepEqual(after.state.find(t=>t.table==='memories'),memory);
      statePreserved=true;memoryPreserved=true;
      const stoppedCalls=(await api<Snapshot>(rootPath+'/snapshot')).session.calls;await sleep(windowMs+500);
      const paused=await api<Snapshot>(rootPath+'/snapshot');assert.equal(paused.session.lifecycle,'PAUSED');assert.equal(paused.session.calls,stoppedCalls,'SOAK_RESTART_AUTO_RESUMED');
      await api(rootPath+'/budget',{});await api(rootPath+'/resume',{});restarted=true;events.push({elapsedMs:Date.now()-started,kind:'CORE_KILL_RESTART_MANUAL_BUDGET_RESUME'});
    }
    if(Date.now()>=nextInput){await post('SOAK_TOPIC_'+sequence++);nextInput=Date.now()+limits.inputIntervalMs;}
    if(Date.now()>=nextSample){
      const u=await api<Usage>(rootPath+'/usage');assert.equal(u.lifecycle,'RUNNING','SOAK_UNEXPECTED_STOP');if(u.window)windows.add(u.window.id);
      const processes=cluster!.children.map(c=>processSample(c.pid));assert.equal(processes.length,4);
      if(process.platform==='linux')for(const p of processes){assert(p.rssKiB!==null&&p.rssKiB<=limits.maxRssKiB,'SOAK_RSS_LIMIT');assert(p.sockets!==null&&p.sockets<=limits.maxSocketsPerProcess,'SOAK_SOCKET_LIMIT');}
      assert(u.runtime.databaseBytes<=limits.maxDatabaseBytes,'SOAK_DATABASE_LIMIT');
      samples.push({elapsedMs:Date.now()-started,databaseBytes:u.runtime.databaseBytes,walBytes:existsSync(dbPath+'-wal')?statSync(dbPath+'-wal').size:0,agents:u.runtime.agents,processes,calls:u.calls.reduce((n,c)=>n+c.calls,0),posts:u.publicPosts});nextSample=Date.now()+5000;
    }
    await sleep(200);
  }
  await waitFor(async()=>{const u=await api<Usage>(rootPath+'/usage');return u.runtime.agents.every(a=>a.input.memoryPending===0&&a.input.observationPending===0)&&u.calls.every(c=>c.inflight===0);},'SOAK_FINAL_DRAIN');
  await api(rootPath+'/pause',{});final=await api<Usage>(rootPath+'/usage');elapsedMs=Date.now()-started;
  assert(restarted&&faultRecovered&&faults===1,'SOAK_FAULT_PATH_MISSING');assert(windows.size>=2,'SOAK_RENEWAL_NOT_OBSERVED');assert.equal(ownerRequests.size,3,'SOAK_OWNER_STARVATION');
  assert.deepEqual((await api<Snapshot>(rootPath+'/snapshot')).agents.map(a=>a.id),firstOwners);
  const originals:PublicMessage[]=[];let cursor:string|null=null;
  do{const page=await api<Page<PublicMessage>>(rootPath+'/history?limit=200'+(cursor?'&cursor='+encodeURIComponent(cursor):''));originals.push(...page.items);cursor=page.nextCursor;}while(cursor);
  assert.equal(new Set(originals.map(m=>m.id)).size,originals.length,'SOAK_DUPLICATE_PUBLICATION');
  assert.deepEqual(new Set(originals.filter(m=>m.authorId===null).map(m=>m.id)),new Set(originalIds),'SOAK_ORIGINAL_LOSS');originalsVerified=true;
  assert((await api<any[]>(rootPath+'/episodes')).length>=2,'SOAK_EPISODE_BOUNDARY_MISSING');
  await api(rootPath+'/end',{});outcome='PASSED';
}catch(error){failure=error instanceof Error&&/^(?:SOAK_|REPLAY_)[A-Z_0-9/:.-]+$/.test(error.message)?error.message:'SOAK_ASSERTION_FAILED';process.exitCode=1;}
finally{
  await cluster?.stop();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));
  mkdirSync(resolve(reportPath,'..'),{recursive:true});
  writeFileSync(reportPath,JSON.stringify({schemaVersion:1,mode:'synthetic-operational-e2e',outcome,failure,commit:process.env.GITHUB_SHA??'local',limits,elapsedMs,viewerConnections:0,workerProcesses:3,providerDelaysMs:[20,20,100],requests,faults,ownerCalls:[...ownerRequests.values()],restartMs,originalCount:originalIds.length,originalsVerified,statePreserved,memoryPreserved,observedWindows:windows.size,events,samples,usage:final??null,semanticAcceptance:'NOT_EVALUATED',liveModelCalls:0,longerDurationGuarantee:false},null,2));
  rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({outcome,elapsedMs,originals:originalIds.length,requests,faults,restartMs,semanticAcceptance:'NOT_EVALUATED'}));
}
