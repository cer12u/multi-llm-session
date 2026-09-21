import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { StatePatchSchema, type ClaimedRun, type PrivateStateEntry, type StatePatch } from '../packages/contracts/index.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(...args: Parameters<typeof fixture>) {
  const f = fixture(...args); cleanup.push(() => { if (f.store.db.open) f.close(); }); return f;
}
function claim(f: ReturnType<typeof fixture>) { const r = f.claim(); expect(r).not.toBeNull(); return r!; }
function entry(r: ClaimedRun, id = 'question'): PrivateStateEntry {
  const source = r.context.messages.find(m => !m.deleted)!;
  return { id, kind: 'question', text: '自分だけの保留した疑問 ' + id,
    evidence: [{ kind: 'message', id: source.id, version: source.revision }],
    resume: { kind: 'related_topic', agentId: null, notBefore: null, topic: '後で確認' } };
}
function patch(r: ClaimedRun, upsert = [entry(r)], remove: string[] = []): StatePatch {
  return { agentId: r.context.self.id, sessionId: r.context.self.privateState!.sessionId,
    expectedVersion: r.context.self.privateState!.version, observationId: r.context.observation!.id, upsert, remove };
}
function output(r: ClaimedRun, change = patch(r)) {
  return { action: { decision: 'ABSTAIN' as const, reason: '聞いて状態だけ更新する' }, statePatch: change };
}
function state(f: ReturnType<typeof fixture>, agentId = f.service.agents(f.id)[0].id) {
  return f.store.get<{ version: number; entries_json: string }>('SELECT * FROM agent_private_states WHERE agent_id=?', agentId)!;
}

describe('R2 private working state: transactions and ownership, not natural-language quality', () => {
  it('R2-STATE-002: same result is applied once; conflicting retransmission cannot mutate state', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f), result = output(r);
    f.finish(r, result);
    expect(f.service.completeRun('worker-0', r.workerEpoch, r.id, r.token, result)).toEqual({ ok: true });
    expect(state(f).version).toBe(1);
    expect(f.store.all('SELECT * FROM agent_state_updates WHERE run_id=?', r.id)).toHaveLength(1);
    const changed = structuredClone(result); changed.statePatch.upsert[0].text = '別の結果';
    expect(() => f.service.completeRun('worker-0', r.workerEpoch, r.id, r.token, changed)).toThrow('IDEMPOTENCY_CONFLICT');
    expect(state(f).entries_json).not.toContain('別の結果');
  });

  it.each(['agent', 'session', 'version', 'observation'] as const)('R2-STATE-003: rejects forged %s binding', field => {
    const f = setup(); f.say(); f.start(); const r = claim(f), change = patch(r);
    if (field === 'agent') change.agentId = f.service.agents(f.id)[1].id;
    if (field === 'session') change.sessionId = f.service.createSession(f.input, randomUUID()).id;
    if (field === 'version') change.expectedVersion++;
    if (field === 'observation') change.observationId = '0'.repeat(64);
    const code = field === 'version' ? 'STALE_PRIVATE_STATE' : field === 'observation' ? 'STATE_OBSERVATION_MISMATCH' : 'STATE_OWNER_MISMATCH';
    expect(() => f.finish(r, output(r, change))).toThrow(code);
    expect(state(f).version).toBe(0);
    expect(f.store.all('SELECT * FROM agent_state_updates')).toHaveLength(0);
  });

  it('R2-STATE-004: a competing version rejects the whole action, including candidate creation', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f), change = patch(r);
    f.store.tx(() => f.store.run('UPDATE agent_private_states SET version=version+1 WHERE agent_id=?', r.context.self.id));
    const action = { decision: 'SPEAK', intent: { act: 'comment', intent: '古い判断', replyTo: null, addressedTo: [] } };
    expect(() => f.finish(r, { action, statePatch: change })).toThrow('STALE_PRIVATE_STATE');
    expect(f.store.all('SELECT * FROM candidates')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM agent_state_updates')).toHaveLength(0);
    expect(f.store.get<{ state: string }>('SELECT state FROM runs WHERE id=?', r.id)!.state).toBe('ACTIVE');
    expect(state(f).entries_json).toBe('[]');
  });

  it('R2-STATE-005: old worker, wrong slot and paused-session outputs cannot apply a patch', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f), result = output(r);
    expect(() => f.service.completeRun('worker-1', r.workerEpoch, r.id, r.token, result)).toThrow('RUN_FORBIDDEN');
    f.service.registerWorker('worker-0');
    expect(() => f.service.completeRun('worker-0', r.workerEpoch, r.id, r.token, result)).toThrow('STALE_WORKER');
    expect(state(f).version).toBe(0);
    const other = setup(); other.say(); other.start(); const pending = claim(other);
    other.service.lifecycle(other.id, 'pause', randomUUID());
    expect(() => other.service.completeRun('worker-0', pending.workerEpoch, pending.id, pending.token, output(pending))).toThrow('STALE_RUN');
    expect(state(other).version).toBe(0);
  });

  it('R2-STATE-006: restart retains state/version; another session using the same character starts empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-state-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = setup(3, {}, join(dir, 'session.sqlite')); f.say(); f.start(); const r = claim(f);
    f.finish(r, output(r)); const before = state(f); f.close();
    const db = new Store(f.config.dbPath); cleanup.push(() => db.close());
    const service = new SessionService(db, f.config, f.now); service.recover();
    const epoch = service.registerWorker('worker-0').epoch, resumed = service.claim('worker-0', epoch)!;
    expect(resumed.context.self.privateState).toMatchObject({ agentId: r.context.self.id, version: before.version });
    expect(resumed.context.self.privateState!.entries).toEqual(JSON.parse(before.entries_json));
    service.lifecycle(f.id, 'pause', randomUUID());
    const nextId = service.createSession(f.input, randomUUID()).id; service.lifecycle(nextId, 'start', randomUUID());
    const other = service.claim('worker-0', epoch)!;
    expect(other.context.self.privateState).toMatchObject({ sessionId: nextId, version: 0, entries: [] });
    expect(other.context.self.id).not.toBe(r.context.self.id);
  });

  it.each(['unseen', 'foreign', 'wrong-version'] as const)('R2-STATE-007: rejects %s evidence rather than trusting its ID', kind => {
    const f = setup(3, { contextMessages: 5 }); f.say('最初の観測対象');
    for (let i = 0; i < 7; i++) f.say('未処理入力 ' + i);
    // Sequential observation supplies the FIRST five inputs, not the latest five.
    const old = f.say('まだ供給していない後方の入力');
    const foreignSession = f.service.createSession(f.input, randomUUID()).id;
    const foreign = f.service.humanMessage(foreignSession, { text: '別部屋' }, randomUUID());
    f.start(); const r = claim(f), change = patch(r);
    const ref = kind === 'foreign' ? foreign : old;
    change.upsert[0].evidence = [{ kind: 'message', id: ref.id, version: kind === 'wrong-version' ? ref.revision + 100 : ref.revision }];
    expect(() => f.finish(r, output(r, change))).toThrow('UNOBSERVED_STATE_EVIDENCE');
    expect(state(f).version).toBe(0);
    expect(r.context.observation!.scope).toBe('selected-input-only');
    expect(r.context.observation!.messages.some(m => m.id === old.id)).toBe(false);
  });

  it('R2-STATE-008: an edit after observation cannot ground a new private statement in the old version', () => {
    const f = setup(); const source = f.say('元の説明'); f.start(); const r = claim(f), change = patch(r);
    f.service.changeMessage(f.id, source.id, '訂正された説明', randomUUID());
    expect(() => f.finish(r, output(r, change))).toThrow('STALE_STATE_EVIDENCE');
    expect(state(f).version).toBe(0);
  });

  it.each(['edit', 'delete'] as const)('R2-STATE-009: %s invalidates dependent state and fences the earlier request', kind => {
    const f = setup(); const source = f.say('根拠'); f.start(); const first = claim(f); f.finish(first, output(first));
    f.say('続き'); const stale = claim(f);
    f.service.changeMessage(f.id, source.id, kind === 'delete' ? null : '新しい根拠', randomUUID());
    expect(state(f).version).toBe(2); expect(state(f).entries_json).toBe('[]');
    expect(() => f.finish(stale, { action: { decision: 'ABSTAIN', reason: '古い入力' }, statePatch: null })).toThrow('STALE_PRIVATE_STATE');
    const audit = f.store.all<{ kind: string; before_json: string }>('SELECT * FROM agent_state_updates WHERE agent_id=? ORDER BY id', first.context.self.id);
    expect(audit.at(-1)!.kind).toBe('SOURCE_INVALIDATED');
    expect(audit.at(-1)!.before_json).toContain('自分だけの保留した疑問');
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('自分だけの保留した疑問');
  });

  it('R2-STATE-010: no-change and failure are distinct; failed calls do not advance private state', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f);
    f.finish(r, { action: { decision: 'ABSTAIN', reason: '変更不要' }, statePatch: null });
    expect(state(f).version).toBe(0);
    expect(f.store.get<{ from_version: number; to_version: number }>('SELECT * FROM agent_state_updates WHERE run_id=?', r.id)).toMatchObject({ from_version: 0, to_version: 0 });
    f.say('新着'); const failed = claim(f);
    f.service.failRun('worker-0', failed.workerEpoch, failed.id, failed.token, 'API_ERROR');
    expect(state(f).version).toBe(0);
    expect(f.store.get('SELECT * FROM agent_state_updates WHERE run_id=?', failed.id)).toBeUndefined();
    expect(f.claim('worker-1')).not.toBeNull();
  });

  it('R2-STATE-011: DEFER stores working state without a public utterance', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f);
    f.finish(r, { action: { decision: 'DEFER', reason: '話題が戻るまで待つ', defer: { kind: 'new_message', afterMs: 10000, agentId: null } }, statePatch: patch(r) });
    expect(state(f).version).toBe(1); expect(f.service.session(f.id).bot_count).toBe(0);
    expect(f.service.agent(r.context.self.id).deferral_json).not.toBeNull();
    f.say('話題が戻りました'); expect(claim(f).context.self.privateState!.entries).toHaveLength(1);
  });

  it('R2-STATE-012: explicit removal preserves private journal history and unrelated entries', () => {
    const f = setup(); f.say(); f.start(); const first = claim(f);
    f.finish(first, output(first, patch(first, [entry(first, 'one'), entry(first, 'two')])));
    f.say('一つだけ解決'); const next = claim(f); f.finish(next, output(next, patch(next, [], ['one'])));
    expect(JSON.parse(state(f).entries_json).map((e: PrivateStateEntry) => e.id)).toEqual(['two']);
    expect(state(f).version).toBe(2);
    expect(f.store.get<{ before_json: string }>('SELECT before_json FROM agent_state_updates WHERE run_id=?', next.id)!.before_json).toContain('"id":"one"');
  });

  it('R2-STATE-013: duplicate operations and cross-session resume targets are rejected atomically', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f), bad = patch(r);
    bad.remove = ['question']; expect(() => f.finish(r, output(r, bad))).toThrow('DUPLICATE_STATE_OPERATION');
    expect(state(f).version).toBe(0);
    const other = setup(); other.say(); other.start(); const active = claim(other);
    const foreignId = other.service.createSession(other.input, randomUUID()).id;
    const wrong = patch(active); wrong.upsert[0].resume = { kind: 'answer_from', agentId: other.service.agents(foreignId)[0].id, notBefore: null, topic: null };
    expect(() => other.finish(active, output(active, wrong))).toThrow('INVALID_STATE_RESUME_TARGET');
    expect(state(other).version).toBe(0);
  });

  it('R2-STATE-014: source references are bound to the source actually supplied to this agent', () => {
    const f = setup(); f.say(); f.service.injectSource(f.id, { title: '資料', text: '後で検討する資料本文' }, randomUUID());
    f.start(); const r = claim(f), change = patch(r); change.upsert[0].evidence = r.context.observation!.sources;
    expect(change.upsert[0].evidence).toHaveLength(1); f.finish(r, output(r, change));
    expect(state(f).version).toBe(1);
  });

  it('R2-STATE-015: schema rejects state owner injection in action and contradictory resume fields', () => {
    const f = setup(); f.say(); f.start(); const r = claim(f), change = patch(r);
    change.upsert[0].resume = { kind: 'time', agentId: null, notBefore: 12345, topic: '余計な条件' };
    expect(() => StatePatchSchema.parse(change)).toThrow();
    expect(() => f.finish(r, { decision: 'ABSTAIN', reason: 'x', agentId: f.service.agents(f.id)[1].id })).toThrow();
    expect(state(f).version).toBe(0);
  });
});

it('R2-STATE-020: a populated V2 database migrates with notes, IDs, settings and empty V3 working state preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'private-state-v2-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = setup(3, {}, join(dir, 'session.sqlite')); const source = f.say('移行前の根拠');
  const agent = f.service.agents(f.id)[0], memoryId = randomUUID();
  f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)', memoryId, agent.id, '出典の確度を勝手に昇格しない旧メモ', JSON.stringify([source.id]), f.now(), 1);
  f.store.run('UPDATE agent_instances SET memory_seq=1 WHERE id=?', agent.id);
  // Build an actual V2 fixture by removing every additive V3/V4/V5 object; this is NOT a rollback procedure.
  f.store.db.exec(`DROP TABLE agent_agenda_bindings; DROP TABLE agent_agenda_clock; DROP TABLE agent_agenda;
    DROP TRIGGER input_message_insert; DROP TRIGGER input_message_update; DROP TRIGGER input_source_insert;
    DROP TABLE memory_input_origins; DROP TABLE candidate_state_bindings; DROP TABLE agent_input_receipts;
    DROP TABLE agent_input_cursors; DROP TABLE agent_input_log;
    DROP TABLE agent_state_updates; DROP TABLE agent_private_states; PRAGMA user_version=2;`); f.close();
  const db = new Store(f.config.dbPath); cleanup.push(() => db.close()); const service = new SessionService(db, f.config, f.now);
  expect(db.db.pragma('user_version', { simple: true })).toBe(5);
  expect(service.snapshot(f.id).messages[0].id).toBe(source.id);
  expect(service.workerMemories(agent.slot, agent.id)).toHaveLength(1);
  expect(service.workerMemories(agent.slot, agent.id)[0]).toMatchObject({ id: memoryId });
  expect(service.session(f.id).settings_json).toBe(JSON.stringify(f.config.defaults));
  const states = db.all<{ version: number; entries_json: string }>('SELECT * FROM agent_private_states');
  expect(states).toHaveLength(3); expect(states.every(s => s.version === 0 && s.entries_json === '[]')).toBe(true);
});

it('R2-STATE-021: exceeding working-state capacity rejects the patch, never evicts previous entries', () => {
  const f = setup(); f.say(); f.start();
  for (let batch = 0; batch < 2; batch++) {
    if (batch) f.say('別の確認');
    const r = claim(f); f.finish(r, output(r, patch(r, Array.from({ length: 8 }, (_, i) => entry(r, `q-${batch}-${i}`)))));
  }
  const before = state(f); expect(JSON.parse(before.entries_json)).toHaveLength(16);
  f.say('容量を超える入力'); const r = claim(f);
  expect(() => f.finish(r, output(r, patch(r, [entry(r, 'overflow')])))).toThrow();
  expect(state(f)).toEqual(before);
  expect(f.store.all('SELECT * FROM agent_state_updates WHERE run_id=?', r.id)).toHaveLength(0);
});
