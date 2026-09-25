import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {fixture} from '../helpers.js';
import {buildServer} from '../../apps/core/server.js';
import {submitLogin} from './login-submit.js';

test('R10-DIAG-UI-001: real operator panel traces original/state changes; downloads are distinct and viewer/logout cannot retain private detail',async({page})=>{
  const f=fixture(),app=buildServer(f.service,{timers:false,webRoot:resolve('dist/web')});
  try{
    const original=f.say('visible original');f.start();const run=f.claim()!,state=run.context.self.privateState!;
    f.finish(run,{action:{decision:'ABSTAIN',reason:'retain a private interest'},statePatch:{agentId:state.agentId,sessionId:f.id,expectedVersion:state.version,observationId:run.context.observation!.id,
      upsert:[{id:'private-interest',kind:'interest',text:'PRIVATE_DIAGNOSTIC_FIXTURE',resume:null,evidence:[{kind:'message',id:original.id,version:original.revision}]}],remove:[]}});
    await app.listen({host:'127.0.0.1',port:0});const addr=app.server.address();if(!addr||typeof addr==='string')throw new Error('Missing port');
    const base=`http://127.0.0.1:${addr.port}`;f.config.publicOrigin=base;
    await page.goto(base+'/?session='+f.id);await page.getByLabel('ログイントークン').fill(f.config.adminToken);await submitLogin(page,'管理者');
    await page.getByRole('button',{name:'セッション設定',exact:true}).click();await page.getByRole('button',{name:'診断',exact:true}).click();
    const explorer=page.getByRole('region',{name:'判断と根拠の追跡',exact:true});await expect(explorer).toBeVisible();
    await explorer.locator('.diagnostic-run-list button').filter({hasText:run.id.slice(0,8)}).click();
    const detail=explorer.getByRole('article',{name:'選択した実行の診断',exact:true});await expect(detail).toContainText('ABSTAIN');
    await detail.getByText('私有状態の更新差分',{exact:true}).click();await expect(detail).toContainText('PRIVATE_DIAGNOSTIC_FIXTURE');
    await expect(detail.getByRole('link',{name:'原文を表示',exact:true})).toHaveAttribute('href','/?session='+f.id+'&message='+original.id);
    expect(await page.locator('body').innerText()).not.toContain(run.token);
    const publicDownload=page.waitForEvent('download');await explorer.getByRole('link',{name:'公開会話を書き出す',exact:true}).click();expect((await publicDownload).suggestedFilename()).toBe('transcript-'+f.id+'.json');
    page.once('dialog',dialog=>void dialog.accept());const privateDownload=page.waitForEvent('download');await explorer.getByRole('link',{name:'私有診断を書き出す',exact:true}).click();expect((await privateDownload).suggestedFilename()).toBe('PRIVATE-diagnostic-'+f.id+'.ndjson');
    await page.reload();expect(f.service.session(f.id).call_count).toBe(1);
    await page.getByRole('button',{name:'ログアウト',exact:true}).click();await page.getByLabel('ログイントークン').fill(f.config.viewerToken!);await submitLogin(page,'閲覧者');
    await expect(page.locator('.diagnostic-explorer')).toHaveCount(0);expect(await page.locator('body').innerText()).not.toContain('PRIVATE_DIAGNOSTIC_FIXTURE');
    expect((await page.request.get(base+`/v1/sessions/${f.id}/diagnostic-runs/${run.id}`)).status()).toBe(403);
    expect(f.service.session(f.id).call_count).toBe(1);
  }finally{await app.close();f.close();}
});
