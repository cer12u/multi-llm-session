import { ensure, type PrivateState, type PrivateStateEntry, type QuestionHint } from '../contracts/index.js';
import type { Store, AgentRow, MessageRow } from '../storage-sqlite/index.js';

/** Called after normal observation/version checks, within the result transaction. */
export function validateQuestionEntry(store: Store, sessionId: string, entry: PrivateStateEntry): void {
  const question = entry.question;
  if (!question) return;
  ensure(entry.kind === 'question', 422, 'QUESTION_ENTRY_KIND');
  const required = [question.messageId, ...question.replyIds];
  const references = new Map(entry.evidence.filter(ref => ref.kind === 'message').map(ref => [ref.id, ref.version]));
  for (const id of required) {
    ensure(references.has(id), 422, 'QUESTION_EVIDENCE_REQUIRED');
    const row = store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?', id, sessionId);
    ensure(row && !row.deleted && row.revision === references.get(id), 422, 'STALE_QUESTION_EVIDENCE');
  }
  const original = store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?', question.messageId, sessionId)!;
  const explicit = JSON.parse(original.addressed_json) as string[];
  if (explicit.length) {
    ensure(question.addressing === 'explicit' && explicit.length === question.addressedTo.length &&
      explicit.every(id => question.addressedTo.includes(id)), 422, 'QUESTION_ADDRESSEE_MISMATCH');
  } else ensure(question.addressing !== 'explicit', 422, 'QUESTION_ADDRESS_NOT_EXPLICIT');
  for (const id of question.addressedTo) ensure(store.get('SELECT id FROM agent_instances WHERE id=? AND session_id=?', id, sessionId), 422, 'QUESTION_TARGET_FORBIDDEN');
}

/** Source indexes and private interpretation stay separate. Topics never partition delivery. */
export function questionHints(store: Store, agent: AgentRow, state: PrivateState): QuestionHint[] {
  ensure(state.agentId === agent.id && state.sessionId === agent.session_id, 403, 'STATE_OWNER_MISMATCH');
  const interpreted = new Map(state.entries.filter(entry => entry.question).map(entry => [entry.question!.messageId, entry.question!]));
  const ownIds = [...interpreted.keys()];
  const originals = ownIds.length ? store.all<MessageRow>(
    'SELECT * FROM messages WHERE session_id=? AND deleted=0 AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence',
    agent.session_id, JSON.stringify(ownIds)) : [];
  const recent = store.all<MessageRow>(
    "SELECT * FROM messages WHERE session_id=? AND deleted=0 AND act='question' ORDER BY sequence DESC LIMIT 8", agent.session_id);
  // Existing answered_by rows are legacy declared-answer links, not a semantic resolution verdict.
  const selected = new Map([...originals, ...recent].map(row => [row.id, row]));
  return [...selected.values()].map((row): QuestionHint => {
    const own = interpreted.get(row.id), addressedTo = JSON.parse(row.addressed_json) as string[];
    return { messageId: row.id, text: row.text.slice(0, 160), from: row.author_id, revision: row.revision,
      addressedTo, inferredAddressees: own?.addressing === 'inferred' ? own.addressedTo : [],
      addressing: addressedTo.length ? 'explicit' : own?.addressing ?? 'unknown',
      status: own?.status ?? 'unassessed', classification: row.act === 'question' ? 'declared-question' : 'owner-interpreted',
      topics: own?.topics ?? [], excerpt: row.text.length > 160 };
  });
}
