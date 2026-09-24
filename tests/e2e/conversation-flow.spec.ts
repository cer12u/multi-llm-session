import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from '../helpers.js';
import { buildServer } from '../../apps/core/server.js';
import { submitLogin } from './login-submit.js';

test('R6-FLOW-008: actual operator panel distinguishes owner loop restraint and new input without exposing private reasons to viewers', async ({ page }) => {
  const f = fixture(), app = buildServer(f.service, { timers: false, webRoot: resolve('dist/web') });
  try {
    f.say('根拠一'); f.say('根拠二'); f.start(); const run = f.claim()!, owner = run.context.self;
    f.finish(run, { action: { decision: 'ABSTAIN', reason: 'synthetic owner restraint' }, statePatch: {
      agentId: owner.id, sessionId: f.id, expectedVersion: owner.privateState!.version, observationId: run.context.observation!.id,
      upsert: [{ id: 'restraint', kind: 'intention', text: 'PRIVATE_LOOP_READING_NOT_FOR_VIEWERS', resume: null,
        participation: { code: 'CONTENT_LOOP', throughInput: run.context.delivery!.throughInput },
        evidence: run.context.messages.map(m => ({ kind: 'message', id: m.id, version: m.revision })) }], remove: [] } });
    await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('NO_SYNTHETIC_PORT');
    const base = `http://127.0.0.1:${address.port}`; f.config.publicOrigin = base;
    await page.goto(base + '/?session=' + f.id); await page.getByLabel('ログイントークン').fill(f.config.adminToken); await submitLogin(page, '管理者');
    await page.getByRole('button', { name: 'セッション設定', exact: true }).click();
    await page.getByRole('button', { name: '診断', exact: true }).click();
    const row = page.locator(`[data-operation-agent="${owner.id}"]`);
    await expect(row.locator('.operation-reason')).toContainText('本人が反復を避けて保留・沈黙中');
    const calls = f.service.session(f.id).call_count;
    f.service.injectSource(f.id, { title: '別の題材', text: '反復とは別の入力' }, randomUUID());
    await expect(row.locator('.operation-reason')).toContainText('新着入力の処理待ち');
    expect(f.service.session(f.id).call_count).toBe(calls);
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await page.getByLabel('ログイントークン').fill(f.config.viewerToken!); await submitLogin(page, '閲覧者');
    await expect(page.locator('.operations-panel')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_LOOP_READING_NOT_FOR_VIEWERS');
    expect(f.service.session(f.id).call_count).toBe(calls);
  } finally { await app.close(); f.close(); }
});
