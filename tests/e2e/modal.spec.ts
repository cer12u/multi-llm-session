import { expect, test } from '@playwright/test';
import { submitLogin } from './login-submit.js';

test('a rejected session form shows its error inside the dialog and remains editable', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('ログイントークン').fill('e2e-test-operator-only-not-a-production-secret');
  await submitLogin(page,'管理者');
  await page.getByRole('button', { name: '新しいセッション', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新しいセッション', exact: true });
  await dialog.getByLabel('セッション名').fill('   ');
  await dialog.getByRole('button', { name: 'セッションを作成', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('入力の形式や上限を確認してください');
  await dialog.getByLabel('セッション名').fill('フォームの入力検証');
  await dialog.getByRole('button', { name: 'セッションを作成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.channel-title h1')).toContainText('フォームの入力検証');
});
