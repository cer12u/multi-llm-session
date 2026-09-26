// Bounded CI fixture, not a real Provider or a normal deployment entry point.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { ModelProfileSchema } from '../../packages/contracts/index.js';
import { readServiceTokenFiles } from '../../packages/config/service-token-files.js';
import { credential } from '../../packages/config/credentials.js';
import { CoreClient,WorkerRuntime,delay } from '../agent-worker/runtime.js';

if(process.env.SYNTHETIC_DEPLOYMENT_TEST!=='1')throw new Error('SYNTHETIC_FIXTURE_OPT_IN_REQUIRED');
Object.assign(process.env,readServiceTokenFiles());
const profile=ModelProfileSchema.parse(JSON.parse(process.env.SYNTHETIC_PROFILE??''));
const url=new URL(profile.baseUrl!);
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||process.getuid?.()===0)throw new Error('SYNTHETIC_LOOPBACK_NONROOT_REQUIRED');
const expectedKey=credential(profile),character=process.env.SYNTHETIC_CHARACTER!;
let calls=0,fault=false;
const server=createServer((request,response)=>{void(async()=>{
  if(request.url==='/synthetic-fault'&&request.method==='POST'){fault=true;response.end('{}');return;}
  const path=url.pathname.replace(/\/$/,'')+(profile.provider==='ollama'?'/chat':'/chat/completions');
  if(request.method!=='POST'||request.url!==path||request.headers.authorization!=='Bearer '+expectedKey)throw new Error('SYNTHETIC_REQUEST_MISMATCH');
  let raw='';for await(const chunk of request){raw+=String(chunk);if(raw.length>1048576)throw new Error('SYNTHETIC_REQUEST_TOO_LARGE');}
  const input=JSON.parse(raw),system=input.messages.find((m:{role:string})=>m.role==='system')?.content;
  const context=JSON.parse(input.messages.find((m:{role:string})=>m.role==='user').content);
  if(input.model!==profile.model||context.self.name!==character||!system.includes('synthetic persona '+character))throw new Error('SYNTHETIC_IDENTITY_MISMATCH');
  calls++;
  writeFileSync('/tmp/provider-proof.json',JSON.stringify({calls,uid:process.getuid?.(),model:profile.model,profileId:profile.id,profileVersion:profile.version,characterId:character,ownerName:context.self.name,authenticationMatched:true,personaMatched:true,path}),{mode:0o600});
  response.setHeader('content-type','application/json');
  if(fault){response.writeHead(429,{'retry-after':'60'});response.end('{"error":"synthetic rate limit"}');return;}
  const source=context.messages.find((m:{deleted:boolean})=>!m.deleted);
  const result=context.delivery?.purpose==='memory'?{type:'result',action:{notes:source?[{text:'synthetic retained note for '+character,sources:[source.ref]}]:[]},state:null}:{type:'result',action:{decision:'ABSTAIN',reason:'synthetic HTTP acceptance'},state:null};
  const content=JSON.stringify(profile.jsonMode==='schema'?{result}:result);
  response.end(JSON.stringify(profile.provider==='ollama'?{message:{content},done:true,done_reason:'stop',prompt_eval_count:20,eval_count:10}:{choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:20,completion_tokens:10}}));
})().catch(()=>{response.statusCode=500;response.end('{"error":"synthetic fixture assertion failed"}');});});
await new Promise<void>(resolve=>server.listen(Number(url.port),'127.0.0.1',resolve));
const abort=new AbortController(),worker=new WorkerRuntime(new CoreClient(process.env.CORE_URL!,process.env.WORKER_TOKEN!));
const stop=()=>{abort.abort();worker.stop();server.close();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const deadline=setTimeout(()=>{console.error('SYNTHETIC_FIXTURE_DEADLINE');stop();process.exitCode=1;},120000);
try{
  await worker.register();
  while(!abort.signal.aborted){
    try{if(!await worker.once(abort.signal))await delay(100,abort.signal);}
    catch{if(!abort.signal.aborted){await delay(300,abort.signal);try{await worker.register();}catch{}}}
  }
}finally{clearTimeout(deadline);server.close();}
