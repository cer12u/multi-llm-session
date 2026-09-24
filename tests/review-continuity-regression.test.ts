import { expect, it } from 'vitest';
import { fixture } from './helpers.js';

it('R4-REVIEW-000: a bare KEEP cannot advance partial review without reconstructing the candidate', () => {
  const f=fixture(3,{contextMessages:5,contextChars:12000});
  try {
    f.say('集合時刻は15時という初期情報');f.start();f.speak(f.claim()!);const draft=f.claim()!;
    f.say('訂正：集合時刻は16時です。');for(let i=0;i<40;i++)f.say('他の入力 '+i);
    f.finish(draft,{decision:'DRAFT',text:'集合時刻は15時です。'});
    const review=f.claim()!;expect(review.kind).toBe('review');expect(review.context.coverage?.complete).toBe(false);
    expect(()=>f.finish(review,{decision:'KEEP'})).toThrow('REVIEW_RECONSTRUCTION_REQUIRED');
    expect(f.service.commitNext(f.id)).toBeNull();
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',review.id)!.state).toBe('ACTIVE');
  } finally { f.close(); }
});
