import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { asV6Fixture } from './fixtures/session-v6.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { CURRENT_SCHEMA_VERSION } from '../packages/storage-sqlite/schema-version.js';
import { SessionService } from '../packages/session-service/index.js';

it('R3-AGENDA-016: populated V4 migration preserves state, input receipts and limits while fencing old runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenda-v4-')), f = fixture(3, {}, join(dir, 'db.sqlite'));
  let db: Store | undefined;
  try {
    const source = f.say('Retained V4 original'); f.start(); const r = f.claim()!, state = r.context.self.privateState!;
    f.finish(r, { action: { decision: 'ABSTAIN', reason: 'Keep a future question' }, statePatch: {
      agentId: state.agentId, sessionId: f.id, expectedVersion: 0, observationId: r.context.observation!.id,
      upsert: [{ id: 'old-intention', kind: 'question', text: 'Question retained through upgrade', evidence: [],
        resume: { kind: 'time', notBefore: f.now() + 40000, agentId: null, topic: null } }], remove: [] } });
    f.say('Unfinished input'); const oldRun = f.claim()!;
    const before = f.store.get<{entries_json:string;version:number}>('SELECT * FROM agent_private_states WHERE agent_id=?', state.agentId)!;
    const receiptCount = f.store.all('SELECT * FROM agent_input_receipts').length;
    // Remove every post-V4 object in this isolated synthetic fixture, never in an operational rollback.
    asV6Fixture(f.store.db);
    f.store.db.exec('DROP TABLE memory_changes; DROP TABLE memory_edges; DROP TABLE memory_metadata; DROP TABLE agent_agenda_bindings; DROP TABLE agent_agenda_clock; DROP TABLE agent_agenda; PRAGMA user_version=4;'); f.close();
    db = new Store(f.config.dbPath); const service = new SessionService(db, f.config, f.now); service.recover();
    expect(db.db.pragma('user_version', {simple:true})).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.get('SELECT entries_json,version FROM agent_private_states WHERE agent_id=?', state.agentId)).toEqual({ entries_json: before.entries_json, version: before.version });
    expect(service.archiveMessage(f.id, source.id).text).toBe('Retained V4 original');
    expect(db.all('SELECT * FROM agent_input_receipts')).toHaveLength(receiptCount);
    expect(service.session(f.id).settings_json).toBe(JSON.stringify(f.config.defaults));
    expect(() => service.completeRun('worker-0', oldRun.workerEpoch, oldRun.id, oldRun.token, {decision:'ABSTAIN',reason:'old'})).toThrow();
    service.tick(); expect(db.all('SELECT * FROM agent_agenda')).toHaveLength(1);
    expect(db.get<{status:string}>('SELECT status FROM agent_agenda')!.status).toBe('PENDING');
    service.lifecycle(f.id, 'pause', randomUUID()); service.tick();
    expect(service.session(f.id).lifecycle).toBe('PAUSED');
  } finally { if (f.store.db.open) f.close(); db?.close(); rmSync(dir, {recursive:true,force:true}); }
});
