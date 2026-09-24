import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { repetitionSignals } from '../packages/conversation/index.js';
import type { PublicMessage } from '../packages/contracts/index.js';

const sessionId = randomUUID(), authors = [randomUUID(), randomUUID(), randomUUID()];
function message(sequence: number, author: number, text: string, act = 'comment', replyTo: string | null = null): PublicMessage {
  const id = randomUUID();
  return { id, sessionId, sequence, revision: sequence, authorId: authors[author], authorName: 'Synthetic ' + author,
    characterId: 'fixture', characterVersion: 1, text, act, replyTo, addressedTo: [], deleted: false,
    threadRootId: replyTo ?? id, episode: 1, createdAt: sequence };
}
it('R6-FLOW-000: positive and counterexample corpus separates lexical repetition, question cycles and self-replies from ordinary continuation', () => {
  const q1 = message(1, 0, '次の会合は何曜日の何時から始まりますか？', 'question');
  const q2 = message(3, 0, q1.text, 'question');
  const long = '登山に出発する前には必ず現地の天気予報と交通情報を確認しておくべきです';
  const self = message(1, 0, '集合時刻は15時です。');
  const cases: { name: string; messages: PublicMessage[]; expected: string[]; reading: string }[] = [
    { name: 'repeated-question', messages: [q1, message(2, 1, '確認しています。'), q2], expected: ['repeated_question'], reading: '同じ宛先・返信先で同文の質問が再登場。未回答への再確認でもあり得るため、抑制は本人が判断する。' },
    { name: 'reciprocal-rewording', messages: [message(1, 0, long), message(2, 1, long + '。同感です。'), message(3, 0, 'そうですね、' + long)], expected: ['reciprocal_overlap'], reading: '二者による三つの高い字句重複。意味の同一性や不要性を独立証明する指標ではない。' },
    { name: 'self-correction', messages: [self, message(2, 0, '訂正します。集合は16時です。', 'correction', self.id)], expected: ['self_reply'], reading: '自己返信だが有用な訂正。自己返信という構造だけで拒否してはいけない。' },
    { name: 'empathy', messages: [message(1, 0, '大変でしたね。話してくれてありがとうございます。', 'agreement'), message(2, 1, '大変でしたね。話してくれてありがとうございます。', 'agreement'), message(3, 2, '大変でしたね。話してくれてありがとうございます。', 'agreement')], expected: [], reading: '新情報がなくても共感として許可する。' },
    { name: 'jokes', messages: [0, 1, 2].map((a, i) => message(i + 1, a, long, 'joke')), expected: [], reading: '繰り返しを使う冗談は字句重複だけで停止しない。' },
    { name: 'different-question', messages: [q1, message(2, 0, '次の会合はオンラインでも参加できますか？', 'question')], expected: [], reading: '同じ会合の話題でも質問する内容が異なる。' },
    { name: 'changed-target', messages: [q1, { ...q2, addressedTo: [authors[2]] }], expected: [], reading: '別の相手への明示質問は同じ質問循環と断定しない。' },
    { name: 'two-contributions', messages: [message(1, 0, long), message(2, 1, long)], expected: [], reading: '二つの言い換え・引用だけでは相互循環としない。' },
    { name: 'ordinary-continuation', messages: [message(1, 0, '登山に出かける予定です。'), message(2, 1, '昨年はその山で綺麗な紅葉を見ました。'), message(3, 2, '紅葉なら秋の写真も見比べてみたいですね。')], expected: [], reading: '経験談を受けた話題継続は反復と分ける。' },
    { name: 'deleted-original', messages: [{ ...q1, deleted: true }, q2], expected: [], reading: '削除済みの内容を現在の反復根拠にしない。' },
  ];
  const results = cases.map(c => {
    const signals = repetitionSignals(c.messages), actual = signals.map(s => s.kind).sort();
    expect(actual, c.name).toEqual([...c.expected].sort());
    for (const signal of signals) for (const ref of signal.evidence) expect(c.messages.some(m => !m.deleted && m.id === ref.id && m.revision === ref.version)).toBe(true);
    return { name: c.name, expected: c.expected, actual, reading: c.reading };
  });
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/conversation-signals.json', JSON.stringify({ mode: 'synthetic-authored-corpus', humanReviewed: false,
    automaticVeto: false, semanticAccuracyMeasured: false, cases: results }, null, 2));
});
it('R6-FLOW-001: analysis is bounded to eight originals and never mutates caller data', () => {
  const messages = Array.from({ length: 50 }, (_, i) => message(i + 1, i % 3, '別の発言 ' + i));
  const before = structuredClone(messages); repetitionSignals(messages); expect(messages).toEqual(before);
  messages[49] = { ...messages[49], text: messages[0].text, act: 'question' }; messages[0].act = 'question';
  expect(repetitionSignals(messages).some(s => s.kind === 'repeated_question')).toBe(false);
});
