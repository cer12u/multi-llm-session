import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import type { ClaimedRun, PrivateStateEntry, Settings } from '../packages/contracts/index.js';

type F = ReturnType<typeof fixture>;
type Condition = NonNullable<PrivateStateEntry['resume']>;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const quiet = { decision: 'ABSTAIN', reason: 'Synthetic choice to listen' };
function setup(settings: Partial<Settings> = {}, path = ':memory:') {
  const f = fixture(3, { agendaMinIntervalMs: 1000, idleMs: 60000, memoryEvery: 1000, memoryFlushMs: 600000, ...settings }, path);
  cleanup.push(() => { if (f.store.db.open) f.close(); });
  f.say('Initial public input'); f.start(); return f;
}
function claim(f: F, slot = 'worker-0') { const r = f.claim(slot); expect(r).not.toBeNull(); return r!; }
function result(r: ClaimedRun, resume: Condition | null, action: unknown = quiet, remove = false) {
  const s = r.context.self.privateState!;
  return { action, statePatch: { agentId: s.agentId, sessionId: s.sessionId, expectedVersion: s.version,
    observationId: r.context.observation!.id,
    upsert: remove ? [] : [{ id: 'private-plan', kind: 'question', text: 'Only this owner retains this question', evidence: [], resume }],
    remove: remove ? ['private-plan'] : [] } };
}
function timed(f: F, delay = 1000): Condition { return { kind: 'time', notBefore: f.now() + delay, agentId: null, topic: null }; }
function plans(f: F) { return f.store.all<{id:string;status:string;notified:number;effective_at:number}>('SELECT * FROM agent_agenda ORDER BY rowid'); }
function wakes(f: F) { return f.store.all("SELECT * FROM traces WHERE session_id=? AND code='AGENDA_WAKE'", f.id).length; }
function publish(f: F, slot: string, text: string) {
  f.speak(claim(f, slot)); f.finish(claim(f, slot), { decision: 'DRAFT', text });
  const posted = f.service.commitNext(f.id); expect(posted).not.toBeNull(); return posted!;
}

it('R3-AGENDA-002: withdrawal and replacement cancel old plan identity rather than rearming it', () => {
  const f = setup(); f.finish(claim(f), result(claim(f), timed(f)));
  const first = plans(f)[0].id;
  f.say('Reconsider'); const next = claim(f); f.finish(next, result(next, timed(f, 2000)));
  expect(plans(f).map(p => p.status)).toEqual(['CANCELLED', 'PENDING']);
  expect(plans(f)[1].id).not.toBe(first);
  f.advance(1000); expect(f.claim()).toBeNull();
  f.say('Withdraw'); const remove = claim(f); f.finish(remove, result(remove, null, quiet, true));
  f.advance(1000); expect(f.claim()).toBeNull(); expect(wakes(f)).toBe(0);
  expect(plans(f).every(p => p.status === 'CANCELLED')).toBe(true);
});

it('R3-AGENDA-003: result replay and unrelated private text updates do not rearm a consumed condition', () => {
  const f = setup(), initial = claim(f), condition = timed(f); f.finish(initial, result(initial, condition));
  f.advance(1000); const due = claim(f); const out = result(due, condition); f.finish(due, out);
  f.service.completeRun('worker-0', due.workerEpoch, due.id, due.token, out);
  f.say('Another ordinary input'); const ordinary = claim(f); const changed = result(ordinary, condition);
  changed.statePatch.upsert[0].text = 'Same condition, changed question wording'; f.finish(ordinary, changed);
  for (let i = 0; i < 10; i++) { f.service.tick(); expect(f.claim()).toBeNull(); }
  expect(plans(f)).toHaveLength(1); expect(plans(f)[0].status).toBe('CONSUMED'); expect(wakes(f)).toBe(1);
});

it('R3-AGENDA-004: related source resumes a deferred owner; unrelated input is still observed without publication', () => {
  const f = setup(), r = claim(f);
  f.finish(r, result(r, { kind: 'related_topic', topic: 'RAIN', agentId: null, notBefore: null },
    { decision: 'DEFER', reason: 'Await a related topic', defer: { kind: 'time', afterMs: 10000, agentId: null } }));
  f.say('Unrelated gardening'); const observed = claim(f); expect(observed.kind).toBe('observe'); f.finish(observed, quiet);
  expect(f.service.agents(f.id)[0].deferral_json).not.toBeNull();
  const source = f.service.injectSource(f.id, { title: 'ｒａｉｎ forecast', text: 'A synthetic source, not real weather' }, randomUUID());
  const resumed = claim(f); expect(resumed.kind).toBe('decide'); expect(resumed.context.trigger).toBe('AGENDA');
  expect(resumed.context.agenda!.triggered).toHaveLength(1); expect(resumed.context.sources.some(s => s.id === source.id)).toBe(true);
  expect(f.service.agents(f.id)[0].deferral_json).toBeNull(); f.finish(resumed, quiet);
  expect(f.service.session(f.id).bot_count).toBe(0); expect(plans(f)[0].status).toBe('CONSUMED');
});

it('R3-AGENDA-005: selected-author condition is not triggered by another speaker mentioning their name', () => {
  const f = setup(), [a,b] = f.service.agents(f.id), initial = claim(f);
  f.finish(initial, result(initial, { kind: 'answer_from', agentId: b.id, notBefore: null, topic: null },
    { decision: 'DEFER', reason: 'Await this participant', defer: { kind: 'time', afterMs: 10000, agentId: null } }));
  publish(f, 'worker-2', 'Mention the other participant without speaking as them');
  const heardC = claim(f); expect(heardC.kind).toBe('observe'); expect(heardC.context.agenda!.triggered).toHaveLength(0); f.finish(heardC, quiet);
  publish(f, b.slot, 'Now the selected participant speaks');
  const heardB = claim(f); expect(heardB.context.self.id).toBe(a.id); expect(heardB.context.trigger).toBe('AGENDA'); f.finish(heardB, quiet);
  expect(wakes(f)).toBe(1); expect(plans(f)[0].status).toBe('CONSUMED');
});

it('R3-AGENDA-006: own publication, viewers and diagnostics do not trigger a new-message agenda', () => {
  const f = setup(), r = claim(f);
  f.finish(r, result(r, { kind: 'new_message', agentId: null, notBefore: null, topic: null },
    { decision: 'SPEAK', intent: { act: 'comment', intent: 'One synthetic utterance', replyTo: null, addressedTo: [] } }));
  f.finish(claim(f), { decision: 'DRAFT', text: 'Own public utterance' }); f.service.commitNext(f.id);
  for (let i = 0; i < 5; i++) {
    f.service.snapshot(f.id); f.service.diagnostics(f.id); const pending = f.claim(); if (pending) { expect(pending.kind).toBe('observe'); f.finish(pending, quiet); }
  }
  expect(wakes(f)).toBe(0); expect(plans(f)[0].status).toBe('PENDING');
  const b = claim(f, 'worker-1'); expect(b.context.agenda!.pending).toHaveLength(0);
  expect(JSON.stringify(b.context)).not.toContain('Only this owner retains');
  expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('private-plan');
  expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('private-plan');
});

it('R3-AGENDA-007: all-silent participants stay quiet without polling the same silence interval', () => {
  const f = setup({ selfWakeEnabled: false, idleMs: 1000 });
  for (const slot of Object.keys(f.epochs)) f.finish(claim(f, slot), quiet);
  f.advance(1000);
  for (const slot of Object.keys(f.epochs)) f.finish(claim(f, slot), quiet);
  f.service.tick(); expect(f.service.session(f.id).activity).toBe('QUIET');
  const calls = f.service.session(f.id).call_count;
  for (let i = 0; i < 20; i++) for (const slot of Object.keys(f.epochs)) expect(f.claim(slot)).toBeNull();
  expect(f.service.session(f.id).call_count).toBe(calls); expect(f.service.session(f.id).bot_count).toBe(0);
});

it.each(['pause','disabled','end'] as const)('R3-AGENDA-008: %s gates pending jobs without overriding the operator', mode => {
  const f = setup(), r = claim(f); f.finish(r, result(r, timed(f)));
  f.service.lifecycle(f.id, mode === 'end' ? 'end' : 'pause', randomUUID());
  if (mode === 'disabled') { f.service.setAgentEnabled(f.id, r.context.self.id, false, randomUUID()); f.service.lifecycle(f.id, 'resume', randomUUID()); }
  f.advance(1000); f.service.tick(); expect(f.claim()).toBeNull(); expect(wakes(f)).toBe(0);
  expect(plans(f)[0].status).toBe(mode === 'end' ? 'CANCELLED' : 'PENDING');
  if (mode === 'pause') { f.service.lifecycle(f.id, 'resume', randomUUID()); const resumed = claim(f); expect(resumed.context.agenda!.triggered).toHaveLength(1); f.finish(resumed, quiet); }
});

it('R3-AGENDA-009: disabled timed wakes stay recorded; a call budget cannot be renewed by an agenda', () => {
  const disabled = setup({ selfWakeEnabled: false }), r = claim(disabled); disabled.finish(r, result(r, timed(disabled)));
  disabled.advance(1000); expect(disabled.claim()).toBeNull(); expect(wakes(disabled)).toBe(0);
  const d = disabled.service.diagnostics(disabled.id).agents as {agenda:{pending:{reason:string}[]}}[];
  expect(d[0].agenda.pending[0].reason).toBe('TIME_WAKE_DISABLED');
  const f = setup({ maxCalls: 1 }), first = claim(f); f.finish(first, result(first, timed(f)));
  f.advance(1000); expect(f.claim()).toBeNull(); expect(wakes(f)).toBe(0); expect(plans(f)[0].status).toBe('PENDING');
  f.service.lifecycle(f.id, 'pause', randomUUID()); f.service.renewBudget(f.id, randomUUID());
  expect(f.service.session(f.id).lifecycle).toBe('PAUSED');
  f.service.lifecycle(f.id, 'resume', randomUUID()); const due = claim(f); f.finish(due, quiet); expect(wakes(f)).toBe(1);
});

it('R3-AGENDA-010: overdue intention reports current budget exclusion and cannot exceed active-time limits', () => {
  const f = setup({ selfWakeMinMs: 100, selfWakeMaxMs: 100, maxDurationMs: 1000 }), r = claim(f);
  f.finish(r, result(r, timed(f, 5000)));
  const d = f.service.diagnostics(f.id).agents as {agenda:{pending:{reason:string}[]}}[];
  expect(d[0].agenda.pending[0].reason).toBe('OUTSIDE_CURRENT_BUDGET');
  f.advance(1000); f.service.tick(); expect(f.service.session(f.id).stop_reason).toBe('MAX_DURATION'); expect(wakes(f)).toBe(0);
});

it('R3-AGENDA-011: a triggered unacknowledged plan survives Core/Worker restart and is consumed once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenda-restart-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = setup({}, join(dir, 'db.sqlite')), first = claim(f); f.finish(first, result(first, timed(f)));
  f.advance(1000); const killed = claim(f), planId = plans(f)[0].id; f.close();
  const db = new Store(f.config.dbPath); cleanup.push(() => db.close()); const service = new SessionService(db, f.config, f.now); service.recover();
  const epoch = service.registerWorker('worker-0').epoch, next = service.claim('worker-0', epoch)!;
  expect(next.id).not.toBe(killed.id); expect(next.context.agenda!.triggered[0].planId).toBe(planId);
  const call = service.reserveCall('worker-0', epoch, next.id, next.token, randomUUID(), 'primary');
  service.finishCall('worker-0', next.id, next.token, call.id, { inputTokens: null, outputTokens: null }, null);
  service.completeRun('worker-0', epoch, next.id, next.token, quiet); service.completeRun('worker-0', epoch, next.id, next.token, quiet);
  expect(db.get<{status:string;consumed_run:string}>('SELECT * FROM agent_agenda WHERE id=?', planId)).toMatchObject({ status: 'CONSUMED', consumed_run: next.id });
  expect(() => service.completeRun('worker-0', killed.workerEpoch, killed.id, killed.token, quiet)).toThrow();
});

it('R3-AGENDA-012: an edited matching input rejects its old result, then re-evaluates without consuming the stale match', () => {
  const f = setup(), first = claim(f); f.finish(first, result(first, { kind: 'related_topic', topic: 'rain', agentId: null, notBefore: null }));
  const m = f.say('rain'); const stale = claim(f); expect(stale.context.agenda!.triggered).toHaveLength(1);
  f.service.changeMessage(f.id, m.id, 'sun', randomUUID());
  expect(() => f.finish(stale, quiet)).toThrow(); expect(plans(f)[0].status).not.toBe('CONSUMED');
  const next = claim(f); expect(next.id).not.toBe(stale.id); expect(next.context.agenda!.triggered).toHaveLength(0); f.finish(next, quiet);
  expect(plans(f)[0].status).toBe('PENDING'); expect(f.service.session(f.id).bot_count).toBe(0);
});

it('R3-AGENDA-013: input scanning crosses multiple pages and consumes no opportunity during observe-only catch-up', () => {
  const f = setup({ contextMessages: 5 }), initial = claim(f);
  f.finish(initial, result(initial, { kind: 'related_topic', topic: 'last-topic', agentId: null, notBefore: null }));
  for (let i = 0; i < 235; i++) f.say(i === 234 ? 'last-topic' : `Unrelated ${i}`);
  let decided = false;
  for (let i = 0; i < 80; i++) {
    const r = claim(f); if (r.kind === 'decide') { expect(r.context.agenda!.triggered).toHaveLength(1); decided = true; }
    f.finish(r, r.kind === 'memory' ? { notes: [] } : quiet);
    if (decided) break;
    expect(plans(f)[0].status).not.toBe('CONSUMED');
  }
  expect(decided).toBe(true); expect(wakes(f)).toBe(1); expect(plans(f)[0].status).toBe('CONSUMED');
});

it('R3-AGENDA-014: invalid foreign state update rolls back its action and never creates an agenda', () => {
  const f = setup(), r = claim(f), invalid = result(r, timed(f)); invalid.statePatch.agentId = f.service.agents(f.id)[1].id;
  expect(() => f.finish(r, invalid)).toThrow('STATE_OWNER_MISMATCH'); expect(plans(f)).toHaveLength(0);
});

it('R3-AGENDA-015: explicit rearming cannot bypass the minimum interval', () => {
  const f = setup(), first = claim(f); f.finish(first, result(first, timed(f, 1)));
  expect(plans(f)[0].effective_at).toBe(f.now() + 1000); f.advance(1000);
  const r = claim(f); f.finish(r, result(r, timed(f, 1)));
  expect(plans(f).map(p => p.status)).toEqual(['CONSUMED','PENDING']);
  for (let i = 0; i < 10; i++) expect(f.claim()).toBeNull();
  f.advance(999); expect(f.claim()).toBeNull(); f.advance(1); const due = claim(f); f.finish(due, quiet); expect(wakes(f)).toBe(2);
});
