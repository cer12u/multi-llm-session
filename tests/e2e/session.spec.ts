import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { submitLogin } from './login-submit.js';
const adminToken = 'e2e-test-operator-only-not-a-production-secret';
const viewerToken = 'e2e-viewer-read-only-not-a-production-secret';
const headers = { authorization: `Bearer ${adminToken}` };
async function login(page: Page, token = adminToken) {
  await page.goto('/'); await page.getByLabel('ログイントークン').fill(token);
  await submitLogin(page,token === viewerToken ? '閲覧者' : '管理者');
}
async function create(page: Page, title: string) {
  await page.getByRole('button', { name: '新しいセッション', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新しいセッション', exact: true });
  await dialog.getByLabel('セッション名').fill(title);
  await dialog.getByRole('button', { name: 'セッションを作成', exact: true }).click();
  await expect(page.locator('.channel-title h1')).toContainText(title);
}
async function select(page: Page, title: string) {
  const menu = page.getByRole('button', { name: 'セッション一覧を開く' });
  if (await menu.isVisible() && !(await page.locator('.session-sidebar').isVisible())) await menu.click();
  await page.getByRole('navigation', { name: 'セッション一覧' }).getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.locator('.channel-title h1')).toContainText(title);
}
async function fixture(request: APIRequestContext, title: string) {
  const characters = await (await request.get('/v1/characters', { headers })).json();
  const caps = await (await request.get('/v1/capabilities', { headers })).json();
  const result = await request.post('/v1/sessions', { headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, data: { title, participants: caps.slots.slice(0, 3).map((slot: string, i: number) => ({ slot, characterId: characters[i % characters.length].id, profileId: 'mock' })), settings: caps.defaults } });
  expect(result.ok()).toBe(true); return (await result.json()).id as string;
}
async function post(request: APIRequestContext, id: string, text: string) {
  const response = await request.post(`/v1/sessions/${id}/messages`, { headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, data: { text } });
  expect(response.ok()).toBe(true); return response.json();
}
const input = (page: Page) => page.locator('.composer-dock').getByLabel('発言', { exact: true });
const send = (page: Page) => page.locator('.composer-dock').getByRole('button', { name: '送信', exact: true });

test('real app UI: session lifecycle, independent mock replies, reconnection and escaped text', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page); await create(page, 'E2E 自由会話');
  await expect(page.getByText('MOCK · 模擬応答')).toBeVisible();
  await input(page).fill('雨の日の過ごし方について話してください'); await send(page).click();
  await page.getByRole('button', { name: '開始', exact: true }).click();
  await expect.poll(async () => page.locator('.timeline article.bot').evaluateAll(nodes => new Set(nodes.map(node => node.getAttribute('data-author'))).size), { timeout: 40000 }).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '再開', exact: true })).toBeVisible();
  const count = await page.locator('.timeline article').count();
  await page.reload(); await select(page, 'E2E 自由会話'); await expect(page.locator('.timeline article')).toHaveCount(count);
  const second = await context.newPage(); await second.goto('/'); await select(second, 'E2E 自由会話');
  await expect(second.locator('.timeline article')).toHaveCount(count);
  await input(page).fill('<img src=x onerror="window.__injected=true">'); await send(page).click();
  await expect(page.locator('.timeline article').last()).toContainText('<img src=x');
  expect(await page.evaluate(() => '__injected' in window)).toBe(false);
  await page.getByRole('button', { name: 'セッション設定', exact: true }).click();
  await page.getByRole('button', { name: '診断', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理者向け診断' })).toBeVisible();
  await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  await page.locator('.timeline article').first().getByRole('button', { name: '返信', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'スレッド', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/chat-session-desktop.png', fullPage: true });
  await second.close(); await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  await page.getByRole('button', { name: 'セッション設定', exact: true }).click();
  await page.getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '終了する', exact: true }).click();
  await expect(input(page)).toHaveCount(0);
});

test('session drafts, Shift+Enter, IME safety and public reply threads use the actual API', async ({ page, request }) => {
  const a = await fixture(request, '下書きA'); await fixture(request, '下書きB');
  await login(page); await select(page, '下書きA'); await input(page).fill('Aにだけ残す下書き');
  await select(page, '下書きB'); await input(page).fill('Bにだけ残す下書き');
  await select(page, '下書きA'); await expect(input(page)).toHaveValue('Aにだけ残す下書き');
  await input(page).fill('一行目'); await input(page).press('Shift+Enter'); await input(page).pressSequentially('二行目');
  await expect(input(page)).toHaveValue('一行目\n二行目'); await input(page).press('Enter');
  await expect(page.locator('.timeline article').last()).toContainText('二行目'); await expect(input(page)).toHaveValue('');
  const count = await page.locator('.timeline article').count(); await input(page).fill('日本語の変換確定');
  await input(page).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(input(page)).toHaveValue('日本語の変換確定'); await expect(page.locator('.timeline article')).toHaveCount(count);
  await input(page).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await input(page).press('Enter'); await expect(page.locator('.timeline article')).toHaveCount(count + 1);
  const parentId = await page.locator('.timeline article').first().getAttribute('data-message-id');
  await page.locator('.timeline article').first().getByRole('button', { name: '返信', exact: true }).click();
  const thread = page.getByRole('complementary', { name: 'スレッド', exact: true });
  await thread.getByLabel('スレッドへ返信', { exact: true }).fill('返信も全員の会話に含まれる');
  await thread.getByLabel('スレッドへ返信', { exact: true }).press('Enter');
  await expect(page.locator('.timeline article').last()).toContainText('返信も全員の会話に含まれる');
  const snapshot = await (await request.get(`/v1/sessions/${a}/snapshot`, { headers })).json();
  expect(snapshot.messages.find((message: { text: string }) => message.text === '返信も全員の会話に含まれる').replyTo).toBe(parentId);
  await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  await select(page, '下書きB'); await expect(input(page)).toHaveValue('Bにだけ残す下書き');
});

test('new messages do not pull a reader away from history; the composer stays in the viewport', async ({ page, request }) => {
  const id = await fixture(request, '履歴スクロール');
  for (let i = 0; i < 45; i++) await post(request, id, `履歴 ${i + 1}：スクロールの検証用に保存する公開メッセージです。\n複数行の読みやすさと表示位置を確認します。`);
  await page.setViewportSize({ width: 1440, height: 900 }); await login(page); await select(page, '履歴スクロール');
  const timeline = page.getByRole('log', { name: '会話履歴' });
  await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  await timeline.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await post(request, id, '読み返し中に到着した新着');
  const jump = page.getByRole('button', { name: /新着.*最新へ/ }); await expect(jump).toBeVisible();
  expect(await timeline.evaluate(element => element.scrollTop)).toBeLessThan(100);
  const box = await input(page).boundingBox(); expect(box).not.toBeNull(); expect(box!.y + box!.height).toBeLessThan(900);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(901);
  await jump.click(); await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  await page.screenshot({ path: 'artifacts/chat-session-timeline.png', fullPage: true });
});

test('mobile chat: drawer navigation, public replies and no horizontal overflow', async ({ page, request }) => {
  const id = await fixture(request, 'モバイル会話'); await post(request, id, 'スマートフォンからも返信できるかを確認します。');
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await select(page, 'モバイル会話');
  await expect(page.locator('.session-sidebar')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(input(page)).toBeVisible();
  await page.locator('.timeline article').first().getByRole('button', { name: '返信', exact: true }).click();
  const thread = page.getByRole('complementary', { name: 'スレッド', exact: true });
  await thread.getByLabel('スレッドへ返信', { exact: true }).fill('狭い画面からの返信');
  await thread.getByRole('button', { name: '返信を送信' }).click();
  await expect(thread.locator('article').last()).toContainText('狭い画面からの返信');
  await expect(thread.getByText('表示範囲より前の発言への返信')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/chat-session-mobile-thread.png', fullPage: true });
  await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  await page.screenshot({ path: 'artifacts/chat-session-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('viewer UI has no composer, session mutation or private diagnostic controls', async ({ page, request }) => {
  const id = await fixture(request, '閲覧専用'); await post(request, id, '閲覧者向けの公開発言');
  await login(page, viewerToken); await select(page, '閲覧専用');
  await expect(page.getByText(/閲覧モード ·/)).toBeVisible(); await expect(input(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '開始', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'セッション設定', exact: true }).click();
  await expect(page.getByRole('button', { name: '診断', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'セッションを終了', exact: true })).toHaveCount(0);
});

test('a lost HTTP response preserves the draft and retries one logical message with the same idempotency key', async ({ page, request }) => {
  const id = await fixture(request, '再送の重複防止'); await login(page); await select(page, '再送の重複防止');
  const url = `**/v1/sessions/${id}/messages`, keys: string[] = [];
  await page.route(url, async route => { keys.push(route.request().headers()['idempotency-key']); await route.fetch(); await route.abort('failed'); });
  await input(page).fill('一度だけ確定する発言'); await send(page).click();
  await expect(page.getByRole('alert')).toBeVisible(); await expect(input(page)).toHaveValue('一度だけ確定する発言');
  await page.unroute(url);
  await page.route(url, async route => { keys.push(route.request().headers()['idempotency-key']); await route.continue(); });
  await send(page).click(); await expect(input(page)).toHaveValue('');
  const snapshot = await (await request.get(`/v1/sessions/${id}/snapshot`, { headers })).json();
  expect(snapshot.messages.filter((message: { text: string }) => message.text === '一度だけ確定する発言')).toHaveLength(1);
  expect(keys.length).toBeGreaterThanOrEqual(3); expect(new Set(keys).size).toBe(1);
});
