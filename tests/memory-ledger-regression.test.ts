import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';

it('R5-PROVENANCE-001: editing a source hides invalidated memory from recall without destroying its audit history', () => {
  const f = fixture(3, { memoryEvery: 3 });
  try {
    const source = f.say('本人の最初の予定は水曜日'); f.say('確認する'); f.say('記憶に残す'); f.start();
    f.finish(f.claim()!, { decision: 'ABSTAIN', reason: '聞く' });
    const run = f.claim()!; expect(run.kind).toBe('memory');
    f.finish(run, { notes: [{ text: '予定は水曜日だった', sourceMessageIds: [source.id] }] });
    const agent = run.context.self.id;
    const saved = f.service.workerMemories('worker-0', agent)[0]; expect(saved).toBeDefined();
    f.service.changeMessage(f.id, source.id, '本人が訂正した予定は木曜日', randomUUID());
    expect(f.service.pages.memories(agent, '水曜日').items).toHaveLength(0);
    expect(f.store.get('SELECT id FROM memories WHERE id=?', saved.id)).toEqual({ id: saved.id });
    expect(f.store.get<{ status: string }>('SELECT status FROM memory_metadata WHERE memory_id=?', saved.id)?.status).toBe('INVALID');
    expect(f.store.get("SELECT id FROM memory_changes WHERE agent_id=? AND kind='SOURCE_INVALIDATED'",agent)).toBeDefined();
    expect(f.service.workerMemories('worker-0',agent)).toHaveLength(0);
    expect(f.service.snapshot(f.id).messages.find(m => m.id === source.id)?.text).toContain('木曜日');
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('予定は水曜日だった');
  } finally { f.close(); }
});
