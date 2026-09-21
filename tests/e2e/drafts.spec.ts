import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const admin='e2e-test-operator-only-not-a-production-secret', viewer='e2e-viewer-read-only-not-a-production-secret';
const headers={authorization:'Bearer '+admin};
async function create(request:APIRequestContext){
  const characters=await(await request.get('/v1/characters',{headers})).json();
  const caps=await(await request.get('/v1/capabilities',{headers})).json();
  const response=await request.post('/v1/sessions',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{title:'永続下書き '+crypto.randomUUID(),participants:caps.slots.slice(0,3).map((slot:string,i:number)=>({slot,characterId:characters[i%characters.length].id,profileId:'mock'})),settings:caps.defaults}});
  expect(response.ok()).toBe(true);return(await response.json()).id as string;
}
async function login(page:Page,id:string,token=admin){await page.goto('/?session='+id);await page.getByLabel('ログイントークン').fill(token);await page.getByRole('button',{name:'ログイン',exact:true}).click();await expect(page.locator('.workspace-role')).toHaveText(token===admin?'管理者':'閲覧者');}
async function saved(page:Page){await expect(page.locator('.composer-dock .draft-status')).toContainText('保存済み');}
async function snapshot(request:APIRequestContext,id:string){return(await request.get(`/v1/sessions/${id}/snapshot`,{headers})).json();}

test('R7-DRAFT-001: reload and reopening a tab preserve text and addressee; IME and Shift+Enter do not submit',async({page,request,context})=>{
  const id=await create(request);await login(page,id);const agent=(await snapshot(request,id)).agents[0];
  await page.getByLabel('発言',{exact:true}).fill('端末へ保存する日本語');
  await page.getByLabel('宛先',{exact:true}).selectOption(agent.id);await saved(page);
  await page.reload();await expect(page.getByLabel('発言',{exact:true})).toHaveValue('端末へ保存する日本語');await expect(page.getByLabel('宛先',{exact:true})).toHaveValue(agent.id);
  await page.getByLabel('発言',{exact:true}).press('End');await page.getByLabel('発言',{exact:true}).press('Shift+Enter');await saved(page);
  await page.getByLabel('発言',{exact:true}).dispatchEvent('compositionstart');await page.getByLabel('発言',{exact:true}).press('Enter');await page.getByLabel('発言',{exact:true}).dispatchEvent('compositionend');
  expect((await snapshot(request,id)).messages).toHaveLength(0);
  await page.close();const reopened=await context.newPage();await reopened.goto('/?session='+id);
  await expect(reopened.getByLabel('発言',{exact:true})).toHaveValue('端末へ保存する日本語\n');
  await reopened.getByRole('button',{name:'送信',exact:true}).click();
  await expect(reopened.locator('.timeline article')).toHaveCount(1);await expect(reopened.getByLabel('発言',{exact:true})).toHaveValue('');await reopened.reload();await expect(reopened.getByLabel('発言',{exact:true})).toHaveValue('');
  expect((await snapshot(request,id)).session.calls).toBe(0);await reopened.close();
});

test('R7-DRAFT-002: lost commit response survives reload; a rewritten draft remains separate from the original receipt',async({page,request})=>{
  const id=await create(request);await login(page,id);await page.getByLabel('発言',{exact:true}).fill('元の一回の投稿');await saved(page);
  const keys:string[]=[];
  await page.route(`**/v1/sessions/${id}/messages`,async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    keys.push(route.request().headers()['idempotency-key']);const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort('failed');
  });
  await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.locator('.composer-dock .draft-status')).toContainText('結果不明');
  expect((await snapshot(request,id)).messages).toHaveLength(1);expect(new Set(keys).size).toBe(1);
  await page.unroute(`**/v1/sessions/${id}/messages`);await page.reload();await expect(page.locator('.composer-dock .draft-status')).toContainText('結果不明');
  await page.getByLabel('発言',{exact:true}).fill('元の結果とは別の改稿');await expect(page.getByRole('button',{name:'送信',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'送信結果を確認',exact:true}).click();
  await expect(page.getByLabel('発言',{exact:true})).toHaveValue('元の結果とは別の改稿');await expect(page.locator('.composer-dock .draft-status')).toContainText('確認済み');
  expect((await snapshot(request,id)).messages).toHaveLength(1);
  await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.locator('.timeline article')).toHaveCount(2);
  expect((await snapshot(request,id)).messages.map((m:{text:string})=>m.text)).toEqual(['元の一回の投稿','元の結果とは別の改稿']);
});

test('R7-DRAFT-003: two tabs detect draft-version conflicts and explicit logout erases local drafts without storing tokens',async({page,context,request})=>{
  const id=await create(request);await login(page,id);await page.getByLabel('発言',{exact:true}).fill('先に保存した本文');await saved(page);
  const second=await context.newPage();await second.goto('/?session='+id);await expect(second.getByLabel('発言',{exact:true})).toHaveValue('先に保存した本文');
  await second.getByLabel('発言',{exact:true}).fill('別タブの新しい本文');await saved(second);
  await page.getByLabel('発言',{exact:true}).fill('古いタブからの競合編集');await expect(page.locator('.composer-dock .draft-status')).toContainText('競合');
  await page.getByRole('button',{name:'他タブの下書きを読み直す',exact:true}).click();await expect(page.getByLabel('発言',{exact:true})).toHaveValue('別タブの新しい本文');
  const contents=await page.evaluate(async()=>new Promise<string>((resolve,reject)=>{const request=indexedDB.open('multi-llm-session-drafts');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,read=db.transaction('records').objectStore('records').getAll();read.onsuccess=()=>{resolve(JSON.stringify(read.result));db.close();};};}));
  expect(contents).not.toContain(admin);expect(contents).not.toContain('csrf');
  await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByLabel('ログイントークン')).toBeVisible();
  await expect(second.locator('.composer')).toHaveCount(0);
  await login(page,id,viewer);await expect(page.locator('.composer')).toHaveCount(0);expect(await page.locator('body').innerText()).not.toContain('別タブの新しい本文');
  await page.getByRole('button',{name:'ログアウト',exact:true}).click();await login(page,id);await expect(page.getByLabel('発言',{exact:true})).toHaveValue('');await second.close();
});

test('R7-DRAFT-004: reply drafts stay with their original; deleted parents and ended sessions do not silently discard retained text',async({page,request})=>{
  const id=await create(request);const posted=await request.post(`/v1/sessions/${id}/messages`,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{text:'返信の親'}});const parent=await posted.json();
  await login(page,id);await page.locator(`[data-message-id="${parent.id}"]`).getByRole('button',{name:'返信',exact:true}).click();
  await page.getByLabel('スレッドへ返信',{exact:true}).fill('まだ送らない返信');await expect(page.locator('.thread-composer .draft-status')).toContainText('保存済み');
  await page.reload();await page.locator(`[data-message-id="${parent.id}"]`).getByRole('button',{name:'返信',exact:true}).click();await expect(page.getByLabel('スレッドへ返信',{exact:true})).toHaveValue('まだ送らない返信');
  await request.post(`/v1/sessions/${id}/messages/${parent.id}`,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{text:null}});
  await expect(page.locator('.thread-composer')).toContainText('返信元は削除済み');await expect(page.getByLabel('スレッドへ返信',{exact:true})).toHaveValue('まだ送らない返信');await expect(page.getByRole('button',{name:'返信を送信',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'パネルを閉じる',exact:true}).click();await page.getByLabel('発言',{exact:true}).fill('終了しても参照する下書き');await saved(page);
  await request.post(`/v1/sessions/${id}/end`,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{}});
  await expect(page.locator('.composer-dock')).toContainText('終了したセッション');await expect(page.getByRole('button',{name:'送信',exact:true})).toBeDisabled();
  await page.reload();await expect(page.getByLabel('発言',{exact:true})).toHaveValue('終了しても参照する下書き');expect((await snapshot(request,id)).session.calls).toBe(0);
});
