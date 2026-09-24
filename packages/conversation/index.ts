import type { PublicMessage } from '../contracts/index.js';
import type { RepetitionSignal } from '../contracts/participation.js';

const normal = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\p{P}\p{Z}\s]/gu, '');
const grams = (text: string) => {
  const points = [...normal(text)], result = new Set<string>();
  for (let i = 0; i + 2 < points.length; i++) result.add(points.slice(i, i + 3).join(''));
  return result;
};
function overlap(a: string, b: string): number {
  const x = grams(a), y = grams(b), common = [...x].filter(g => y.has(g)).length;
  return common / Math.max(1, x.size + y.size - common);
}
const refs = (messages: PublicMessage[]) => messages.map(m => ({ id: m.id, version: m.revision }));

/** Bounded structural/lexical hints. No semantic oracle, invocation, queue mutation or publication veto. */
export function repetitionSignals(input: PublicMessage[]): RepetitionSignal[] {
  const messages = [...new Map(input.filter(m => !m.deleted).map(m => [m.id, m])).values()]
    .sort((a, b) => a.sequence - b.sequence).slice(-8);
  const signals: RepetitionSignal[] = [];
  const add = (kind: RepetitionSignal['kind'], evidence: PublicMessage[]) => {
    if (!signals.some(s => s.kind === kind)) signals.push({ kind, algorithm: 'bounded-lexical-v1', evidence: refs(evidence) });
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    const latest = messages[i];
    if (latest.authorId === null) continue;
    const earlier = messages.slice(0, i);
    const parent = earlier.find(m => m.id === latest.replyTo && m.authorId === latest.authorId);
    if (parent) add('self_reply', [parent, latest]);
    if (latest.act === 'question' && [...normal(latest.text)].length >= 8) {
      const same = earlier.filter(m => m.authorId === latest.authorId && m.act === 'question' &&
        m.replyTo === latest.replyTo && normal(m.text) === normal(latest.text) &&
        JSON.stringify([...m.addressedTo].sort()) === JSON.stringify([...latest.addressedTo].sort()));
      if (same.length) add('repeated_question', [same.at(-1)!, latest]);
    }
    // Three overlapping contributions from multiple authors, rather than treating one agreement as a loop.
    if (['agreement', 'joke', 'correction'].includes(latest.act) || [...normal(latest.text)].length < 16) continue;
    const similar = [...earlier.filter(m => m.authorId !== null && !['agreement', 'joke', 'correction'].includes(m.act) &&
      [...normal(m.text)].length >= 16 && overlap(m.text, latest.text) >= 0.75), latest];
    if (similar.length >= 3 && new Set(similar.map(m => m.authorId)).size >= 2) add('reciprocal_overlap', similar.slice(-4));
  }
  return signals;
}
