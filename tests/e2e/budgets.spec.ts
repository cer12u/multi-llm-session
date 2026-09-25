import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startCluster} from '../../apps/cli/cluster.js';
import {ReplayStream} from '../../packages/observability/replay.js';
import {submitLogin} from './login-submit.js';

// The application is not stubbed: browser/CLI/HTTP -> real Core + three OS Worker processes -> HTTP provider -> SQLite.
test('R8-BUDGET-E2E: reservations, unknown usage, shared scope, renewal, real restart and human pause preserve the conversation',async({page})=>{
  test.setTimeout(120000);
  const directory=mkdtempSync(join(tmpdir(),'budget-e2e-'));let reported=false,requests=0;
  const provider=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const request=JSON.parse(Buffer.concat(chunks).toString()),context=JSON.parse(request.messages.find((m:{role:string})=>m.role==='user').content);
    const system=request.messages[0].content as string;requests++;
    await new Promise(resolve=>setTimeout(resolve,context.self.character.id==='rin'?50:10));
    const state=context.self.privateState,source=context.messages.find((m:{deleted:boolean})=>!m.deleted);
    const output=system.includes('Process exactly the supplied unprocessed delivery window')?{notes:source?[{text:'Retained synthetic evidence',sourceMessageIds:[source.id]}]:[]}:
      {action:{decision:'ABSTAIN',reason:'independent quiet'},statePatch:{agentId:state.agentId,sessionId:state.sessionId,expectedVersion:state.version,observationId:context.observation.id,
        upsert:[{id:'held',kind:'interest',text:'SYNTHETIC_RETAINED_BUDGET_INTEREST',evidence:[],resume:null}],remove:[]}};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],...reported?{usage:{prompt_tokens:17,completion_tokens:9}}:{}}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerPort=(provider.address() as {port:number}).port;
  const portServer=createServer();await new Promise<void>(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=(portServer.address() as {port:number}).port;await new Promise<void>(resolve=>portServer.close(()=>resolve()));
  const base=`http://127.0.0.1:${port}`,admin='synthetic-budget-admin-token-000000000000',viewer='synthetic-budget-viewer-token-00000000000';
  const config=join(directory,'config.json');writeFileSync(config,JSON.stringify({profiles:[{id:'budget-http',provider:'openai',model:'synthetic',baseUrl:`http://127.0.0.1:${providerPort}/v1`,allowLocalHttp:true,authRequired:false,maxOutputTokens:128,jsonMode:'json',maxConcurrent:3}]}));
  const env:NodeJS.ProcessEnv={...process.env,APP_CONFIG:config,PORT:String(port),PUBLIC_ORIGIN:base,ADMIN_TOKEN:admin,VIEWER_TOKEN:viewer,DB_PATH:join(directory,'session.sqlite'),ALLOW_LIVE_MODELS:'1',RESTART_POLICY:'paused'};
  delete env.MODEL_PROVIDER;delete env.MODEL_NAME;delete env.MODEL_BASE_URL;delete env.LLM_API_KEY;
  let cluster:Awaited<ReturnType<typeof startCluster>>|undefined;
  const api=async(path:string,body?:unknown,token=admin)=>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('E2E_HTTP_'+response.status+'_'+await response.text());return response.json();
  };
  const snapshot=async(id:string)=>api(`/v1/sessions/${id}/snapshot`),usage=async(id:string)=>api(`/v1/sessions/${id}/usage`);
  const policy=async(id:string,value:unknown)=>api(`/v1/sessions/${id}/budget-policy`,{expectedEpoch:(await snapshot(id)).session.epoch,policy:value});
  try{
    cluster=await startCluster(env,true);const caps=await api('/v1/capabilities'),characters=await api('/v1/characters');
    const settings={...caps.defaults,selfWakeEnabled:false,idleMs:60000,memoryEvery:3,memoryShareEvery:3,debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0,maxCalls:1000,maxMessages:100,maxDurationMs:120000};
    const {id}=await api('/v1/sessions',{title:'Budget application acceptance',participants:caps.slots.map((slot:string,i:number)=>({slot,characterId:characters[i].id,profileId:'budget-http'})),settings});
    for(let i=0;i<3;i++)await api(`/v1/sessions/${id}/messages`,{text:'preserved original '+i});
    const originalIds=(await snapshot(id)).messages.map((m:{id:string})=>m.id),owners=(await snapshot(id)).agents.map((a:{id:string})=>a.id);
    await policy(id,{mode:'experiment',windowMs:86400000,autoRenew:false,maxTokens:1,scopeMaxCalls:null,scopeMaxTokens:null});await api(`/v1/sessions/${id}/start`,{});
    await expect.poll(async()=>(await snapshot(id)).session.stopReason).toBe('MAX_TOKENS');expect(requests).toBe(0);expect((await usage(id)).window.tokens).toBe(0);
    await policy(id,{mode:'experiment',windowMs:86400000,autoRenew:false,maxTokens:300000,scopeMaxCalls:3,scopeMaxTokens:null});await api(`/v1/sessions/${id}/budget`,{});await api(`/v1/sessions/${id}/resume`,{});
    await expect.poll(async()=>(await snapshot(id)).session.stopReason).toBe('SCOPE_MAX_CALLS');expect(requests).toBeLessThanOrEqual(3);
    await expect.poll(async()=>(await usage(id)).calls.reduce((n:number,c:{inflight:number})=>n+c.inflight,0)).toBe(0);
    const unknown=await usage(id);expect(unknown.calls.reduce((n:number,c:{calls:number})=>n+c.calls,0)).toBe(3);expect(unknown.window.tokens).toBeGreaterThan(0);
    expect(unknown.calls.every((c:{reportedInput:number|null;missingInput:number})=>c.reportedInput===null&&c.missingInput>0)).toBe(true);
    const beforeQueued=requests;const queued=await api(`/v1/sessions/${id}/messages`,{text:'new input while the budget remains paused'});originalIds.push(queued.id);
    expect((await snapshot(id)).session.activity).toBe('BUDGET_PAUSED');expect(requests).toBe(beforeQueued);
    // Configure through the real production form, rather than writing a service field or test-only API.
    await page.goto(base+'/?session='+id);await page.getByLabel('ログイントークン').fill(admin);await submitLogin(page,'管理者');
    await page.getByRole('button',{name:'セッション設定',exact:true}).click();await page.getByRole('button',{name:'診断',exact:true}).click();const panel=page.getByRole('region',{name:'運用予算と消費量'});
    await panel.getByLabel('窓のtoken上限',{exact:true}).fill('10000000');await panel.getByLabel('認証scopeの呼出上限',{exact:true}).fill('');
    await panel.getByRole('button',{name:'予算方針を保存',exact:true}).click();await expect(panel.getByRole('status')).toContainText('保存済み');
    expect((await snapshot(id)).session.calls).toBe(3);reported=true;
    page.once('dialog',dialog=>void dialog.accept());await panel.getByRole('button',{name:'予算を明示更新',exact:true}).click();await expect(panel.getByRole('status')).toContainText('再開は別操作');
    await page.getByRole('button',{name:'再開',exact:true}).click();
    await expect.poll(async()=>(await api(`/v1/sessions/${id}/diagnostics`)).agents.every((a:{inputProgress:{memoryPending:number}})=>a.inputProgress.memoryPending===0)).toBe(true);
    const known=await usage(id);expect(known.calls.some((c:{reportedInput:number|null})=>(c.reportedInput??0)>0)).toBe(true);
    await api(`/v1/sessions/${id}/pause`,{});
    const saved=await usage(id),callsBefore=requests;
    const response=await fetch(base+`/v1/sessions/${id}/diagnostic-export`,{headers:{authorization:'Bearer '+admin}});expect(response.ok).toBe(true);
    const replay=new ReplayStream();for(const line of (await response.text()).trimEnd().split('\n'))replay.push(line);const before=replay.finish();
    expect(before.state.find(t=>t.table==='budget_windows')!.rows.length).toBeGreaterThanOrEqual(3);
    expect(before.state.find(t=>t.table==='memories')!.rows.length).toBeGreaterThanOrEqual(3);
    await cluster.stop();cluster=await startCluster(env,true);
    expect((await usage(id)).window).toEqual(saved.window);expect((await snapshot(id)).agents.map((a:{id:string})=>a.id)).toEqual(owners);
    expect((await snapshot(id)).messages.map((m:{id:string})=>m.id)).toEqual(originalIds);expect(requests).toBe(callsBefore);
    await policy(id,{mode:'continuous',windowMs:1000,autoRenew:true,maxTokens:10000000,scopeMaxCalls:null,scopeMaxTokens:null});
    await api(`/v1/sessions/${id}/budget`,{});await api(`/v1/sessions/${id}/resume`,{});const firstWindow=(await usage(id)).window.id;
    await expect.poll(async()=>(await usage(id)).window.id).not.toBe(firstWindow);
    await api(`/v1/sessions/${id}/pause`,{});const stopped=(await snapshot(id)).session.calls;
    await new Promise(resolve=>setTimeout(resolve,1800));expect((await snapshot(id)).session).toMatchObject({lifecycle:'PAUSED',stopReason:'USER_PAUSED',calls:stopped});
    const forbidden=await fetch(base+`/v1/sessions/${id}/usage`,{headers:{authorization:'Bearer '+viewer}});expect(forbidden.status).toBe(403);
    mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/budget-e2e.json',JSON.stringify({mode:'synthetic-http-e2e',independentWorkerProcesses:3,missingUsageCharged:true,simultaneousScopeLimit:3,restartPreserved:true,humanPausePreserved:true,final:await usage(id)},null,2));
    await api(`/v1/sessions/${id}/end`,{});
  }finally{await cluster?.stop();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});
