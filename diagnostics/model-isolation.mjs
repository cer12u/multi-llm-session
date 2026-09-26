// Bounded diagnostic probes of an actual application's HTTP-claimed context.
// Causal latency/format experiment, NOT three-agent acceptance or a unit test.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash,createCipheriv,publicEncrypt} from 'node:crypto';
import {modelRequest,parseOutput,HttpModel} from '../packages/models/index.ts';
import {ModelProfileSchema} from '../packages/contracts/index.ts';
const model=process.env.MODEL_NAME,root=process.env.DIAG_ROOT,approved=process.env.GITHUB_SHA;
if(!model||!root||!approved||!process.env.EVIDENCE_PUBLIC_KEY)throw Error('DIAGNOSTIC_CONFIG_REQUIRED');
const origin='http://127.0.0.1:11434',out=resolve('artifacts/model-isolation');mkdirSync(out,{recursive:true});mkdirSync(root,{recursive:true,mode:0o700});
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const bytes=v=>Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let core,api,sessionId,run,profile;const records=[],privateRecords=[];
const report={mode:'actual-http-context-controlled-inference-probes',sourceSha:approved,applicationBase:'237f87e207e61dae4e973ce279896bf4e14bd738',model,scope:'No model output is committed or published. Single-request probes isolate inference from Worker queue/retry/DB commit.',bounds:{maxGenerationRequests:7,maxGeneratedTokens:2561,maxWallMs:660000},records};
const started=Date.now();
const flush=()=>writeFileSync(join(out,'result.json'),JSON.stringify({...report,elapsedMs:Date.now()-started},null,2));
const json=async(path,body)=>{const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('MODEL_METADATA_HTTP_'+r.status);return r.json();};
async function capture(){
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  profile=ModelProfileSchema.parse({id:'probe',provider:'ollama',model,baseUrl:origin+'/api',allowLocalHttp:true,authRequired:false,jsonMode:'json',maxOutputTokens:512,temperature:0.4,maxConcurrent:1,contextWindowTokens:49152});
  const token=randomBytes(32).toString('hex'),workerTokens=Array.from({length:3},()=>randomBytes(32).toString('hex'));
  const names=['ソラ','ナギ','リン'],traits=['気になる点を具体的に考える。','実用性と使いやすさを重視する。','楽しい工夫や雰囲気を考える。'];
  const config={profiles:[profile],characters:names.map((name,i)=>({schemaVersion:1,id:'local-'+i,version:1,name,persona:traits[i]+'日本語で自然に短く話す。他者の発言を読み、必要なら意見を変える。話す必要がなければ沈黙する。',presentationRef:null})),workerSlots:names.map((_,i)=>({id:'worker-'+i,tokenEnv:'WORKER_'+i+'_TOKEN'}))};
  const configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',APP_CONFIG:configPath,APP_BIND:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'http://127.0.0.1:'+port,ADMIN_TOKEN:token,ALLOW_LIVE_MODELS:'1',RESTART_POLICY:'paused',DB_PATH:join(root,'capture.sqlite'),...Object.fromEntries(workerTokens.map((t,i)=>['WORKER_'+i+'_TOKEN',t]))};
  core=spawn(process.execPath,['--import',import.meta.resolve('tsx'),resolve('apps/core/main.ts')],{env,stdio:'ignore'});
  api=async(path,body,auth=token)=>{const r=await fetch(env.PUBLIC_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('CORE_HTTP_'+r.status);return r.json();};
  let ready=false;for(let i=0;i<100;i++){try{await api('/healthz');ready=true;break;}catch{}if(core.exitCode!==null)break;await sleep(100);}if(!ready)throw Error('CORE_START_FAILED');
  sessionId=(await api('/v1/sessions',{title:'Synthetic size and latency diagnosis',participants:names.map((_,i)=>({slot:'worker-'+i,characterId:'local-'+i,profileId:'probe'})),settings:{selfWakeEnabled:false,idleMs:60000,maxCalls:18,maxMessages:6,maxDurationMs:900000,requestTimeoutMs:180000,leaseMs:180000,maxRetries:0,memoryEvery:3,memoryFlushMs:15000,memoryShareEvery:3,contextMessages:8,contextChars:24000,contextTokens:49152,debounceMs:0,directedDebounceMs:0,maxCoalesceMs:0}})).id;
  await api('/v1/sessions/'+sessionId+'/messages',{text:'架空の小さな読書室を作るなら、どんな場所にしたい？静かに読む人と、感想を少し話したい人の両方が過ごせるといいと思う。'});
  const epoch=(await api('/v1/worker/register',{},workerTokens[0])).epoch;
  await api('/v1/sessions/'+sessionId+'/start',{});
  for(let i=0;i<20;i++){run=await api('/v1/worker/claim',{epoch},workerTokens[0]);if(run)break;await sleep(100);}
  if(!run||run.kind!=='decide')throw Error('DECIDE_CONTEXT_NOT_CAPTURED');
  await api('/v1/sessions/'+sessionId+'/pause',{});
  report.context={from:'real Core HTTP /worker/claim',kind:run.kind,bytes:bytes(run.context),messageCount:run.context.messages.length,privateEntries:run.context.self.privateState.entries.length};
}
function shape(text,wrapped=false){let parsed;try{parsed=parseOutput('decide',text,wrapped);}catch{}
  let jsonValue;try{jsonValue=JSON.parse(text);}catch{}
  return {contentBytes:bytes(text),nonWhitespaceChars:text.replace(/\s/g,'').length,whitespaceFraction:text.length?(text.length-text.replace(/\s/g,'').length)/text.length:0,jsonValid:jsonValue!==undefined,wireValid:parsed!==undefined,decision:parsed?(parsed.action??parsed).decision??null:null,topLevelKeys:jsonValue&&typeof jsonValue==='object'?Object.keys(jsonValue).slice(0,16):[],copiesSchema:!!(jsonValue&&typeof jsonValue==='object'&&(jsonValue.$schema||jsonValue.properties||jsonValue.anyOf)),statePatchPresent:!!parsed?.statePatch};
}
async function measure(name,input,{stream=true,timeoutMs=180000,wrapped=false,expectComplete=true}={}){
  if(records.length>=7||Date.now()-started>600000){report.remainingProbes='NOT_RUN_TIME_BUDGET';return;}
  const body=structuredClone(input);body.stream=stream;const textBody=JSON.stringify(body),t=performance.now();
  const row={name,stream,requestBytes:bytes(textBody),systemBytes:bytes(body.messages.find(m=>m.role==='system')?.content??''),contextBytes:bytes(body.messages.find(m=>m.role==='user')?.content??''),requestHash:hash(textBody),maxOutputTokens:body.options?.num_predict,format:typeof body.format==='object'?'schema':body.format??'none',timeoutMs,httpStatus:null,headersMs:null,firstChunkMs:null,firstContentMs:null,firstNonWhitespaceMs:null,chunks:0,contentChunks:0,done:false,doneReason:null,expectComplete,status:'STARTED'};
  records.push(row);flush();console.log(JSON.stringify({stage:'START',name,requestBytes:row.requestBytes}));
  let text='',thinkingChars=0,last,reader;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const chunk=j=>{last=j;if(row.firstChunkMs===null)row.firstChunkMs=Math.round(performance.now()-t);row.chunks++;
    if(typeof j.message?.thinking==='string')thinkingChars+=j.message.thinking.length;
    if(typeof j.message?.content==='string'&&j.message.content.length){row.contentChunks++;text+=j.message.content;if(row.firstContentMs===null)row.firstContentMs=Math.round(performance.now()-t);if(row.firstNonWhitespaceMs===null&&j.message.content.trim())row.firstNonWhitespaceMs=Math.round(performance.now()-t);}
    if(j.done){row.done=true;row.doneReason=j.done_reason??null;}
    if(j.error)throw Error('MODEL_STREAM_ERROR');if(bytes(text)>1048576)throw Error('PROBE_OUTPUT_CAP');
  };
  try{const response=await fetch(origin+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:textBody,signal:controller.signal});row.httpStatus=response.status;row.headersMs=Math.round(performance.now()-t);
    if(!response.ok){await response.body?.cancel();throw Error('MODEL_HTTP_'+response.status);}
    if(stream){reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())chunk(JSON.parse(line));}if(bytes(buffer)>1048576)throw Error('PROBE_LINE_CAP');}buffer+=decoder.decode();if(buffer.trim())chunk(JSON.parse(buffer));}
    else chunk(await response.json());row.status=row.done?'COMPLETED':'INCOMPLETE_STREAM';
  }catch(e){row.status=controller.signal.aborted?'TIMEOUT':/^MODEL_|^PROBE_/.test(e.message)?e.message:'TRANSPORT_ERROR';await reader?.cancel().catch(()=>{});}
  finally{clearTimeout(timer);row.elapsedMs=Math.round(performance.now()-t);Object.assign(row,shape(text,wrapped),{thinkingChars});
    for(const key of ['total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration'])row[key]=typeof last?.[key]==='number'?last[key]:null;
    row.prefillTokensPerSecond=row.prompt_eval_duration>0?row.prompt_eval_count/(row.prompt_eval_duration/1e9):null;row.decodeTokensPerSecond=row.eval_duration>0?row.eval_count/(row.eval_duration/1e9):null;
    row.elapsedBeforeFirstContentMs=row.firstContentMs??row.elapsedMs;row.completedWithin90s=row.done&&row.elapsedMs<=90000;
    privateRecords.push({name,messages:body.messages,output:text});flush();console.log(JSON.stringify(row));}
  return row;
}
try{
  if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==approved)throw Error('SHA_MISMATCH');
  execFileSync('git',['diff','--exit-code',report.applicationBase,'HEAD','--','apps','packages','package.json','package-lock.json'],{stdio:'ignore'});
  report.version=await json('/api/version');report.modelDetails=await json('/api/show',{model});
  report.modelDetails={details:report.modelDetails.details,model_info:report.modelDetails.model_info,capabilities:report.modelDetails.capabilities};
  report.host={cpu:readFileSync('/proc/cpuinfo','utf8').match(/model name\s*:\s*(.+)/)?.[1],node:process.version};
  await capture();const full=modelRequest(profile,run.kind,run.context,{maxChars:run.contextChars});
  report.request={bytes:bytes(full),systemBytes:bytes(full.messages[0].content),schemaBytes:bytes(full.messages[0].content.split('this schema: ').at(-1)),contextBytes:bytes(full.messages[1].content),originalStream:full.stream,numCtxSent:full.options.num_ctx??null};
  await api('/v1/sessions/'+sessionId+'/end',{});core.kill('SIGTERM');await sleep(300);
  const warm=await measure('short-json-control',{model,messages:[{role:'user',content:'Reply with JSON {"ok":true} only.'}],format:'json',options:{num_predict:16,temperature:0}},{timeoutMs:60000});
  if(!warm?.done)throw Error('WARMUP_FAILED');
  await measure('full-json-prefill-one-token',{...full,options:{...full.options,num_predict:1}},{timeoutMs:180000,expectComplete:false});
  await measure('full-json-512-cached',full,{timeoutMs:180000});
  const unformatted=structuredClone(full);delete unformatted.format;
  await measure('full-no-format-512',unformatted,{timeoutMs:120000});
  // A reduced-task control is NOT equivalent to the production contract.
  const compact={...full,messages:[{role:'system',content:'You are one Japanese conversation participant. Read the supplied context and decide whether YOU want to speak. Return only JSON: either {"decision":"ABSTAIN","reason":"short reason"} or {"decision":"SPEAK","intent":{"act":"comment","intent":"your concise contribution intention","replyTo":null,"addressedTo":[]}}. Do not copy a schema. No compulsory speech. This diagnostic omits the private-state, lookup and review tasks.'},full.messages[1]],options:{...full.options,num_predict:256}};
  await measure('reduced-task-control-256',compact,{timeoutMs:90000});
  if(Date.now()-started<480000){let captured;const recordingFetch=async(...args)=>{const r=await fetch(...args);const copy=await r.clone().text();try{captured=JSON.parse(copy);}catch{}return r;};
    const t=performance.now();let status,valid=false,decision=null;
    try{const r=await new HttpModel(profile,undefined,recordingFetch).complete(run.kind,run.context,{maxChars:run.contextChars,signal:AbortSignal.timeout(120000)});const parsed=parseOutput(run.kind,r.text);valid=true;decision=(parsed.action??parsed).decision;status='ACCEPTED_WIRE';privateRecords.push({name:'actual-HttpModel',output:r.text});}catch(e){status=e.code??'ADAPTER_ERROR';}
    records.push({name:'actual-HttpModel-nonstream',status,wireValid:valid,decision,elapsedMs:Math.round(performance.now()-t),prompt_eval_count:captured?.prompt_eval_count??null,prompt_eval_duration:captured?.prompt_eval_duration??null,eval_count:captured?.eval_count??null,eval_duration:captured?.eval_duration??null,doneReason:captured?.done_reason??null});flush();}
  report.status='PROBES_FINISHED';report.semanticAcceptance='NOT_EVALUATED';
}catch(e){report.status='DIAGNOSTIC_FAILED';report.error=/^[A-Z_0-9]+$/.test(e.message)?e.message:'DIAGNOSTIC_ERROR';process.exitCode=1;}
finally{
  if(core?.exitCode===null){core.kill('SIGTERM');await sleep(250);if(core.exitCode===null)core.kill('SIGKILL');}
  const key=randomBytes(32),nonce=randomBytes(12),aad=Buffer.from(approved+':'+model),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(privateRecords)),cipher.final()]);
  writeFileSync(join(out,'private-evidence.enc.json'),JSON.stringify({algorithm:'RSA-OAEP-SHA256+AES-256-GCM',wrappedKey:publicEncrypt({key:process.env.EVIDENCE_PUBLIC_KEY,oaepHash:'sha256'},key).toString('base64'),nonce:nonce.toString('base64'),aad:aad.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));flush();rmSync(root,{recursive:true,force:true});
}
