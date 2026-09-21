import { expect, it } from 'vitest';
import { fixture } from './helpers.js';

it('R2-LOOP-001: a deferred participant still receives an explicit unprocessed input window', () => {
  const f = fixture();
  try {
    f.say('最初の入力'); f.start(); const first = f.claim()!;
    f.finish(first, { decision: 'DEFER', reason: '時刻まで発言を待つ', defer: { kind: 'time', afterMs: 10000, agentId: null } });
    f.say('待機中にも聞くべき他者の訂正');
    const listening = f.claim();
    expect(listening).not.toBeNull();
    expect(listening!.kind).toBe('observe');
    expect(listening!.context).toHaveProperty('delivery');
    expect(listening!.context.messages.some(m => m.text.includes('待機中にも'))).toBe(true);
    expect(f.service.session(f.id).bot_count).toBe(0);
  } finally { f.close(); }
});

it('R5-MEMORY-001: memory consumes the earliest unprocessed segment, not only the latest conversation window', () => {
  const f = fixture(3, { memoryEvery: 3, contextMessages: 5 });
  try {
    const oldest = f.say('最初の約束は水曜日');
    for (let i = 0; i < 230; i++) f.say('後続の会話 ' + i);
    f.start();
    let memory = null as ReturnType<typeof f.claim>;
    for (let i = 0; i < 8; i++) {
      const run = f.claim(); expect(run).not.toBeNull();
      if (run!.kind === 'memory') { memory = run; break; }
      f.finish(run!, { decision: 'ABSTAIN', reason: '聞く' });
    }
    expect(memory).not.toBeNull();
    expect(memory!.context).toHaveProperty('delivery');
    expect(memory!.context.messages[0].id).toBe(oldest.id);
    expect(memory!.context.messages.length).toBeLessThanOrEqual(5);
  } finally { f.close(); }
});
