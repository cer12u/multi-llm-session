import { expect, it } from 'vitest';
import { fixture } from './helpers.js';

it('R2-STATE-001: a silent agent retains its own question for the next decision, without publishing or sharing it', () => {
  const f = fixture();
  try {
    const source = f.say('出発時間については、あとで説明します。');
    f.start();
    const run = f.claim()!;
    expect(run).not.toBeNull();
    expect(run.context.self).toHaveProperty('privateState');
    const observation = (run.context as { observation?: { id: string } }).observation;
    expect(observation).toBeDefined();
    f.finish(run, {
      action: { decision: 'ABSTAIN', reason: '今は聞いて、疑問を残す' },
      statePatch: {
        agentId: run.context.self.id, sessionId: f.id, expectedVersion: 0, observationId: observation!.id,
        upsert: [{ id: 'departure-question', kind: 'question', text: 'Aだけが保持する出発時間の疑問',
          evidence: [{ kind: 'message', id: source.id, version: source.revision }],
          resume: { kind: 'related_topic', agentId: null, notBefore: null, topic: '出発時間' } }], remove: [],
      },
    });
    expect(f.service.session(f.id).bot_count).toBe(0);
    f.say('旅程の説明を再開します。');
    expect(f.claim()!.context.self).toMatchObject({ privateState: { version: 1,
      entries: [{ id: 'departure-question', text: 'Aだけが保持する出発時間の疑問' }] } });
    for (const slot of ['worker-1', 'worker-2']) {
      const other = f.claim(slot)!;
      expect(other.context.self).toMatchObject({ privateState: { version: 0, entries: [] } });
      expect(JSON.stringify(other.context)).not.toContain('Aだけが保持する出発時間の疑問');
    }
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('Aだけが保持する出発時間の疑問');
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('Aだけが保持する出発時間の疑問');
  } finally { f.close(); }
});
