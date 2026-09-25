import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {fixture} from '../helpers.js';
import {buildServer} from '../../apps/core/server.js';
import {submitLogin} from './login-submit.js';

// Test-owned loopback app and synthetic data only. No external URL is fetched.
test('R10-SEC-UI-001: untrusted speech is text, and a delayed private response cannot survive logout into viewer mode',async({page})=>{
  const f=fixture(),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  let release!:()=>void;
  const gate=new Promise<void>(done=>{release=done;});
  let captured!:()=>void;const requested=new Promise<void>(done=>{captured=done;});
  try{
    const attack='<img src=x onerror="window.__securityExecuted=true"><script>window.__securityExecuted=true</script>';
    f.say(attack);f.start();const run=f.claim()!,state=run.context.self.privateState!;
    f.finish(run,{action:{decision:'ABSTAIN',reason:'synthetic private state'},statePatch:{agentId:state.agentId,sessionId:f.id,expectedVersion:state.version,observationId:run.context.observation!.id,
      upsert:[{id:'private',kind:'interest',text:'SEC_LATE_PRIVATE_RESPONSE',evidence:[],resume:null}],remove:[]}});
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing test port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    await page.goto(base+'/?session='+f.id);await page.getByLabel('ログイントークン').fill(f.config.adminToken);await submitLogin(page,'管理者');
    await expect(page.locator('.timeline')).toContainText(attack);
    await expect(page.locator('.timeline img,.timeline script')).toHaveCount(0);
    expect(await page.evaluate(()=>Reflect.get(window,'__securityExecuted'))).toBeUndefined();
    await page.getByLabel('発言',{exact:true}).fill('SEC_LOCAL_DRAFT');
    await expect(page.locator('.composer-dock .draft-status')).toContainText('保存済み');
    await page.getByRole('button',{name:'セッション設定',exact:true}).click();await page.getByRole('button',{name:'診断',exact:true}).click();
    const endpoint=base+`/v1/sessions/${f.id}/diagnostic-runs/${run.id}`;
    await page.route(endpoint,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);captured();await gate;await route.fulfill({response}).catch(()=>{});});
    const explorer=page.getByRole('region',{name:'判断と根拠の追跡',exact:true});
    await explorer.locator('.diagnostic-run-list button').filter({hasText:run.id.slice(0,8)}).click();
    await requested;
    await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByLabel('ログイントークン')).toBeVisible();
    release();await page.getByLabel('ログイントークン').fill(f.config.viewerToken!);await submitLogin(page,'閲覧者');
    await expect(page.locator('.diagnostic-explorer')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('SEC_LATE_PRIVATE_RESPONSE');
    await expect(page.locator('body')).not.toContainText('SEC_LOCAL_DRAFT');
    expect((await page.request.get(endpoint)).status()).toBe(403);
    await page.reload();await expect(page.locator('.workspace-role')).toHaveText('閲覧者');
    await expect(page.locator('body')).not.toContainText('SEC_LATE_PRIVATE_RESPONSE');
    expect(f.service.session(f.id).call_count).toBe(1);
  }finally{release();await app.close();f.close();}
});
