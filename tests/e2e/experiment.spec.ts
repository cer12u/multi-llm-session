import {test,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve as absolute} from 'node:path';

/** CLI -> production Core/three Worker processes -> real loopback HTTP -> private persisted result. */
test('R10-EXPERIMENT-E2E: preflight has no requests; an approved bounded run retains private evidence and rejects unsafe execution',async()=>{
  test.setTimeout(90000);
  const root=mkdtempSync(join(tmpdir(),'experiment-acceptance-')),owners=new Set<string>(),models=new Set<string>();let calls=0;
  const provider=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const input=JSON.parse(Buffer.concat(chunks).toString()),context=JSON.parse(input.messages.find((m:{role:string})=>m.role==='user').content);
    calls++;owners.add(context.self.id);models.add(input.model);
    const index=Number(String(input.model).split('-').at(-1));
    expect(req.headers.authorization).toBe('Bearer synthetic-experiment-key-'+index);
    const memory=input.messages[0].content.includes('Process exactly the supplied unprocessed delivery window');
    const state=context.self.privateState,original=context.messages.find((m:{deleted:boolean})=>!m.deleted);
    const output=memory?{notes:[]}:!context.retrieved&&original?{decision:'LOOKUP',requests:[{kind:'message',query:original.id,cursor:null}]}:
      {action:{decision:'ABSTAIN',reason:'synthetic quiet'},statePatch:{agentId:state.agentId,sessionId:state.sessionId,expectedVersion:state.version,observationId:context.observation.id,
        upsert:[{id:'retained',kind:'interest',text:'PRIVATE_EXPERIMENT_CANARY',evidence:[],resume:null}],remove:[]}};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{...index!==2?{prompt_tokens:19}:{},...index!==1?{completion_tokens:11}:{}}}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const port=(provider.address() as {port:number}).port;
  const approvedCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const profiles=Array.from({length:3},(_,i)=>({id:'profile-'+i,provider:'openai',model:'synthetic-'+i,baseUrl:`http://127.0.0.1:${port}/v1`,allowLocalHttp:true,authRequired:true,apiKeyEnv:'SYNTHETIC_EXPERIMENT_KEY_'+i,maxOutputTokens:512,jsonMode:'json'}));
  const characters=Array.from({length:3},(_,i)=>({schemaVersion:1,id:'character-'+i,version:1,name:'Synthetic '+i,persona:'Independent synthetic participant '+i,presentationRef:null}));
  const manifest={schemaVersion:1,approvedCommit,evidenceMode:'synthetic',purpose:'smoke',scenario:'transport-and-quiet',initialText:'A single initial synthetic topic',profiles,characters,
    participants:profiles.map((p,i)=>({slot:'worker-'+i,profileId:p.id,characterId:characters[i].id})),
    bounds:{maxCalls:30,maxPosts:5,durationMs:20000,maxOutputTokens:512,maxTokens:3000000},quietStopMs:1000,
    settings:{selfWakeEnabled:false,idleMs:60000,memoryEvery:3,memoryFlushMs:100,memoryShareEvery:1,debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0}};
  const file=join(root,'manifest.json'),output=join(root,'recording');
  const env={...process.env,...Object.fromEntries(profiles.map((p,i)=>[p.apiKeyEnv,'synthetic-experiment-key-'+i]))};
  const entry=absolute('apps/cli/experiment.ts'),loader=import.meta.resolve('tsx');
  const invoke=(args:string[],cwd=process.cwd())=>new Promise<{status:number;out:string;err:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',loader,entry,...args],{env,cwd,stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{err+=chunk;});
    const timer=setTimeout(()=>child.kill('SIGTERM'),45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({status:code??1,out,err});});
  });
  try{
    writeFileSync(file,JSON.stringify({...manifest,approvedCommit:'0'.repeat(40)}));
    const denied=await invoke(['execute',file,output]);expect(denied.status).toBe(2);expect(denied.out).toContain('APPROVED_COMMIT_MISMATCH');expect(calls).toBe(0);expect(existsSync(output)).toBe(false);
    // A different clean checkout must not lend its approved SHA to this executable.
    const foreign=join(root,'unrelated-checkout');mkdirSync(foreign);
    execFileSync('git',['init','--quiet',foreign]);
    execFileSync('git',['-C',foreign,'-c','user.name=Synthetic E2E','-c','user.email=e2e@example.invalid','commit','--allow-empty','--quiet','-m','unrelated approval fixture']);
    const foreignSha=execFileSync('git',['-C',foreign,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    writeFileSync(file,JSON.stringify({...manifest,approvedCommit:foreignSha}));
    const foreignDenied=await invoke(['execute',file,output],foreign);
    expect(foreignDenied.status,foreignDenied.err+foreignDenied.out).toBe(2);expect(foreignDenied.out).toContain('APPROVED_COMMIT_MISMATCH');expect(calls).toBe(0);
    writeFileSync(file,JSON.stringify(manifest));const ready=await invoke(['preflight',file],foreign);expect(ready.status,ready.err+ready.out).toBe(0);expect(JSON.parse(ready.out).status).toBe('READY');expect(calls).toBe(0);
    const run=await invoke(['execute',file,output],foreign);expect(run.status,run.err+run.out).toBe(0);
    expect(run.out).not.toContain('PRIVATE_EXPERIMENT_CANARY');expect(owners.size).toBe(3);expect(models.size).toBe(3);expect(calls).toBeLessThanOrEqual(manifest.bounds.maxCalls);
    const result=JSON.parse(readFileSync(join(output,'result.json'),'utf8'));
    expect(result).toMatchObject({status:'EXECUTED',evidenceMode:'synthetic',semanticAcceptance:'NOT_EVALUATED',humanReviewed:false,exitReason:'VOLUNTARY_QUIET'});
    expect(result.preflightNetworkCalls).toBe(0);expect(result.modelCalls).toBe(calls);expect(result.networkCalls).toBeUndefined();
    expect(new Set(result.usage.byAgent.map((r:{agentId:string})=>r.agentId))).toEqual(owners);
    expect(result.usage.byAgent.reduce((n:number,r:{calls:number})=>n+r.calls,0)).toBe(calls);
    const primary=result.usage.calls.find((r:{kind:string;stage:string})=>r.kind==='decide'&&r.stage==='primary');
    expect(primary.missingUsage).toBe(2);expect(primary.missingInput).toBe(1);expect(primary.missingOutput).toBe(1);
    expect(result.usage.recall.lookups).toBeGreaterThanOrEqual(3);expect(result.metrics.calls.some((r:{kind:string})=>r.kind==='memory')).toBe(true);
    expect(readFileSync(join(output,'private-recording.ndjson'),'utf8')).toContain('PRIVATE_EXPERIMENT_CANARY');
    expect(statSync(output).mode&0o077).toBe(0);expect(statSync(join(output,'private-recording.ndjson')).mode&0o077).toBe(0);
    expect(JSON.parse(readFileSync(join(output,'resources.json'),'utf8')).some((s:{processes:unknown[]})=>s.processes.length===4)).toBe(true);
    const before=calls,again=await invoke(['execute',file,output]);expect(again.status).not.toBe(0);expect(calls).toBe(before);
    mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/experiment-e2e.json',JSON.stringify({mode:'synthetic-http-e2e',owners:owners.size,calls,preflightNoSend:true,privateFiles:true,refusesOverwrite:true,executableCheckoutBound:true,perOwnerUsage:true,partialUsageCounted:true,semanticAcceptance:'NOT_EVALUATED'}));
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});
