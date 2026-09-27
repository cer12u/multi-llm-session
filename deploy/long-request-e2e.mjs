// Actual Core/Worker processes and HTTP; only the external Provider is synthetic.
// Real wall-clock waits. No internal Service calls or database writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import Database from 'better-sqlite3';
import {startCluster} from '../dist/apps/cli/cluster.js';
import {SettingsSchema} from '../dist/packages/contracts/index.js';
import {defaultCharacters} from '../dist/packages/config/index.js';
const root=mkdtempSync(join(tmpdir(),'mls-long-e2e-')),delay=ms=>new Promise(r=>setTimeout(r,ms));
let cluster,id,phase='delayed',calls=0,firstAt=0,slowDelivered=false,held,release,firstRequestBytes=0;
const headers={};
const uuid=/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const payload=Buffer.concat(chunks),body=JSON.parse(payload),wire=payload.toString('utf8'),c=JSON.parse(body.messages.find(m=>m.role==='user').content);
  assert.equal(body.response_format.type,'json_schema');calls++;if(!firstRequestBytes)firstRequestBytes=payload.length;
  assert.equal(/agentId|sessionId|expectedVersion|observationId/.test(wire),false,'model contract must not expose transaction bindings');
  assert.equal(uuid.test(wire),false,'model contract must use request-local handles instead of UUIDs');
  assert.match(c.self.ref,/^self$/);assert.match(c.messages.at(-1).ref,/^m\d+$/);
  const evidence=c.messages.at(-1).ref;
  const action={decision:phase==='hold'?'SPEAK':'ABSTAIN',...(phase==='hold'?{intent:{act:'comment',intent:'obsolete proposal',replyTo:evidence,addressedTo:[]}}:{reason:'synthetic listen'})};
  const result={action,state:{upsert:[{id:'long-e2e',kind:'interest',text:phase==='hold'?'MUST_NOT_SURVIVE_PAUSE':'retained after long HTTP wait',
    evidence:[evidence],derivedFrom:[],question:null,participation:null,resume:null}],remove:[]}};
  if(phase==='delayed'&&calls===1){firstAt=Date.now();await delay(310000);slowDelivered=true;}
  if(phase==='hold'){held={owner:c.self.ref,at:Date.now()};await new Promise(resolve=>{release=resolve;});}
  res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});
  res.end(gzipSync(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({result})}}],usage:{prompt_tokens:12,completion_tokens:8}})));
 }catch(error){if(!res.headersSent)res.writeHead(500);res.end();console.error('Synthetic provider failed:',error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const providerPort=server.address().port;
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const settings=SettingsSchema.parse({requestTimeoutMs:900000,leaseMs:5000,selfWakeEnabled:false,maxDurationMs:480000,maxCalls:20,maxMessages:5,idleMs:86400000,memoryEvery:1000,memoryFlushMs:86400000,debounceMs:0,directedDebounceMs:0,maxCoalesceMs:0});
const config={characters:defaultCharacters,profiles:[{id:'slow',provider:'openai',model:'synthetic-long-response',baseUrl:`http://127.0.0.1:${providerPort}/v1`,allowLocalHttp:true,authRequired:false,jsonMode:'schema',maxOutputTokens:512,maxConcurrent:1}],sessionDefaults:settings};
const configPath=join(root,'config.json'),dbPath=join(root,'db.sqlite');writeFileSync(configPath,JSON.stringify(config));
async function api(path,body){const r=await fetch(cluster.base+path,{method:body===undefined?'GET':'POST',headers:{...headers,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});assert.equal(r.status,200,'actual API '+path);return r.json();}
async function until(check,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const v=await check();if(v)return v;await delay(100);}throw new Error('APPLICATION_WAIT_EXPIRED');}
function rows(){const db=new Database(dbPath,{readonly:true,fileMustExist:true});try{return {
 states:db.prepare('SELECT agent_id,version,entries_json FROM agent_private_states ORDER BY agent_id').all(),
 updates:db.prepare("SELECT patch_json FROM agent_state_updates WHERE kind='RUN_RESULT' ORDER BY id").all(),
};}finally{db.close();}}
try{
 cluster=await startCluster({PATH:process.env.PATH,HOME:process.env.HOME,APP_CONFIG:configPath,DB_PATH:dbPath,PORT:String(port),PUBLIC_ORIGIN:`http://127.0.0.1:${port}`,ALLOW_LIVE_MODELS:'1'},true);
 headers.authorization='Bearer '+cluster.token;
 const caps=await api('/v1/capabilities');assert.equal(caps.defaults.requestTimeoutMs,900000);
 id=(await api('/v1/sessions',{title:'Long inference lifecycle E2E',participants:caps.slots.map((slot,i)=>({slot,characterId:defaultCharacters[i].id,profileId:'slow'})),settings})).id;
 const prefix='/v1/sessions/'+id;
 await api(prefix+'/messages',{text:'Synthetic input for the long-call lifecycle'});await api(prefix+'/start',{});
 await until(()=>firstAt);
 await delay(185000);
 const ongoing=await api(prefix+'/diagnostics');assert.equal(slowDelivered,false);
 assert.equal(ongoing.runs.some(r=>r.state==='DONE'),false);
 assert(ongoing.runs.filter(r=>r.state==='ACTIVE').every(r=>r.lease_until>Date.now()));
 assert.equal(calls,1,'Provider reservation still excludes the two queued Workers');
 console.log(JSON.stringify({stage:'past-original-180s',elapsedMs:Date.now()-firstAt,activeRuns:ongoing.runs.filter(r=>r.state==='ACTIVE').length,providerCalls:calls,leaseAlive:true}));
 await until(async()=>{const d=await api(prefix+'/diagnostics');return d.runs.filter(r=>r.kind==='decide'&&r.state==='DONE').length===3;},150000);
 assert(slowDelivered);const longElapsed=Date.now()-firstAt;
 const retained=rows();assert.equal(retained.states.length,3);
 for(const state of retained.states){const entry=JSON.parse(state.entries_json).find(e=>e.text==='retained after long HTTP wait');assert(entry);assert.equal(entry.evidence.length,1);assert.match(entry.evidence[0].id,uuid);}
 assert.equal(retained.updates.length,3);
 for(const update of retained.updates){const patch=JSON.parse(update.patch_json);assert.match(patch.agentId,uuid);assert.match(patch.sessionId,uuid);assert.equal(typeof patch.expectedVersion,'number');assert.match(patch.observationId,/^[a-f0-9]{64}$/);}
 assert.equal((await api(prefix+'/snapshot')).session.botMessages,0);
 phase='hold';await api(prefix+'/messages',{text:'A second synthetic input, paused while a model request is active'});await until(()=>held);
 const before=rows().states;await api(prefix+'/pause',{});release();await delay(2500);
 assert.deepEqual(rows().states,before,'Late model output must not update private state');
 const paused=await api(prefix+'/snapshot');assert.equal(paused.session.lifecycle,'PAUSED');assert.equal(paused.session.botMessages,0);
 assert((await api(prefix+'/diagnostics')).runs.some(r=>r.state==='CANCELLED'));
 const callsAtPause=calls;await delay(2000);assert.equal(calls,callsAtPause);
 phase='normal';await api(prefix+'/resume',{});await until(async()=>{const s=await api(prefix+'/snapshot');return s.session.lifecycle==='RUNNING';});
 await api(prefix+'/end',{});assert.deepEqual(rows().states.map(s=>s.entries_json),before.map(s=>s.entries_json));
 const summary={mode:'actual-core-three-workers-http-sqlite',modelContract:'semantic-handles-v1',firstRequestBytes,modelSawPersistentIds:false,workerSynthesizedBindings:true,
  slowResponseMs:310000,observedAcceptanceMs:longElapsed,requestTimeoutMs:900000,leaseMs:5000,threeOwnersAccepted:true,delayedHeadersBeyond300s:true,gzipDecoded:true,
  privateStateRetained:true,pauseFencedLateResult:true,noPostAfterPause:true,noNewCallWhilePaused:true,resumePreservedState:true,paidInference:false};
 mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/long-request-e2e.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{release?.();await cluster?.stop();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
