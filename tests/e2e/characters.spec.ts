import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const admin = 'e2e-test-operator-only-not-a-production-secret';
const viewer = 'e2e-viewer-read-only-not-a-production-secret';
async function login(page: Page, token = admin) {
  await page.goto('/'); await page.getByLabel('ログイントークン').fill(token);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.locator('.workspace-role')).toHaveText(token === admin ? '管理者' : '閲覧者');
}
async function manager(page: Page) {
  const menu = page.getByRole('button', { name: 'セッション一覧を開く' });
  if (await menu.isVisible() && !(await page.locator('.session-sidebar').isVisible())) await menu.click();
  await page.getByRole('button', { name: 'キャラクターを管理', exact: true }).click();
  return page.getByRole('dialog', { name: 'キャラクターを管理', exact: true });
}

test('R9-CHAR-004: real form creates, edits, exports and imports exact versions without rewriting the active session', async ({ page, request }) => {
  const id = 'ui-' + crypto.randomUUID(), title = '定義を固定する ' + id;
  await login(page); let dialog = await manager(page);
  await dialog.getByLabel('キャラクターID', { exact: true }).fill(id);
  await dialog.getByLabel('名前', { exact: true }).fill('合成キャラクター');
  await dialog.getByLabel('人格・話し方・背景').fill('試験用の人格。事実と推測を区別する。');
  await dialog.getByLabel('表示参照（任意）').fill('javascript:untrusted-material');
  await dialog.getByRole('button', { name: '新しい版を保存', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(id + ' v1');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '新しいセッション', exact: true }).first().click();
  const create = page.getByRole('dialog', { name: '新しいセッション', exact: true });
  await create.getByLabel('セッション名').fill(title);
  // The enclosing label includes option text. Use the first participant's actual combobox, not a nonexistent exact label.
  const character = create.locator('.member-fields fieldset').first().getByRole('combobox').first();
  await expect(character).toBeVisible();
  await expect(character.locator(`option[value="${id}"]`)).toHaveCount(1);
  await character.selectOption(id);
  await expect(character).toHaveValue(id);
  await create.getByRole('button', { name: 'セッションを作成', exact: true }).click();
  await expect(page.locator('.channel-title h1')).toContainText(title);
  dialog = await manager(page);
  await dialog.locator('.character-catalog button').filter({ hasText: id }).click();
  await expect(dialog.locator('.character-pinned')).toContainText('v1 に固定');
  await dialog.getByLabel('名前', { exact: true }).fill('新しい合成人格');
  await dialog.getByLabel('人格・話し方・背景').fill('二番目の人格。以前の会話を勝手に変更しない。');
  await dialog.getByRole('button', { name: '新しい版を保存', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(id + ' v2');
  await expect(dialog.locator('.character-pinned')).toContainText('v1 に固定');
  await dialog.getByLabel('参照する版').selectOption('1');
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('合成キャラクター');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '参照中の版をエクスポート' }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe(`character-${id}-v1.json`);
  const exported = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
  expect(exported.version).toBe(1); expect(exported.name).toBe('合成キャラクター');
  await dialog.getByText('JSONのインポート', { exact: true }).click();
  await dialog.getByLabel('インポートJSON').fill('{broken');
  await dialog.getByRole('button', { name: 'JSONをインポート', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('JSONを解析できませんでした');
  await dialog.getByLabel('インポートJSON').fill(JSON.stringify({ ...exported, id: id + '-copy' }));
  await dialog.getByRole('button', { name: 'JSONをインポート', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(id + '-copy v1');
  const headers = { authorization: 'Bearer ' + admin };
  const sessions = await (await request.get('/v1/sessions', { headers })).json();
  const session = sessions.find((s: { title: string }) => s.title === title);
  const snapshot = await (await request.get(`/v1/sessions/${session.id}/snapshot`, { headers })).json();
  expect(snapshot.agents[0]).toMatchObject({ characterId: id, characterVersion: 1, name: '合成キャラクター' });
  expect(snapshot.session.calls).toBe(0);
  expect(await page.locator('[src="javascript:untrusted-material"]').count()).toBe(0);
  await page.reload(); dialog = await manager(page);
  await dialog.locator('.character-catalog button').filter({ hasText: id }).filter({ hasNotText: '-copy' }).click();
  await expect(dialog.getByLabel('参照する版')).toHaveValue('2');
  await expect(dialog.getByLabel('人格・話し方・背景')).toHaveValue('二番目の人格。以前の会話を勝手に変更しない。');
});

test('R9-CHAR-005: mobile editor uses real routes; viewer has no private editor after logout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const dialog = await manager(page), id = 'mobile-' + crypto.randomUUID();
  await dialog.getByLabel('キャラクターID', { exact: true }).fill(id);
  await dialog.getByLabel('名前', { exact: true }).fill('狭い画面の試験');
  await dialog.getByLabel('人格・話し方・背景').fill('合成された非公開設定');
  await dialog.getByRole('button', { name: '新しい版を保存', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(id + ' v1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'セッション一覧を開く' }).click();
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('ログイントークン')).toBeVisible();
  await login(page, viewer);
  await page.getByRole('button', { name: 'セッション一覧を開く' }).click();
  await expect(page.getByRole('button', { name: 'キャラクターを管理', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('人格・話し方・背景')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('合成された非公開設定');
});
