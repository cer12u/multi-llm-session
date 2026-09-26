// Explicit real-model diagnosis. Public output is aggregate only; no product code is replaced.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createHash,randomBytes,createCipheriv,publicEncrypt} from 'node:crypto';
import {spawn} from 'node:child_process';
import {modelRequest,parseOutput} from '../../packages/models/index.ts';
import {ModelProfileSchema} from '../../packages/contracts/index.ts';
const engine=process.env.ENGINE,model=process.env.MODEL_NAME,temp=process.env.RUNNER_TEMP;
if(!['llama-cpp','ollama-long'].includes(engine)||!model||!temp)throw new Error('EXPLICIT_EXPERIMENT_ENV_REQUIRED');
const source=JSON.parse(readFileSync(join(temp,'replay-request.json'),'utf8'));
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const expectedMessages='3659fa6413485264c44ecb26ba6caf72c64274a73ce86f1de2418b561ae4fe6e';
if(hash(source.messages)!==expectedMessages)throw new Error('INPUT_CHANGED');
const profile=ModelProfileSchema.parse({id:'engine-evaluation',provider:engine==='llama-cpp'?'openai':'ollama',model,
 baseUrl:engine==='llama-cpp'?'http://127.0.0.1:18080/v1':'http://127.0.0.1:11434/api',allowLocalHttp:true,authRequired:false,
 jsonMode:'json',maxOutputTokens:512,temperature:0.4,maxConcurrent:1,contextWindowTokens:49152});
const context=JSON.parse(source.messages.find(m=>m.role==='user').content);
const body=modelRequest(profile,'decide',context,{maxChars:24000});
if(hash(body.messages)!==expectedMessages)throw new Error('BUILDER_INPUT_CHANGED');
body.stream=true;
if(engine==='llama-cpp'){body.stream_options={include_usage:true};body.cache_prompt=false;}
else body.options={...body.options,num_ctx:49152};
const out='artifacts/engine-comparison';mkdirSync(out,{recursive:true});
const report={sourceSha:process.env.GITHUB_SHA,applicationMain:'237f87e207e61dae4e973ce279896bf4e14bd738',engine,model,
 messagesHash:hash(body.messages),requestHash:hash(body),requestBytes:Buffer.byteLength(JSON.stringify(body)),
 limits:{requestMs:900000,outputTokens:512,context:49152,directRequests:1},
 status:'STARTED',httpStatus:null,headersMs:null,firstContentMs:null,firstThinkingMs:null,contentChunks:0,contentBytes:0,thinkingBytes:0,
 finishReason:null,usage:null,timings:null,elapsedMs:null,parseStatus:'NOT_EVALUATED',schemaStatus:'NOT_EVALUATED',
 paidInference:false,syntheticModel:false,applicationE2E:false,humanReviewed:false,semanticAcceptance:'NOT_EVALUATED'};
const privateEvidence={direct:null,application:null};
const save=()=>writeFileSync(join(out,'direct-result.json'),JSON.stringify(report,null,2));
const start=performance.now(),elapsed=()=>Math.round((performance.now()-start)*1000)/1000;
let content='',buffer='',last=null,received=0;
function piece(o){
 if(o.error)throw new Error('MODEL_ERROR');last=o;
 const choice=o.choices?.[0],text=engine==='llama-cpp'?choice?.delta?.content:o.message?.content;
 const thinking=engine==='llama-cpp'?choice?.delta?.reasoning_content:o.message?.thinking;
 if(typeof text==='string'&&text){report.firstContentMs??=elapsed();report.contentChunks++;content+=text;report.contentBytes+=Buffer.byteLength(text);}
 if(typeof thinking==='string'&&thinking){report.firstThinkingMs??=elapsed();report.thinkingBytes+=Buffer.byteLength(thinking);}
 if(choice?.finish_reason)report.finishReason=choice.finish_reason;
 if(o.done)report.finishReason=o.done_reason??'stop';
 if(o.usage)report.usage={inputTokens:o.usage.prompt_tokens??null,outputTokens:o.usage.completion_tokens??null};
 if(o.prompt_eval_count!==undefined)report.usage={inputTokens:o.prompt_eval_count,outputTokens:o.eval_count??null};
 if(o.timings)report.timings=o.timings;
 if(o.total_duration!==undefined)report.timings={loadMs:o.load_duration/1e6,promptEvalMs:o.prompt_eval_duration/1e6,outputEvalMs:o.eval_duration/1e6,totalMs:o.total_duration/1e6};
}
// Node http is used here so fetch/Undici's separate headers timeout cannot silently
// shorten the explicitly authorized 900-second wall-clock diagnostic deadline.
await new Promise(resolve=>{
 let settled=false;const done=(status)=>{if(settled)return;settled=true;report.status=status;clearTimeout(timer);clearInterval(progress);resolve();};
 const url=new URL(engine==='llama-cpp'?'http://127.0.0.1:18080/v1/chat/completions':'http://127.0.0.1:11434/api/chat');
 const payload=JSON.stringify(body);
 const req=httpRequest(url,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
  report.httpStatus=res.statusCode;report.headersMs=elapsed();if(res.statusCode!==200){res.resume();done('HTTP_'+res.statusCode);return;}
  res.setEncoding('utf8');
  res.on('data',chunk=>{try{received+=Buffer.byteLength(chunk);if(received>1048576)throw new Error('BYTE_LIMIT');buffer+=chunk;let at;
   while((at=buffer.indexOf('\n'))>=0){let line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;
    if(engine==='llama-cpp'){if(!line.startsWith('data:'))continue;line=line.slice(5).trim();if(line==='[DONE]')continue;}
    piece(JSON.parse(line));}
  }catch{req.destroy();done('INVALID_OR_OVERSIZE_RESPONSE');}});
  res.on('end',()=>{if(buffer.trim()&&engine==='ollama-long')try{piece(JSON.parse(buffer));}catch{done('INVALID_RESPONSE');return;}done(report.finishReason?'COMPLETED':'INCOMPLETE');});
  res.on('error',()=>done('RESPONSE_ERROR'));
 });
 const timer=setTimeout(()=>{req.destroy();done('TIMEOUT');},900000);
 const progress=setInterval(()=>{save();console.log(JSON.stringify({engine,elapsedMs:elapsed(),httpStatus:report.httpStatus,firstContentMs:report.firstContentMs,contentBytes:report.contentBytes,thinkingBytes:report.thinkingBytes}));},60000);
 req.on('error',()=>done('TRANSPORT_ERROR'));req.end(payload);
});
report.elapsedMs=elapsed();report.outputHash=hash(content);
if(content){try{JSON.parse(content.trim().replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```$/,''));report.parseStatus='VALID';}catch{report.parseStatus='INVALID';}
 try{const parsed=parseOutput('decide',content,false);report.schemaStatus='VALID';report.action=parsed.action?.decision??parsed.decision??null;}catch{report.schemaStatus='INVALID';}}
privateEvidence.direct={request:body,content,result:report};save();console.log(JSON.stringify(report));
// A successful transport is followed by the actual existing product CLI/Core/three
// Worker/SQLite path. The product's existing 180s request limit is NOT changed here.
if(engine==='llama-cpp'&&report.status==='COMPLETED'){
 const names=['ソラ','ナギ','リン'],traits=['気になる点を具体的に考える。','実用性と使いやすさを重視する。','楽しい工夫や雰囲気を考える。'];
 const manifest={schemaVersion:1,approvedCommit:process.env.GITHUB_SHA,evidenceMode:'live',purpose:'smoke',scenario:'native-engine-reading-room',
  initialText:context.messages.find(m=>m.authorId===null).text,profiles:[profile],
  characters:names.map((name,i)=>({schemaVersion:1,id:'native-'+i,version:1,name,persona:traits[i]+'日本語で自然に短く話す。他者の発言を読み、必要なら意見を変える。話す必要がなければ沈黙する。',presentationRef:null})),
  participants:names.map((_,i)=>({slot:'worker-'+i,profileId:profile.id,characterId:'native-'+i})),
  bounds:{maxCalls:18,maxPosts:6,durationMs:600000,maxOutputTokens:512,maxTokens:2000000},quietStopMs:10000,
  settings:{selfWakeEnabled:false,idleMs:60000,requestTimeoutMs:180000,leaseMs:120000,maxRetries:0,memoryEvery:3,memoryFlushMs:15000,memoryShareEvery:3,contextMessages:8,contextChars:24000,contextTokens:49152,debounceMs:0,directedDebounceMs:0,maxCoalesceMs:0}};
 const file=join(temp,'native-manifest.json'),dir=join(temp,'native-session');writeFileSync(file,JSON.stringify(manifest),{mode:0o600,flag:'wx'});
 const code=await new Promise(resolve=>{const child=spawn(process.execPath,['--import','tsx','apps/cli/experiment.ts','execute',file,dir],{env:{...process.env,ALLOW_LIVE_MODELS:'1'},stdio:'ignore'});let kill;
  const timer=setTimeout(()=>{child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),20000);},680000);
  child.once('error',()=>{clearTimeout(timer);resolve(-1);});child.once('exit',code=>{clearTimeout(timer);clearTimeout(kill);resolve(code??-1);});});
 const read=(name)=>existsSync(join(dir,name))?JSON.parse(readFileSync(join(dir,name),'utf8')):null;
 const result=read('result.json'),failure=read('failure.json');let runStates=[],errors=[],posts=[],states=[],memories=[];
 if(existsSync(join(dir,'session.sqlite'))){const {default:Database}=await import('better-sqlite3');const db=new Database(join(dir,'session.sqlite'),{readonly:true,fileMustExist:true});try{
  runStates=db.prepare("SELECT agent_id AS agentId,kind,state,json_extract(result_json,'$.code') AS code,COUNT(*) AS count FROM runs GROUP BY agent_id,kind,state,code").all();
  errors=db.prepare('SELECT error_code AS code,COUNT(*) AS count FROM llm_calls WHERE error_code IS NOT NULL GROUP BY error_code').all();
  posts=db.prepare('SELECT author_id,text,reply_to FROM messages WHERE author_id IS NOT NULL').all();
  states=db.prepare('SELECT agent_id,version,entries_json FROM agent_private_states').all();memories=db.prepare('SELECT agent_id,text FROM memories').all();
 }finally{db.close();}}
 const app={engine,sourceSha:process.env.GITHUB_SHA,mode:'real-cli-core-three-workers-http-sqlite',exitCode:code,execution:result?.status??failure?.status??'NO_RESULT',exitReason:result?.exitReason??null,
  elapsedMs:result?.elapsedMs??null,modelCalls:result?.modelCalls??null,calls:result?.usage?.calls??[],byAgent:result?.usage?.byAgent??[],runStates,errors,
  publicPosts:posts.length,publicAuthors:new Set(posts.map(p=>p.author_id)).size,nonemptyPrivateStates:states.filter(s=>JSON.parse(s.entries_json).length).length,memories:memories.length,
  applicationRequestTimeoutMs:180000,paidInference:false,humanReviewed:false,semanticAcceptance:'NOT_EVALUATED'};
 privateEvidence.application={manifest,result,failure,posts,states,memories};writeFileSync(join(out,'application-result.json'),JSON.stringify(app,null,2));console.log(JSON.stringify(app));
}
const key=randomBytes(32),nonce=randomBytes(12),aad=Buffer.from(process.env.GITHUB_RUN_ID+':'+process.env.GITHUB_SHA+':'+engine),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
const encrypted=Buffer.concat([cipher.update(JSON.stringify(privateEvidence),'utf8'),cipher.final()]);
writeFileSync(join(out,'private-evidence.enc.json'),JSON.stringify({algorithm:'RSA-OAEP-SHA256+AES-256-GCM',wrappedKey:publicEncrypt({key:process.env.EVIDENCE_PUBLIC_KEY,oaepHash:'sha256'},key).toString('base64'),nonce:nonce.toString('base64'),aad:aad.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}));
