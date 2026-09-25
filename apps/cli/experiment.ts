import {readFileSync,writeFileSync,mkdirSync,realpathSync,statSync,readdirSync,readlinkSync} from 'node:fs';
import {dirname,resolve,relative,join,sep} from 'node:path';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {experimentPreflight} from '../../packages/config/experiment.js';
import {credential} from '../../packages/config/credentials.js';
import {startCluster} from './cluster.js';
import {diagnosticCommand} from './diagnostic-client.js';
import {delay} from '../agent-worker/runtime.js';

async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return p;}
function save(path:string,value:unknown){writeFileSync(path,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});}
function processSample(pid:number|undefined){
  if(!pid)return {pid:null,rssKiB:null,cpuTicks:null,sockets:null};
  try{const status=readFileSync(`/proc/${pid}/status`,'utf8'),stat=readFileSync(`/proc/${pid}/stat`,'utf8').replace(/^.*\) /,'').split(' ');
    let sockets=0;for(const fd of readdirSync(`/proc/${pid}/fd`))try{if(readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith('socket:'))sockets++;}catch{}
    return {pid,rssKiB:status.match(/^VmRSS:\s+(\d+)/m)?Number(status.match(/^VmRSS:\s+(\d+)/m)![1]):null,cpuTicks:Number(stat[11])+Number(stat[12]),sockets};
  }catch{return {pid,rssKiB:null,cpuTicks:null,sockets:null};}
}
async function main(){
  const [action,file,output,...extra]=process.argv.slice(2);
  if(!['preflight','execute'].includes(action)||!file||extra.length||(action==='execute'&&!output))throw new Error('EXPERIMENT_ARGUMENTS');
  if(statSync(file).size>1048576)throw new Error('EXPERIMENT_MANIFEST_TOO_LARGE');
  const preflight=experimentPreflight(JSON.parse(readFileSync(file,'utf8')));
  if(action==='preflight'||preflight.report.status!=='READY'){console.log(JSON.stringify(preflight.report));if(preflight.report.status!=='READY')process.exitCode=2;return;}
  const {manifest,settings}=preflight,target=resolve(output),parent=realpathSync(dirname(target)),repository=realpathSync(preflight.repository!);
  const rel=relative(repository,join(parent,target.slice(dirname(target).length+1)));
  if(rel!=='..'&&!rel.startsWith('..'+sep))throw new Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  mkdirSync(target,{mode:0o700});const port=await freePort(),configPath=join(target,'config.json');
  const slots=manifest.participants.map((p,i)=>({id:p.slot,tokenEnv:`WORKER_${i}_TOKEN`}));
  save(configPath,{workerSlots:slots,profiles:manifest.profiles,characters:manifest.characters,sessionDefaults:settings});
  save(join(target,'manifest.json'),{...preflight.report,manifest,effectiveSettings:settings});
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',APP_CONFIG:configPath,
    PORT:String(port),PUBLIC_ORIGIN:`http://127.0.0.1:${port}`,APP_BIND:'127.0.0.1',DB_PATH:join(target,'session.sqlite'),
    ALLOW_LIVE_MODELS:'1',RESTART_POLICY:'paused',BUILD_SHA:preflight.report.commit!,DIAGNOSTIC_EVIDENCE_MODE:manifest.evidenceMode};
  for(const profile of manifest.profiles)if(profile.apiKeyEnv){const value=credential(profile);if(value)env[profile.apiKeyEnv]=value;}
  const bindings=Object.fromEntries(manifest.participants.map(p=>[p.slot,[manifest.profiles.find(f=>f.id===p.profileId)!.apiKeyEnv].filter((n):n is string=>!!n)]));
  let cluster:Awaited<ReturnType<typeof startCluster>>|undefined,id:string|undefined,exitReason='STARTUP_FAILED';
  const samples:unknown[]=[];let stopped=false;
  const interrupt=()=>{stopped=true;};process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
  try{
    cluster=await startCluster(env,true,bindings);const current=cluster;
    const api=async(path:string,body?:unknown)=>{const r=await fetch(current.base+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+current.token,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('EXPERIMENT_CORE_COMMAND_FAILED');return r.json();};
    id=(await api('/v1/sessions',{title:manifest.scenario,participants:manifest.participants,settings})).id;
    await api(`/v1/sessions/${id}/messages`,{text:manifest.initialText});await api(`/v1/sessions/${id}/start`,{});
    const started=Date.now(),deadline=started+manifest.bounds.durationMs;let quietAt:number|null=null,nextSample=0;
    while(!stopped&&Date.now()<deadline){
      const snapshot=await api(`/v1/sessions/${id}/snapshot`);
      if(snapshot.session.lifecycle!=='RUNNING'){exitReason=snapshot.session.stopReason??snapshot.session.lifecycle;break;}
      if(snapshot.session.activity==='QUIET')quietAt??=Date.now();else quietAt=null;
      if(manifest.quietStopMs!==null&&quietAt!==null&&Date.now()-quietAt>=manifest.quietStopMs){exitReason='VOLUNTARY_QUIET';break;}
      if(Date.now()>=nextSample){samples.push({elapsedMs:Date.now()-started,usage:await api(`/v1/sessions/${id}/usage`),processes:current.children.map(c=>processSample(c.pid))});nextSample=Date.now()+Math.max(1000,Math.ceil(manifest.bounds.durationMs/1000));}
      await delay(200);
    }
    if(stopped)exitReason='OPERATOR_SIGNAL';else if(Date.now()>=deadline)exitReason='WALL_DEADLINE';
    const last=await api(`/v1/sessions/${id}/snapshot`);if(last.session.lifecycle!=='ENDED')await api(`/v1/sessions/${id}/end`,{});
    const usage=await api(`/v1/sessions/${id}/usage`),diagnostics=await api(`/v1/sessions/${id}/diagnostics`);
    await diagnosticCommand(['diagnostic-export',id!,join(target,'private-recording.ndjson')],{CORE_URL:current.base,ADMIN_TOKEN:current.token});
    const result={...preflight.report,status:'EXECUTED',sessionId:id,elapsedMs:Date.now()-started,exitReason,usage,metrics:diagnostics.metrics,
      semanticAcceptance:'NOT_EVALUATED',humanReviewed:false,remoteInferenceCancellationGuaranteed:false,privateRecording:'private-recording.ndjson'};
    save(join(target,'result.json'),result);save(join(target,'resources.json'),samples);
    console.log(JSON.stringify({status:'EXECUTED',scenario:manifest.scenario,evidenceMode:manifest.evidenceMode,sessionId:id,calls:usage.calls.reduce((n:number,c:{calls:number})=>n+c.calls,0),posts:usage.publicPosts,exitReason,semanticAcceptance:'NOT_EVALUATED',privateFiles:true}));
  }catch(error){save(join(target,'failure.json'),{status:'FAILED',sessionId:id??null,exitReason,code:error instanceof Error&&/^EXPERIMENT_[A-Z_]+$/.test(error.message)?error.message:'EXPERIMENT_FAILED',semanticAcceptance:'NOT_EVALUATED'});throw error;}
  finally{await cluster?.stop();process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);}
}
try{await main();}catch{console.error('EXPERIMENT_FAILED: inspect the private result and preflight; no credential values are printed.');process.exitCode=1;}
