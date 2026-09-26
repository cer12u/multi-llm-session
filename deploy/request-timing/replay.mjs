// Bounded real-model request diagnosis, not a conversation E2E or a unit test.
// Only synthetic initial data; unchanged application request builder and output parser.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const argv=process.argv.slice(2),args={};
for(let i=0;i<argv.length;i++){
 const key=argv[i];
 if(['--execute','--dedicated-server'].includes(key)){args[key]=true;continue;}
 if(!key.startsWith('--')||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('INVALID_ARGUMENTS');
 args[key]=argv[++i];
}
const allowed=new Set(['--request','--models','--base','--context','--out','--validator','--execute','--dedicated-server','--timeout-ms','--total-ms']);
if(Object.keys(args).some(k=>!allowed.has(k)))throw new Error('UNKNOWN_ARGUMENT');
if(!args['--execute']||!args['--dedicated-server']||!args['--request']||!args['--out']||!args['--models'])throw new Error('EXPLICIT_EXECUTION_REQUIRED');
const base=new URL(args['--base']??'http://127.0.0.1:11434');
if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('ISOLATED_LOOPBACK_REQUIRED');
const timeout=Number(args['--timeout-ms']??180000),total=Number(args['--total-ms']??660000),numCtx=Number(args['--context']??49152);
if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>600000||!Number.isSafeInteger(total)||total<timeout||total>3600000||!Number.isSafeInteger(numCtx)||numCtx<2048||numCtx>131072)throw new Error('INVALID_LIMITS');
const input=JSON.parse(readFileSync(args['--request'],'utf8'));
if(!Array.isArray(input.messages)||!input.options||!Number.isSafeInteger(input.options.num_predict)||input.options.num_predict<1||input.options.num_predict>4096||Buffer.byteLength(JSON.stringify(input))>1048576)throw new Error('INVALID_REQUEST');
const models=[...new Set(String(args['--models']).split(',').map(x=>x.trim()))];
if(models.length<1||models.length>4||models.some(x=>!x||x.length>200))throw new Error('INVALID_MODELS');
const out=resolve(args['--out']);if(existsSync(out))throw new Error('OUTPUT_EXISTS');mkdirSync(out,{mode:0o700});
const save=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
let parseOutput=null;
if(args['--validator']){const module=await import(pathToFileURL(resolve(args['--validator'])));if(typeof module.parseOutput!=='function')throw new Error('INVALID_VALIDATOR');parseOutput=module.parseOutput;}
const started=performance.now(),deadline=Date.now()+total;
const report={mode:'isolated-real-ollama-request-replay',sourceSha:process.env.GITHUB_SHA??null,requestHash:hash(input),messagesHash:hash(input.messages),node:process.version,contextRequested:numCtx,limits:{timeoutMs:timeout,totalMs:total,maxOutputTokens:input.options.num_predict},models,cases:[],semanticAcceptance:'NOT_EVALUATED',applicationE2E:false,newModelCalls:0};
async function control(path,body){
 const left=deadline-Date.now();if(left<=0)throw new Error('TOTAL_DEADLINE');
 const r=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(Math.min(60000,left))});
 if(!r.ok){await r.body?.cancel();throw new Error('CONTROL_HTTP_'+r.status);}return r.json();
}
async function runCase(model,kind,index){
 const stream=kind!=='full-nonstream',body={...structuredClone(input),model,stream,options:{...input.options,num_ctx:numCtx,num_predict:kind==='prefill-one-token'?1:input.options.num_predict}};
 const row={model,case:kind,requestHash:hash(body),messagesHash:hash(body.messages),requestBytes:Buffer.byteLength(JSON.stringify(body)),outputCap:body.options.num_predict,stream,contextRequested:numCtx,cacheCondition:'model-unloaded-and-loaded-before-case',status:'STARTED',httpStatus:null,headersMs:null,firstChunkMs:null,firstContentMs:null,firstThinkingMs:null,contentChunks:0,thinkingChunks:0,contentBytes:0,thinkingBytes:0,done:false,finishReason:null,elapsedMs:null,loadMs:null,promptTokens:null,promptEvalMs:null,outputTokens:null,outputEvalMs:null,tokensPerSecond:null,parseStatus:'NOT_EVALUATED',schemaStatus:'NOT_EVALUATED'};
 report.cases.push(row);let content='',last=null,buffer='',received=0,reader=null;
 const start=performance.now(),elapsed=()=>Number((performance.now()-start).toFixed(3));
 const remaining=deadline-Date.now();if(remaining<=0){row.status='TOTAL_DEADLINE';return;}
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new DOMException('Deadline','TimeoutError')),Math.min(timeout,remaining));
 function chunk(o){
  if(o.error)throw new Error('MODEL_SERVER_ERROR');last=o;
  if(typeof o.message?.content==='string'&&o.message.content.length){row.firstContentMs??=elapsed();row.contentChunks++;content+=o.message.content;row.contentBytes+=Buffer.byteLength(o.message.content);}
  // Count activity only; never retain reasoning text.
  if(typeof o.message?.thinking==='string'&&o.message.thinking.length){row.firstThinkingMs??=elapsed();row.thinkingChunks++;row.thinkingBytes+=Buffer.byteLength(o.message.thinking);}
 }
 try{
  report.newModelCalls++;
  const r=await fetch(new URL('/api/chat',base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal});row.httpStatus=r.status;row.headersMs=elapsed();
  if(!r.ok){await r.body?.cancel();row.status='HTTP_'+r.status;return;}
  if(!r.body)throw new Error('NO_RESPONSE_BODY');
  reader=r.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
  for(;;){const {done,value}=await reader.read();if(done)break;row.firstChunkMs??=elapsed();received+=value.length;if(received>1048576)throw new Error('RESPONSE_BYTE_LIMIT');buffer+=decoder.decode(value,{stream:true});
   if(stream){let p;while((p=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,p);buffer=buffer.slice(p+1);if(line.trim())chunk(JSON.parse(line));}}
  }
  buffer+=decoder.decode();if(buffer.trim())chunk(JSON.parse(buffer));
  row.done=last?.done===true;row.finishReason=last?.done_reason??null;row.status=row.done?'COMPLETED':'INCOMPLETE_STREAM';
  const n=x=>Number.isFinite(x)&&x>=0?x:null,ns=x=>n(x)===null?null:Number((x/1e6).toFixed(3));
  row.loadMs=ns(last?.load_duration);row.promptTokens=n(last?.prompt_eval_count);row.promptEvalMs=ns(last?.prompt_eval_duration);row.outputTokens=n(last?.eval_count);row.outputEvalMs=ns(last?.eval_duration);
  row.tokensPerSecond=row.outputEvalMs>0&&row.outputTokens!==null?Number((row.outputTokens/row.outputEvalMs*1000).toFixed(3)):null;
  const clean=content.trim().replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```$/,'');
  try{JSON.parse(clean);row.parseStatus='VALID_JSON';}catch{row.parseStatus='INVALID_JSON';}
  if(kind!=='prefill-one-token'&&parseOutput){try{parseOutput('decide',content,typeof body.format==='object');row.schemaStatus='VALID';}catch{row.schemaStatus='INVALID';}}
  if(kind==='prefill-one-token'){row.parseStatus='NOT_EVALUATED_ONE_TOKEN';row.schemaStatus='NOT_EVALUATED_ONE_TOKEN';}
 }catch(error){row.status=controller.signal.aborted?'TIMEOUT':/^[A-Z_0-9]+$/.test(error?.message??'')?error.message:'TRANSPORT_OR_RESPONSE_ERROR';}
 finally{
  clearTimeout(timer);if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}
  row.elapsedMs=elapsed();row.partialContentHash=hash(content);row.partialContentBytes=Buffer.byteLength(content);
  save('private-response-'+index+'.json',{model,case:kind,status:row.status,complete:row.done,content});
  console.log(JSON.stringify(row));
 }
}
try{
 report.ollamaVersion=await control('/api/version');const tags=await control('/api/tags');
 for(const model of models)if(!tags.models?.some(x=>x.name===model||x.model===model))throw new Error('MODEL_NOT_INSTALLED');
 report.modelDigests=tags.models.filter(x=>models.includes(x.name)||models.includes(x.model)).map(x=>({name:x.name,digest:x.digest,size:x.size,details:x.details}));
 save('original-request.private.json',input);let index=0;
 for(const model of models){
  for(const kind of ['prefill-one-token','full-stream','full-nonstream']){
   if(Date.now()>=deadline)break;
   await control('/api/chat',{model,messages:[],keep_alive:0});
   const loadStarted=performance.now();await control('/api/chat',{model,messages:[],keep_alive:'5m',options:{num_ctx:numCtx}});const explicitLoadMs=Number((performance.now()-loadStarted).toFixed(3));
   await runCase(model,kind,++index);report.cases.at(-1).explicitLoadMs=explicitLoadMs;
   try{report.cases.at(-1).serverModels=await control('/api/ps');}catch{}
  }
 }
}catch(error){report.error=/^[A-Z_0-9]+$/.test(error?.message??'')?error.message:'DIAGNOSTIC_SETUP_OR_CONTROL_FAILED';process.exitCode=1;}
finally{report.elapsedMs=Number((performance.now()-started).toFixed(3));save('result.json',report);}
