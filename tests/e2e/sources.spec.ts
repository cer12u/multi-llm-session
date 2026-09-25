import {test,expect,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers.js';
import {buildServer} from '../../apps/core/server.js';
import {FeedPoller} from '../../packages/sources/index.js';
import {submitLogin} from './login-submit.js';

async function panel(page:Page){
  await page.getByRole('button',{name:'セッション設定',exact:true}).click();
  await page.getByRole('button',{name:'資料を共有',exact:true}).click();
  return page.getByRole('region',{name:'資料とフィードの管理',exact:true});
}

test('R6-SOURCE-UI-001: actual source editor preserves private audience, original versions and publication date without inference',async({page})=>{
  const f=fixture(3,{selfWakeEnabled:false}),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  try{
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;const owner=f.service.snapshot(f.id).agents[0];
    await page.goto(base+'/?session='+f.id);await page.getByLabel('ログイントークン').fill(f.config.adminToken);await submitLogin(page,'管理者');
    const manager=await panel(page);await expect(manager).toBeVisible();
    await manager.getByLabel('資料名',{exact:true}).fill('PRIVATE_UI_TITLE');
    await manager.getByLabel('本文',{exact:true}).fill('PRIVATE_UI_BODY <img src=x onerror="window.sourceInjected=true">');
    await manager.getByLabel('公開日時（ISO 8601・不明なら空欄）',{exact:true}).fill('2020-01-02T03:04:05Z');
    const audience=manager.getByRole('group',{name:'資料の配信先',exact:true});
    await audience.getByLabel('全参加者へ配信',{exact:true}).uncheck();
    await audience.getByLabel('資料の配信先：'+owner.name,{exact:true}).check();
    await manager.getByRole('button',{name:'資料を追加',exact:true}).click();
    await expect(manager.getByRole('status')).toContainText('v1');
    const source=f.service.sources.list(f.id)[0];expect(source.audience).toEqual([owner.id]);
    expect(source.publishedAt).toBe('2020-01-02T03:04:05.000Z');expect(source.fetchedAt).toBe(f.now());
    expect(await page.evaluate(()=>Object.hasOwn(window,'sourceInjected'))).toBe(false);
    expect(JSON.stringify(f.service.eventsAfter(f.id,f.id+':0'))).not.toContain('PRIVATE_UI_');
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('PRIVATE_UI_');
    await manager.getByLabel('本文',{exact:true}).fill('REVISED_PRIVATE_UI_BODY');
    await manager.getByRole('button',{name:'資料を更新',exact:true}).click();await expect(manager.getByRole('status')).toContainText('v2');
    await manager.getByLabel('資料の参照版',{exact:true}).selectOption('1');
    await expect(manager.getByLabel('本文',{exact:true})).toContainText('');
    await expect(manager.getByLabel('本文',{exact:true})).toHaveValue('PRIVATE_UI_BODY <img src=x onerror="window.sourceInjected=true">');
    await expect(manager.getByRole('button',{name:'資料を更新',exact:true})).toBeDisabled();
    await manager.getByLabel('資料の参照版',{exact:true}).selectOption('2');
    await expect(manager.getByLabel('本文',{exact:true})).toHaveValue('REVISED_PRIVATE_UI_BODY');
    await manager.getByLabel('資料の配信を有効にする',{exact:true}).uncheck();
    await manager.getByRole('button',{name:'資料を更新',exact:true}).click();await expect(manager.getByRole('status')).toContainText('v3');
    expect(f.service.sources.get(f.id,source.id).enabled).toBe(false);expect(f.service.sources.versions(f.id,source.id)).toHaveLength(3);
    await page.reload();const reopened=await panel(page);
    await reopened.locator('.source-catalog button').filter({hasText:'PRIVATE_UI_TITLE'}).click();
    await expect(reopened.getByLabel('資料の参照版',{exact:true})).toHaveValue('3');
    await expect(reopened.getByLabel('資料の配信を有効にする',{exact:true})).not.toBeChecked();
    expect(f.service.session(f.id).call_count).toBe(0);expect(f.service.session(f.id).lifecycle).toBe('DRAFT');
    await page.getByRole('button',{name:'ログアウト',exact:true}).click();
    await page.getByLabel('ログイントークン').fill(f.config.viewerToken!);await submitLogin(page,'閲覧者');
    await expect(page.locator('.source-manager')).toHaveCount(0);expect(await page.locator('body').innerText()).not.toContain('PRIVATE_UI_');
    const forbidden=await page.request.get(base+`/v1/sessions/${f.id}/sources`);expect(forbidden.status()).toBe(403);
  }finally{await app.close();f.close();}
});

test('R6-SOURCE-UI-002: mobile feed editor shows acquisition failures and explicit retry without starting models or resuming pause',async({page})=>{
  const f=fixture(3,{selfWakeEnabled:false}),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  let requests=0;
  try{
    f.config.feeds=[{id:'mobile-news',url:'https://fixture.invalid/feed',intervalMs:60000}];
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;await page.setViewportSize({width:390,height:844});
    await page.goto(base+'/?session='+f.id);await page.getByLabel('ログイントークン').fill(f.config.adminToken);await submitLogin(page,'管理者');
    const manager=await panel(page);await manager.locator('.feed-manager > summary').click();
    await manager.getByLabel('フィード',{exact:true}).selectOption('mobile-news');
    await manager.getByRole('button',{name:'フィード設定を保存',exact:true}).click();
    await expect(manager.getByRole('status')).toContainText('フィード設定を保存しました');
    const poller=new FeedPoller(f.service,async()=>{requests++;return new Response('SYNTHETIC_PRIVATE_HTTP_ERROR',{status:503});});
    await poller.tick();expect(requests).toBe(0);expect(f.service.sources.feeds(f.id)).toHaveLength(1);
    f.service.lifecycle(f.id,'start',randomUUID());await poller.tick();expect(requests).toBe(1);
    await expect(manager.locator('.source-feed')).toContainText('FEED_HTTP_ERROR');
    expect(await page.locator('body').innerText()).not.toContain('SYNTHETIC_PRIVATE_HTTP_ERROR');
    f.service.lifecycle(f.id,'pause',randomUUID());
    await manager.getByRole('button',{name:'再取得を予約',exact:true}).click();
    await expect(manager.getByRole('status')).toContainText('再取得を予約しました');
    await poller.tick();expect(requests).toBe(1);expect(f.service.session(f.id).lifecycle).toBe('PAUSED');
    expect(f.service.session(f.id).call_count).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }finally{await app.close();f.close();}
});
