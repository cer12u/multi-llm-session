import {test,expect,type Page} from '@playwright/test';
import {createServer,type Server} from 'node:http';
import {resolve} from 'node:path';
import {fixture} from '../helpers.js';
import {buildServer} from '../../apps/core/server.js';
import {CoreClient,WorkerRuntime} from '../../apps/agent-worker/runtime.js';
import {submitLogin} from './login-submit.js';

type Captured={path:string;authorization:string;body:{model:string;messages:{role:string;content:string}[];max_completion_tokens?:number;options?:{num_predict:number}}};
async function provider(index:number){
  const requests:Captured[]=[];let unauthorized=index===0;
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({path:req.url??'',authorization:req.headers.authorization??'',body});
    res.setHeader('content-type','application/json');
    if(unauthorized){res.statusCode=401;res.end(JSON.stringify({error:'synthetic unauthorized'}));return;}
    const text=JSON.stringify({type:'result',action:{decision:'ABSTAIN',reason:'synthetic independent provider response'},state:null});
    res.end(JSON.stringify(index===1?{done:true,message:{content:text},prompt_eval_count:17,eval_count:9}:{choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:17,completion_tokens:9}}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing provider port');
  const url=`http://127.0.0.1:${address.port}/${index===1?'api':'v1'}`;
  // This harness explicitly opts in only to its own loopback fixtures, never a real model endpoint.
  if(new URL(url).hostname!=='127.0.0.1')throw new Error('NONLOCAL_TEST_PROVIDER');
  return {server,url,requests,recover:()=>{unauthorized=false;}};
}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
async function login(page:Page,base:string,token:string,viewer=false){await page.goto(base);await page.getByLabel('ログイントークン').fill(token);await submitLogin(page,viewer?'閲覧者':'管理者');}
async function manager(page:Page){
  const menu=page.getByRole('button',{name:'セッション一覧を開く'});
  if(await menu.isVisible()&&!(await page.locator('.session-sidebar').isVisible()))await menu.click();
  await page.getByRole('button',{name:'モデルを管理',exact:true}).click();return page.getByRole('dialog',{name:'モデルを管理',exact:true});
}

test('R8-UI-001: profiles created in the real editor route A/B/C independently and exact-version recovery does not redirect the frozen session',async({page})=>{
  test.setTimeout(90000);
  const f=fixture(),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')}),providers=await Promise.all([0,1,2].map(provider));
  try{
    f.config.allowLive=true;await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    await login(page,base,f.config.adminToken);let dialog=await manager(page);
    for(let i=0;i<3;i++){
      await dialog.getByRole('button',{name:'新規モデル設定',exact:true}).click();
      await dialog.getByLabel('モデル設定ID',{exact:true}).fill('synthetic-ui-'+i);
      await dialog.getByLabel('API方式',{exact:true}).selectOption(i===1?'ollama':'openai');
      await dialog.getByLabel('モデルID',{exact:true}).fill('synthetic-model-'+i);
      await dialog.getByLabel('Base URL',{exact:true}).fill(providers[i].url);
      await dialog.getByLabel('APIキーの環境変数参照',{exact:true}).fill('SYNTHETIC_UI_KEY_'+i);
      await dialog.getByLabel('ローカルHTTPを明示的に許可',{exact:true}).check();
      if(i===0)await dialog.getByLabel('出力tokenパラメータ',{exact:true}).selectOption('max_completion_tokens');
      await dialog.getByRole('button',{name:'モデル設定を新しい版で保存',exact:true}).click();
      await expect(dialog.getByRole('status')).toContainText(`synthetic-ui-${i} v1`);
      await expect(dialog.getByLabel('モデル設定の参照版',{exact:true})).toHaveValue('1');
    }
    await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
    expect(providers.every(p=>p.requests.length===0)).toBe(true);
    await page.getByRole('button',{name:'新しいセッション',exact:true}).first().click();
    const create=page.getByRole('dialog',{name:'新しいセッション',exact:true});await create.getByLabel('セッション名').fill('three isolated HTTP providers');
    for(let i=0;i<3;i++)await create.locator('.member-fields fieldset').nth(i).getByRole('combobox').nth(1).selectOption('synthetic-ui-'+i);
    await create.getByRole('button',{name:'セッションを作成',exact:true}).click();await expect(page.locator('.channel-title h1')).toContainText('three isolated HTTP providers');
    const id=new URL(page.url()).searchParams.get('session')!;expect(id).toBeTruthy();const agents=f.service.agents(id);
    const workers=agents.map((a,i)=>new WorkerRuntime(new CoreClient(base,f.config.workerTokens[a.slot]),{ALLOW_LIVE_MODELS:'1',['SYNTHETIC_UI_KEY_'+i]:'synthetic-key-value-'+i}));
    await Promise.all(workers.map(w=>w.register()));await page.getByRole('button',{name:'開始',exact:true}).click();
    await expect(page.getByRole('button',{name:'一時停止',exact:true})).toBeVisible();await Promise.all(workers.map(w=>w.once()));
    for(let i=0;i<3;i++){
      expect(providers[i].requests).toHaveLength(1);const sent=providers[i].requests[0];
      expect(sent.path).toBe(i===1?'/api/chat':'/v1/chat/completions');expect(sent.authorization).toBe('Bearer synthetic-key-value-'+i);expect(sent.body.model).toBe('synthetic-model-'+i);
      const context=JSON.parse(sent.body.messages.find(m=>m.role==='user')!.content),character=JSON.parse(agents[i].character_json);
      expect(context.self.name).toBe(character.name);expect(context.self.persona).toBe(character.persona);expect(JSON.stringify(context)).not.toContain(agents[i].id);
    }
    expect(providers[0].requests[0].body.max_completion_tokens).toBe(768);expect(providers[1].requests[0].body.options?.num_predict).toBe(768);
    expect(f.service.session(id).call_count).toBe(3);expect(f.service.session(id).bot_count).toBe(0);
    dialog=await manager(page);await dialog.locator('.provider-catalog button').filter({hasText:'synthetic-ui-0'}).click();
    await dialog.getByLabel('モデルID',{exact:true}).fill('new-not-applied-model');await dialog.getByRole('button',{name:'モデル設定を新しい版で保存',exact:true}).click();
    await expect(dialog.getByRole('status')).toContainText('synthetic-ui-0 v2');await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.getByRole('button',{name:'セッション設定',exact:true}).click();await page.getByRole('button',{name:'診断',exact:true}).click();
    const status=page.locator(`[data-operation-agent="${agents[0].id}"]`);
    await expect(status.locator('.operation-reason')).toContainText('Provider認証エラー');await expect(status).toContainText('synthetic-ui-0 v1 ／ 最新 v2');
    await expect(status).toContainText('synthetic-model-0');expect(await page.locator('body').innerText()).not.toContain('synthetic-key-value-');
    providers[0].recover();page.once('dialog',dialog=>void dialog.accept());
    const retried=page.waitForResponse(r=>r.url().endsWith('/v1/model-profiles/synthetic-ui-0/versions/1/retry'));
    await status.getByRole('button',{name:'固定版のProviderを再試行',exact:true}).click();expect((await retried).ok()).toBe(true);
    await workers[0].once();expect(providers[0].requests).toHaveLength(2);expect(providers[0].requests[1].body.model).toBe('synthetic-model-0');
    expect(providers[1].requests).toHaveLength(1);expect(providers[2].requests).toHaveLength(1);expect(f.service.session(id).call_count).toBe(4);
    await expect(status.locator('.operation-reason')).toContainText('本人は静かに待機中');
    page.once('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'診断から一時停止',exact:true}).click();await expect(status.locator('.operation-reason')).toContainText('人間の操作で一時停止');
    const before=f.service.session(id).call_count;await page.reload();expect(f.service.session(id).call_count).toBe(before);
  }finally{await app.close();f.close();await Promise.all(providers.map(p=>close(p.server)));}
});

test('R8-UI-002: mobile management persists configuration without inference; logout/viewer mode hides private provider controls',async({page})=>{
  const f=fixture(),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  try{
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;await page.setViewportSize({width:390,height:844});
    await login(page,base,f.config.adminToken);const dialog=await manager(page);
    await dialog.getByLabel('モデル設定ID',{exact:true}).fill('mobile-fixture');await dialog.getByLabel('モデルID',{exact:true}).fill('mobile-fixture-model');
    await dialog.getByLabel('Base URL',{exact:true}).fill('https://synthetic.invalid/v1');await dialog.getByRole('button',{name:'モデル設定を新しい版で保存',exact:true}).click();
    await expect(dialog.getByRole('status')).toContainText('mobile-fixture v1');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(f.service.modelProfiles().some(p=>p.id==='mobile-fixture')).toBe(true);expect(f.service.session(f.id).call_count).toBe(0);
    await dialog.getByRole('button',{name:'閉じる',exact:true}).click();await page.getByRole('button',{name:'セッション一覧を開く'}).click();await page.getByRole('button',{name:'ログアウト',exact:true}).click();
    await expect(page.getByLabel('ログイントークン')).toBeVisible();await login(page,base,f.config.viewerToken!,true);await page.getByRole('button',{name:'セッション一覧を開く'}).click();
    await expect(page.getByRole('button',{name:'モデルを管理',exact:true})).toHaveCount(0);await expect(page.locator('.operations-panel')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('MODEL_API_KEY');expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
