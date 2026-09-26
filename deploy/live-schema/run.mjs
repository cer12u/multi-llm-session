// Explicitly authorized real-model E2E: source CLI -> Core -> 3 OS Workers ->
// unmodified model HTTP messages (observed by a loopback proxy) -> real SQLite.
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createCipheriv,publicEncrypt,createPublicKey,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {parseOutput} from '../../packages/models/index.ts';
const temp=process.env.RUNNER_TEMP,sha=process.env.GITHUB_SHA,model=process.env.MODEL_NAME;
if(!temp||!sha||!model||process.env.ALLOW_LIVE_MODELS!=='1')throw new Error('EXPLICIT_LIVE_ENV_REQUIRED');
const publicKey=createPublicKey(process.env.EVIDENCE_PUBLIC_KEY);
const dir=join(temp,'schema-session'),manifestFile=join(temp,'schema-manifest.json'),out='artifacts/live-schema';
mkdirSync(out,{recursive:true});
const records=[],pending=new Set();let child;
const started=Date.now(),fingerprint=x=>createHash('sha256').update(x).digest('hex');
const proxy=createServer(async(req,res)=>{
  const chunks=[];let bytes=0;
  for await(const c of req){bytes+=c.length;if(bytes>131072){res.writeHead(413).end();return;}chunks.push(c);}
  const payload=Buffer.concat(chunks),body=JSON.parse(payload),context=JSON.parse(body.messages.find(m=>m.role==='user').content);
  const system=body.messages[0].content;
  const kind=system.includes('Process exactly the supplied unprocessed delivery window')?'memory':system.includes('Write only your own proposed utterance')?'draft':system.includes('Read the new context and delta')?'review':system.includes('Observe only the supplied delivery window')?'observe':'decide';
  const record={kind,owner:context.self.id,startedMs:Date.now()-started,requestHash:fingerprint(payload),requestBytes:bytes,formatSchema:typeof body.format==='object',request:body,response:null,summary:null};records.push(record);
  const at=Date.now(),received=[];let count=0;
  const upstream=httpRequest('http://127.0.0.1:11434'+req.url,{method:'POST',headers:{'content-type':'application/json','content-length':payload.length}},reply=>{
    res.writeHead(reply.statusCode,reply.headers);
    reply.on('data',chunk=>{count+=chunk.length;if(count>1048576){upstream.destroy();res.destroy();return;}received.push(chunk);res.write(chunk);});
    reply.on('end',()=>{
      const text=Buffer.concat(received).toString('utf8');let raw;try{raw=JSON.parse(text);}catch{}
      record.response=raw??text;let schemaStatus='NOT_EVALUATED';
      if(raw?.message?.content)try{parseOutput(kind,raw.message.content,true);schemaStatus='VALID';}catch{schemaStatus='INVALID';}
      record.summary={kind,owner:record.owner,requestBytes:bytes,formatSchema:record.formatSchema,httpStatus:reply.statusCode,elapsedMs:Date.now()-at,schemaStatus,finishReason:raw?.done_reason??null,inputTokens:raw?.prompt_eval_count??null,outputTokens:raw?.eval_count??null,promptEvalMs:raw?.prompt_eval_duration?raw.prompt_eval_duration/1e6:null,outputEvalMs:raw?.eval_duration?raw.eval_duration/1e6:null};
      res.end();
    });
    reply.on('error',()=>res.destroy());
  });
  pending.add(upstream);upstream.setTimeout(920000,()=>upstream.destroy());
  upstream.on('error',()=>{record.summary??={kind,owner:record.owner,elapsedMs:Date.now()-at,error:'TRANSPORT_OR_CANCELLATION'};if(!res.headersSent)res.writeHead(502);res.end();});
  upstream.on('close',()=>pending.delete(upstream));
  res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});upstream.end(payload);
});
await new Promise(resolve=>proxy.listen(11435,'127.0.0.1',resolve));
const names=['ソラ','ナギ','リン'],traits=['気になる点を具体的に考える。','実用性と使いやすさを重視する。','楽しい工夫や雰囲気を考える。'];
const manifest={schemaVersion:1,approvedCommit:sha,evidenceMode:'live',purpose:'smoke',scenario:'real-schema-three-workers',
 initialText:'架空の小さな読書室を作るなら、どんな場所にしたい？静かに読む人と、感想を少し話したい人の両方が過ごせるといいと思う。',
 profiles:[{id:'schema-local',provider:'ollama',model,baseUrl:'http://127.0.0.1:11435/api',authRequired:false,allowLocalHttp:true,jsonMode:'schema',maxOutputTokens:768,temperature:0.2,maxConcurrent:1,contextWindowTokens:65536}],
 characters:names.map((name,i)=>({schemaVersion:1,id:'schema-'+i,version:1,name,persona:traits[i]+'日本語で自然に短く話す。他者の発言を読み、必要なら意見を変える。話す必要がなければ沈黙する。',presentationRef:null})),
 participants:names.map((_,i)=>({slot:'worker-'+i,profileId:'schema-local',characterId:'schema-'+i})),
 bounds:{maxCalls:12,maxPosts:3,durationMs:2700000,maxOutputTokens:768,maxTokens:3000000},quietStopMs:10000,
 settings:{requestTimeoutMs:900000,leaseMs:30000,maxRetries:0,selfWakeEnabled:false,idleMs:86400000,memoryEvery:3,memoryFlushMs:30000,memoryShareEvery:3,contextMessages:8,contextChars:24000,contextTokens:65536,debounceMs:0,directedDebounceMs:0,maxCoalesceMs:0}};
writeFileSync(manifestFile,JSON.stringify(manifest),{flag:'wx',mode:0o600});
const read=name=>existsSync(join(dir,name))?JSON.parse(readFileSync(join(dir,name),'utf8')):null;
function inspect(){
 if(!existsSync(join(dir,'session.sqlite')))return null;
 const db=new Database(join(dir,'session.sqlite'),{readonly:true,fileMustExist:true});
 try{return {runs:db.prepare("SELECT agent_id AS agentId,kind,state,json_extract(result_json,'$.code') AS code,COUNT(*) AS count FROM runs GROUP BY agent_id,kind,state,code").all(),
  calls:db.prepare('SELECT status,error_code AS code,COUNT(*) AS count FROM llm_calls GROUP BY status,error_code').all(),
  messages:db.prepare('SELECT id,sequence,author_id,text,reply_to FROM messages ORDER BY sequence').all(),
  states:db.prepare('SELECT agent_id,version,entries_json FROM agent_private_states').all(),
  memories:db.prepare('SELECT id,agent_id,text FROM memories').all()};}finally{db.close();}
}
let code=-1;
try{
 code=await new Promise(resolve=>{
  child=spawn(process.execPath,['--import','tsx','apps/cli/experiment.ts','execute',manifestFile,dir],{env:process.env,stdio:'ignore'});
  let kill;const maximum=setTimeout(()=>{child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),20000);},2780000);
  const progress=setInterval(()=>{try{const data=inspect(),done=records.filter(r=>r.summary);console.log(JSON.stringify({elapsedMs:Date.now()-started,modelRequests:records.length,responses:done.map(r=>r.summary),runs:data?.runs??[]}));
   // No additional live retries when every owner has already failed and no work is active.
   if(data&&new Set(data.runs.filter(r=>r.state==='FAILED').map(r=>r.agentId)).size===3&&!data.runs.some(r=>r.state==='ACTIVE'))child.kill('SIGTERM');
  }catch{}},60000);
  child.once('error',()=>{clearTimeout(maximum);clearInterval(progress);resolve(-1);});
  child.once('exit',value=>{clearTimeout(maximum);clearTimeout(kill);clearInterval(progress);resolve(value??-1);});
 });
}finally{
 for(const req of pending)req.destroy();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
 const result=read('result.json'),failure=read('failure.json'),data=inspect(),posts=data?.messages.filter(m=>m.author_id!==null)??[];
 const report={sourceSha:sha,applicationBase:'237f87e207e61dae4e973ce279896bf4e14bd738',model,jsonMode:'schema',requestTimeoutMs:900000,leaseMs:30000,
  execution:result?.status??failure?.status??'NO_RESULT',exitCode:code,exitReason:result?.exitReason??null,failureCode:failure?.code??null,
  elapsedMs:result?.elapsedMs??Date.now()-started,bounds:manifest.bounds,requests:records.map(r=>r.summary??{kind:r.kind,owner:r.owner,incomplete:true}),
  runs:data?.runs??[],calls:result?.usage?.calls??data?.calls??[],byAgent:result?.usage?.byAgent??[],
  acceptedRuns:data?.runs.filter(r=>r.state==='DONE').reduce((n,r)=>n+r.count,0)??0,
  publicPosts:posts.length,publicAuthors:new Set(posts.map(p=>p.author_id)).size,privateStateOwners:data?.states.length??0,nonemptyPrivateStates:data?.states.filter(s=>JSON.parse(s.entries_json).length>0).length??0,memories:data?.memories.length??0,
  humanReviewed:false,semanticAcceptance:'NOT_EVALUATED',paidInference:false,actualProductProcesses:true,syntheticModel:false,plaintextPrivateDataPublished:false};
 writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 const key=randomBytes(32),nonce=randomBytes(12),aad=Buffer.from(process.env.GITHUB_RUN_ID+':'+sha),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({manifest,result,failure,records,data}),'utf8'),cipher.final()]);
 writeFileSync(join(out,'evidence.enc.json'),JSON.stringify({algorithm:'RSA-OAEP-SHA256+AES-256-GCM',wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),nonce:nonce.toString('base64'),aad:aad.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}));
 if(code!==0||report.acceptedRuns===0)process.exitCode=1;
}
