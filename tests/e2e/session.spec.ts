import { test,expect } from '@playwright/test';

test('creates a session, receives independent mock replies, pauses and reconnects without losing history',async({page,context})=>{
  await page.goto('/');await page.getByLabel('ログイントークン').fill('e2e-test-operator-only-not-a-production-secret');await page.getByRole('button',{name:'ログイン',exact:true}).click();
  await page.getByLabel('セッション名').fill('E2E 自由会話');await page.getByRole('button',{name:'セッションを作成'}).click();
  await expect(page.getByRole('heading',{name:'E2E 自由会話'})).toBeVisible();await expect(page.getByText('MOCK · 模擬応答')).toBeVisible();
  await page.getByLabel('発言',{exact:true}).fill('雨の日の過ごし方について話してください');await page.getByRole('button',{name:'送信',exact:true}).click();
  await page.getByRole('button',{name:'開始',exact:true}).click();
  await expect.poll(async()=>page.locator('article.bot').evaluateAll(nodes=>new Set(nodes.map(n=>n.getAttribute('data-author'))).size),{timeout:40000}).toBeGreaterThanOrEqual(3);
  await page.getByRole('button',{name:'一時停止'}).click();await expect(page.getByRole('button',{name:'再開',exact:true})).toBeVisible();
  const count=await page.locator('article').count();await page.reload();
  await page.getByRole('button',{name:/E2E 自由会話/}).click();await expect(page.locator('article')).toHaveCount(count);
  const second=await context.newPage();await second.goto('/');await second.getByRole('button',{name:/E2E 自由会話/}).click();
  await expect(second.locator('article')).toHaveCount(count);await expect(second.getByRole('button',{name:'再開',exact:true})).toBeVisible();
  await page.getByLabel('発言',{exact:true}).fill('<img src=x onerror="window.__injected=true">');await page.getByRole('button',{name:'送信',exact:true}).click();
  await expect(page.locator('article').last()).toContainText('<img src=x');expect(await page.evaluate(()=>('__injected' in window))).toBe(false);
  await page.getByRole('button',{name:'診断',exact:true}).click();await expect(page.getByRole('heading',{name:'管理者向け診断'})).toBeVisible();
  await page.screenshot({path:'artifacts/session-ui.png',fullPage:true});
  await second.close();await page.getByRole('button',{name:'終了',exact:true}).click();await expect(page.getByLabel('発言',{exact:true})).toHaveCount(0);
});
