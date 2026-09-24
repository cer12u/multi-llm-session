import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { operations } from '../packages/session-service/operations.js';
import { currentDisposition } from '../packages/session-service/participation.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { backupDatabase, restoreDatabase } from '../packages/storage-sqlite/maintenance.js';
import type { ClaimedRun, Intent, PrivateStateEntry } from '../packages/contracts/index.js';

type Fixture = ReturnType<typeof fixture>;
function foreground(f: Fixture, slot = 'worker-0'): ClaimedRun {
  for (let i = 0; i < 60; i++) {
    const r = f.claim(slot); expect(r).not.toBeNull();
    if (r!.kind === 'observe') { f.finish(r!, { decision: 'ABSTAIN', reason: 'observe synthetic input' }); continue; }
    if (r!.kind === 'memory') { f.finish(r!, { notes: [] }); continue; }
    return r!;
  }
  throw new Error('FOREGROUND_NOT_REACHED');
}
function disposition(r: ClaimedRun, code: 'CONTENT_LOOP' | 'SATISFIED' = 'CONTENT_LOOP'): PrivateStateEntry {
  return { id: 'participation-choice', kind: 'intention', text: 'PRIVATE_OWNER_DISPOSITION', resume: null,
    participation: { code, throughInput: r.context.delivery!.throughInput },
    evidence: r.context.messages.filter(m => !m.deleted).slice(-2).map(m => ({ kind: 'message', id: m.id, version: m.revision })) };
}
function result(r: ClaimedRun, entries = [disposition(r)]) {
  const state = r.context.self.privateState!;
  return { action: { decision: 'ABSTAIN', reason: 'owner chooses not to repeat' }, statePatch: {
    agentId: state.agentId, sessionId: state.sessionId, expectedVersion: state.version, observationId: r.context.observation!.id,
    upsert: entries, remove: [] } };
}
it.each(['agreement', 'joke', 'comment', 'correction', 'topic', 'question', 'answer'] as const)(
  'R6-FLOW-002: %s is permitted without a novelty quota or compulsory closing question', act => {
    const f = fixture();
    try {
      f.say('自由に話す一つの題材'); f.start(); const r = foreground(f);
      f.finish(r, { decision: 'SPEAK', intent: { act, intent: 'own contribution, no novelty requirement', replyTo: null, addressedTo: [] } });
      const draft = foreground(f); f.finish(draft, { decision: 'DRAFT', text: 'そういう経験もありますね。' });
      expect(f.service.commitNext(f.id)).toMatchObject({ act, text: 'そういう経験もありますね。' });
    } finally { f.close(); }
  });
it('R6-FLOW-003: only the owner receives its published purpose beyond the recent message window; edits do not relabel old intentions as current', () => {
  const f = fixture(3, { contextMessages: 5, memoryEvery: 1000 });
  try {
    f.say('最初の題材'); f.start(); const first = foreground(f);
    const intent: Intent = { act: 'comment', intent: 'PRIVATE_PURPOSE_ONLY_A', replyTo: null, addressedTo: [] };
    f.finish(first, { decision: 'SPEAK', intent }); f.finish(foreground(f), { decision: 'DRAFT', text: '公開する発言' });
    const original = f.service.commitNext(f.id)!;
    for (let i = 0; i < 12; i++) f.say('新しい公開の文 ' + i);
    const owner = foreground(f); expect(owner.context.conversation!.recentPurposes).toContainEqual(expect.objectContaining({ messageId: original.id, purpose: intent.intent }));
    const peer = foreground(f, 'worker-1'); expect(JSON.stringify(peer.context)).not.toContain(intent.intent);
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain(intent.intent);
    f.finish(owner, { decision: 'ABSTAIN', reason: 'owner keeps listening' }); f.finish(peer, { decision: 'ABSTAIN', reason: 'peer keeps listening' });
    f.service.changeMessage(f.id, original.id, '編集された公開発言', randomUUID());
    const next = foreground(f); expect(next.context.conversation!.recentPurposes.some(p => p.messageId === original.id)).toBe(false);
    f.finish(next, { decision: 'ABSTAIN', reason: 'old purpose not asserted for edited message' });
  } finally { f.close(); }
});
it('R6-FLOW-004: owner loop restraint, ordinary quiet, new source input, errors and operator pause remain distinct', () => {
  const f = fixture(3, { memoryEvery: 1000 });
  try {
    f.say('確認した同じ質問'); f.say('質問をまた確認する返答'); f.start(); const r = foreground(f);
    const chosen = result(r); f.finish(r, chosen);
    expect(f.service.completeRun('worker-0', r.workerEpoch, r.id, r.token, chosen)).toEqual({ ok: true });
    expect(operations(f.service, f.id).agents[0].reason).toBe('CONTENT_LOOP');
    expect(f.service.agent(r.context.self.id).error_count).toBe(0);
    expect(f.store.all('SELECT * FROM agent_state_updates WHERE run_id=?', r.id)).toHaveLength(1);
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('PRIVATE_OWNER_DISPOSITION');
    const peer = foreground(f, 'worker-1'); expect(JSON.stringify(peer.context)).not.toContain('PRIVATE_OWNER_DISPOSITION');
    f.service.failRun('worker-1', peer.workerEpoch, peer.id, peer.token, 'API_ERROR');
    expect(operations(f.service, f.id).agents[1].reason).toBe('RETRY_WAIT');
    f.service.injectSource(f.id, { title: '次の題材', text: '新しい資料を受けた再検討' }, randomUUID());
    expect(currentDisposition(f.store, f.service.agent(r.context.self.id))).toBeNull();
    expect(operations(f.service, f.id).agents[0].reason).not.toBe('CONTENT_LOOP');
    const reconsider = foreground(f); expect(reconsider.context.conversation!.previousAssessment).toEqual({ code: 'CONTENT_LOOP', current: false });
    f.finish(reconsider, result(reconsider, [{ ...disposition(reconsider, 'SATISFIED'), evidence: [] }]));
    expect(operations(f.service, f.id).agents[0].reason).toBe('QUIET');
    f.service.lifecycle(f.id, 'pause', randomUUID()); expect(operations(f.service, f.id).agents[0].reason).toBe('SESSION_PAUSED');
  } finally { f.close(); }
});
it('R6-FLOW-005: forged/unobserved loop evidence, wrong input boundary and duplicate dispositions are rejected atomically', () => {
  const f = fixture();
  try {
    f.say('根拠一'); f.say('根拠二'); f.start(); const r = foreground(f), entry = disposition(r);
    const call = f.service.reserveCall('worker-0', r.workerEpoch, r.id, r.token, randomUUID(), 'primary');
    f.service.finishCall('worker-0', r.id, r.token, call.id, { inputTokens: null, outputTokens: null }, null);
    const invalid: PrivateStateEntry[][] = [
      [{ ...entry, evidence: entry.evidence.slice(0, 1) }],
      [{ ...entry, participation: { code: 'CONTENT_LOOP', throughInput: entry.participation!.throughInput + 1 } }],
      [{ ...entry, kind: 'understanding' }],
      [{ ...entry, evidence: [...entry.evidence, { kind: 'message', id: randomUUID(), version: 1 }] }],
      [entry, { ...entry, id: 'other-disposition' }],
    ];
    for (const entries of invalid) {
      expect(() => f.service.completeRun('worker-0', r.workerEpoch, r.id, r.token, result(r, entries))).toThrow();
      expect(f.store.all('SELECT * FROM agent_state_updates WHERE run_id=?', r.id)).toHaveLength(0);
      expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?', r.id)).toHaveLength(0);
      expect(f.service.agent(r.context.self.id).error_count).toBe(0);
    }
    f.service.completeRun('worker-0', r.workerEpoch, r.id, r.token, result(r));
    expect(currentDisposition(f.store, f.service.agent(r.context.self.id))).toBe('CONTENT_LOOP');
  } finally { f.close(); }
});
it('R6-FLOW-006: V6 online backup/restore retains owner disposition and audit; source deletion invalidates current interpretation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-flow-')), f = fixture(3, {}, join(directory, 'live.sqlite')); let db: Store | undefined;
  try {
    const source = f.say('保存する根拠'); f.say('反復として本人が検討する発言'); f.start(); const r = foreground(f); f.finish(r, result(r));
    f.service.lifecycle(f.id, 'pause', randomUUID());
    const expected = f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?', r.context.self.id);
    const backup = join(directory, 'backup.sqlite'), restored = join(directory, 'restored.sqlite');
    await backupDatabase(f.config.dbPath, backup); await restoreDatabase(backup, restored);
    db = new Store(restored); const service = new SessionService(db, { ...f.config, dbPath: restored }, f.now, () => 0); service.recover();
    expect(db.get('SELECT * FROM agent_private_states WHERE agent_id=?', r.context.self.id)).toEqual(expected);
    expect(currentDisposition(db, service.agent(r.context.self.id))).toBe('CONTENT_LOOP');
    service.changeMessage(f.id, source.id, null, randomUUID());
    expect(currentDisposition(db, service.agent(r.context.self.id))).toBeNull();
    expect(db.all("SELECT * FROM agent_state_updates WHERE kind='SOURCE_INVALIDATED'").length).toBeGreaterThan(0);
    expect(JSON.stringify(service.exportSession(f.id))).not.toContain('PRIVATE_OWNER_DISPOSITION');
  } finally { db?.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
