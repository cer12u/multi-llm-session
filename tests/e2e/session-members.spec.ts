import {expect,test,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers.js';
import {buildServer} from '../../apps/core/server.js';
import {characterOf,profileOf} from '../../packages/storage-sqlite/index.js';
import {submitLogin} from './login-submit.js';

async function openEditor(page:Page,base:string,id:string,token:string){
  await page.goto(base+'/?session='+id);await page.getByLabel('ログイントークン').fill(token);await submitLogin(page,'管理者');
  await page.getByRole('button',{name:'セッション設定',exact:true}).click();await page.getByRole('button',{name:'診断',exact:true}).click();
  await page.locator('.session-members > summary').click();
  const editor=page.getByRole('region',{name:'セッション参加者の編集'});
  await expect(editor.locator('.member-selection')).toHaveCount(3);return editor;
}

test('R7-MEMBERS-UI-001: actual paused membership editor applies an exact version, preserves old authorship, replaces owner identity and clones only definitions',async({page})=>{
  test.setTimeout(60000);const f=fixture(),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  try{
    f.say('保存済みの公開原文');f.start();f.speak(f.claim()!);f.finish(f.claim()!,{decision:'DRAFT',text:'古い人格で投稿した発言'});
    const published=f.service.commitNext(f.id)!,owner=f.service.agent(published.authorId!);
    f.service.lifecycle(f.id,'pause',randomUUID());
    const nextCharacter={...characterOf(owner),version:2,name:'同じ個体の新しい版',persona:'明示適用する合成人格'};
    f.service.putCharacter(nextCharacter);f.service.putModelProfile({...profileOf(owner),version:2,model:'second-synthetic-version'});
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const editor=await openEditor(page,base,f.id,f.config.adminToken),calls=f.service.session(f.id).call_count;
    await editor.getByLabel('参加者1の人格版',{exact:true}).selectOption(JSON.stringify({id:nextCharacter.id,version:2}));
    await editor.getByLabel('参加者1のモデル版',{exact:true}).selectOption(JSON.stringify({id:'mock',version:2}));
    page.once('dialog',dialog=>void dialog.accept());await editor.getByRole('button',{name:'参加者設定を保存',exact:true}).click();
    await expect(editor.getByRole('status')).toContainText('参加者設定を保存しました');
    expect(characterOf(f.service.agent(owner.id)).version).toBe(2);expect(f.service.agent(owner.id).id).toBe(owner.id);
    expect(f.service.archiveMessage(f.id,published.id)).toEqual(published);
    await expect(page.locator(`.timeline [data-message-id="${published.id}"]`)).toContainText(published.authorName);
    await expect(editor.getByRole('button',{name:'参加者設定を保存',exact:true})).toBeDisabled();
    await expect(editor.locator('fieldset').first()).toBeEnabled();
    await editor.locator('.member-selection').first().getByRole('button',{name:'別のAgentとして交代',exact:true}).click();
    await editor.getByLabel('参加者1の人格版',{exact:true}).selectOption(JSON.stringify({id:f.config.characters[1].id,version:1}));
    page.once('dialog',dialog=>void dialog.accept());const saved=page.waitForResponse(r=>r.url().endsWith(`/v1/sessions/${f.id}/membership`)&&r.request().method()==='POST');
    await editor.getByRole('button',{name:'参加者設定を保存',exact:true}).click();expect((await saved).ok()).toBe(true);
    await expect(editor.locator('summary').filter({hasText:'退出した個体（1）'})).toBeVisible();
    const now=f.service.membership(f.id),replacement=now.current.find(row=>row.agent.slot===owner.slot)!;
    expect(replacement.agent.id).not.toBe(owner.id);expect(now.archived[0].agent.id).toBe(owner.id);
    expect(f.service.archiveMessage(f.id,published.id)).toEqual(published);expect(f.service.session(f.id).call_count).toBe(calls);
    await editor.getByLabel('複製先のセッション名',{exact:true}).fill('定義だけのコピー');
    await editor.locator('.session-clone input[type=checkbox]').check();await editor.getByRole('button',{name:'定義だけを複製',exact:true}).click();
    const link=editor.getByRole('link',{name:'複製した開始前セッションを開く',exact:true});await expect(link).toBeVisible();
    const newId=new URL((await link.getAttribute('href'))!,base).searchParams.get('session')!;
    expect(f.service.snapshot(newId).messages).toEqual([]);expect(f.service.session(newId)).toMatchObject({lifecycle:'DRAFT',call_count:0});
    expect(f.service.session(f.id).lifecycle).toBe('PAUSED');
    await page.reload();await page.getByRole('button',{name:'セッション設定',exact:true}).click();await page.getByRole('button',{name:'診断',exact:true}).click();await page.locator('.session-members > summary').click();
    await expect(page.locator('.membership-counts')).toContainText('登録 3');expect(f.service.session(f.id).call_count).toBe(calls);
  }finally{await app.close();f.close();}
});

test('R7-MEMBERS-UI-002: mobile form preserves unsaved edits on epoch changes and viewer cannot access membership controls',async({page})=>{
  const f=fixture(),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  try{
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;await page.setViewportSize({width:390,height:844});
    const editor=await openEditor(page,base,f.id,f.config.adminToken);
    const first=editor.locator('.member-selection').first();await first.getByLabel('このAgentを有効にする',{exact:true}).uncheck();
    f.service.updateSettings(f.id,f.config.defaults,randomUUID());
    await expect(editor.getByRole('alert')).toContainText('セッションの世代が変わりました');
    await expect(first.getByLabel('このAgentを有効にする',{exact:true})).not.toBeChecked();
    await expect(editor.getByRole('button',{name:'参加者設定を保存',exact:true})).toBeDisabled();
    page.once('dialog',dialog=>void dialog.accept());await editor.getByRole('button',{name:'参加者を再取得',exact:true}).click();
    await expect(first.getByLabel('このAgentを有効にする',{exact:true})).toBeChecked();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('button',{name:'パネルを閉じる',exact:true}).click();await page.getByRole('button',{name:'セッション一覧を開く',exact:true}).click();await page.getByRole('button',{name:'ログアウト',exact:true}).click();
    await expect(page.getByLabel('ログイントークン')).toBeVisible();await page.getByLabel('ログイントークン').fill(f.config.viewerToken!);await submitLogin(page,'閲覧者');
    await expect(page.locator('.session-members')).toHaveCount(0);await expect(page.locator('.operations-panel')).toHaveCount(0);
    const status=await page.evaluate(async path=>(await fetch(path)).status,`/v1/sessions/${f.id}/membership`);expect(status).toBe(403);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
