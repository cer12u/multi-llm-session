import { expect, it } from 'vitest';
import { fixture } from './helpers.js';

it('R6-QUESTION-000: a directed human acknowledgement is not automatically a question', () => {
  const f = fixture();
  try {
    const target = f.service.agents(f.id)[1].id;
    const message = f.say('ありがとう、その話を覚えています。', [target]);
    expect(message.addressedTo).toEqual([target]);
    expect(message.act).toBe('comment');
    expect(f.store.all('SELECT * FROM pending_questions WHERE message_id=?', message.id)).toHaveLength(0);
  } finally { f.close(); }
});
