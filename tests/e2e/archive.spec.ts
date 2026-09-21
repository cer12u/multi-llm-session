import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const admin='e2e-test-operator-only-not-a-production-secret', viewer='e2e-viewer-read-only-not-a-production-secret';
const headers={authorization:'Bearer '+admin};
async function create(request:APIRequestContext,title:string){
  const cs=await(await request.get('/v1/characters',{headers})).json();
  const caps=await(await request.get('/v1/capabilities',{headers})).json();
  const response=await request.post('/v1/sessions',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{title,participants:caps.slots.slice(0,3).map((slot:string,i:number)=>({slot,characterId:cs[i%cs.length].id,profileId:'mock'})),settings:caps.defaults}});
  expect(response.ok()).toBe(true);return(await response.json()).id as string;
}
async function post(request:APIRequestContext,id:string,text:string,replyTo:string|null=null){
  const response=await request.post(`/v1/sessions/${id}/messages`,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{text,replyTo}});
  expect(response.ok()).toBe(true);return response.json();
}
async function login(page:Page,token=admin,path='/'){
  await page.goto(path);await page.getByLabel('ログイントークン').fill(token);await page.getByRole('button',{name:'ログイン',exact:true}).click();
  await expect(page.locator('.workspace-role')).toHaveText(token===admin?'管理者':'閲覧者');
}

test('R7-HISTORY-001: 1205 history rows, 270 matches and a 241-row old nested thread remain reachable across new arrivals and reconnect',async({page,request,context})=>{
  test.setTimeout(120000);
  const id=await create(request,'全履歴 '+crypto.randomUUID()), messages:{id:string}[]=[];let parent:string|null=null;
  for(let i=0;i<1205;i++){
    const m=await post(request,id,(i<270?'検索標識 ':'通常本文 ')+i,i>0&&i<=240?parent:null);messages.push(m);
    if(i===0||(i<=240&&i%7===0))parent=m.id;
  }
  await page.setViewportSize({width:1440,height:900});await login(page,admin,'/?session='+id);
  await expect(page.locator('.timeline article')).toHaveCount(200);
  for(let count=200;count<1205;){
    await page.getByRole('button',{name:'以前の発言を読み込む',exact:true}).click();count=Math.min(1205,count+100);
    await expect(page.locator('.timeline article')).toHaveCount(count);
  }
  expect(await page.locator('.timeline article').evaluateAll(rows=>new Set(rows.map(row=>row.getAttribute('data-message-id'))).size)).toBe(1205);
  await expect(page.getByText('履歴の先頭です', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'このセッションを検索',exact:true}).click();
  await page.getByLabel('検索語',{exact:true}).fill('検索標識');await page.getByRole('button',{name:'検索',exact:true}).click();
  for(let count=50;count<270;){await expect(page.locator('.search-result')).toHaveCount(count);await page.getByRole('button',{name:'検索の続きを読み込む',exact:true}).click();count=Math.min(270,count+50);}
  await expect(page.locator('.search-result')).toHaveCount(270);
  await page.locator('.search-result').first().getByRole('link',{name:'会話内で表示 →',exact:true}).click();
  await expect(page.locator(`.timeline [data-message-id="${messages[269].id}"]`)).toHaveClass(/highlighted/);
  await page.locator(`.timeline [data-message-id="${messages[0].id}"]`).getByRole('button',{name:'返信',exact:true}).click();
  const thread=page.getByRole('complementary',{name:'スレッド',exact:true});
  await expect(thread.locator('article')).toHaveCount(100);
  await thread.getByRole('button',{name:'返信の続きを読み込む',exact:true}).click();await expect(thread.locator('article')).toHaveCount(200);
  await thread.getByRole('button',{name:'返信の続きを読み込む',exact:true}).click();await expect(thread.locator('article')).toHaveCount(241);
  expect(await thread.locator('article').evaluateAll(rows=>new Set(rows.map(row=>row.getAttribute('data-message-id'))).size)).toBe(241);
  await page.getByRole('button',{name:'パネルを閉じる',exact:true}).click();
  await page.getByRole('button',{name:'このセッションを検索',exact:true}).click();
  await page.getByLabel('検索語',{exact:true}).fill('検索標識');await page.getByRole('button',{name:'検索',exact:true}).click();
  await expect(page.locator('.search-result')).toHaveCount(50);
  const changed=await request.post(`/v1/sessions/${id}/messages/${messages[0].id}`,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{text:'訂正後の最古本文'}});expect(changed.ok()).toBe(true);
  await page.getByRole('button',{name:'検索の続きを読み込む',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('検索結果が更新されました');
  await page.getByRole('button',{name:'先頭から再検索',exact:true}).click();await expect(page.locator('.search-result')).toHaveCount(50);
  await page.getByRole('button',{name:'パネルを閉じる',exact:true}).click();
  await expect(page.locator(`.timeline [data-message-id="${messages[0].id}"]`)).toContainText('訂正後の最古本文');
  const timeline=page.getByRole('log',{name:'会話履歴'});await timeline.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  await post(request,id,'新着でも過去を消さない');await expect(page.locator('.timeline article')).toHaveCount(1206);
  expect(await timeline.evaluate(el=>el.scrollTop)).toBeLessThan(100);
  const second=await context.newPage();await second.goto(`/?session=${id}&message=${messages[0].id}`);
  await expect(second.locator(`.timeline [data-message-id="${messages[0].id}"]`)).toContainText('訂正後の最古本文');
  await context.setOffline(true);await expect(page.locator('.connection')).toContainText('再接続中');
  const removed=await request.post(`/v1/sessions/${id}/messages/${messages[0].id}`,{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{text:null}});expect(removed.ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.locator(`.timeline [data-message-id="${messages[0].id}"]`)).toContainText('削除済み');
  await expect(second.locator(`.timeline [data-message-id="${messages[0].id}"]`)).toContainText('削除済み');
  expect((await(await request.get(`/v1/sessions/${id}/snapshot`,{headers})).json()).session.calls).toBe(0);
  await second.close();
});

test('R7-HISTORY-002: a 390px viewer follows the same archive contract without a composer or model invocation',async({page,request})=>{
  const id=await create(request,'閲覧履歴 '+crypto.randomUUID());for(let i=0;i<205;i++)await post(request,id,'閲覧用 '+i);
  await page.setViewportSize({width:390,height:844});await login(page,viewer,'/?session='+id);
  await expect(page.locator('.timeline article')).toHaveCount(200);
  await page.getByRole('button',{name:'以前の発言を読み込む',exact:true}).click();await expect(page.locator('.timeline article')).toHaveCount(205);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('.composer')).toHaveCount(0);
  expect((await(await request.get(`/v1/sessions/${id}/snapshot`,{headers})).json()).session.calls).toBe(0);
});
