import { inputHigh } from './source-access.js';
import { ensure, type Context, type PrivateStateEntry } from '../contracts/index.js';
import type { ConversationFlow, ParticipationAssessment } from '../contracts/participation.js';
import { repetitionSignals } from '../conversation/index.js';
import type { AgentRow, Store } from '../storage-sqlite/index.js';

function lastAssessment(entries: PrivateStateEntry[]): ParticipationAssessment | null {
  return entries.find(entry => entry.participation)?.participation ?? null;
}

/** Private purpose history belongs to this owner only; current public originals remain separate evidence. */
export function conversationFlow(store: Store, agent: AgentRow, context: Context): ConversationFlow {
  const rows = store.all<{ id: string; revision: number; act: string; intent_json: string }>(
    `SELECT m.id,m.revision,m.act,c.intent_json FROM messages m JOIN candidates c ON c.id=m.candidate_id
     WHERE m.session_id=? AND m.author_id=? AND c.agent_id=? AND c.state='COMMITTED' AND m.deleted=0
       AND m.revision=c.reviewed_revision+1 ORDER BY m.sequence DESC LIMIT 3`, agent.session_id, agent.id, agent.id);
  const assessment = lastAssessment(context.self.privateState?.entries ?? []);
  const window = context.messages.filter(m => !m.deleted).slice(-8);
  return {
    advisoryOnly: true, window: { messageIds: window.map(m => m.id), completeHistory: false },
    signals: repetitionSignals(window),
    recentPurposes: rows.reverse().map(row => {
      const purpose = (JSON.parse(row.intent_json) as { intent: string }).intent;
      return { messageId: row.id, revision: row.revision, act: row.act, purpose: purpose.slice(0, 160), excerpt: purpose.length > 160 };
    }),
    previousAssessment: assessment ? { code: assessment.code, current: assessment.throughInput === inputHigh(store, agent.session_id,agent.id) } : null,
  };
}

/** Additional structural checks; normal private-state validation already checks exact observed versions and ownership. */
export function validateParticipationEntry(context: Context, kind: string, entry: PrivateStateEntry): void {
  if (!entry.participation) return;
  ensure(entry.kind === 'intention' && ['decide', 'draft', 'review'].includes(kind), 422, 'PARTICIPATION_DECISION_REQUIRED');
  ensure(context.delivery?.complete && entry.participation.throughInput === context.delivery.throughInput, 422, 'PARTICIPATION_INPUT_MISMATCH');
  if (entry.participation.code === 'CONTENT_LOOP') {
    ensure(new Set(entry.evidence.filter(ref => ref.kind === 'message').map(ref => ref.id)).size >= 2, 422, 'LOOP_EVIDENCE_REQUIRED');
  }
}

/** Read-only operator reason. New authorized source OR message input invalidates an old disposition without deleting owner history. */
export function currentDisposition(store: Store, agent: AgentRow): ParticipationAssessment['code'] | null {
  const row = store.get<{ entries_json: string }>('SELECT entries_json FROM agent_private_states WHERE agent_id=?', agent.id);
  const assessment = lastAssessment(row ? JSON.parse(row.entries_json) as PrivateStateEntry[] : []);
  return assessment && assessment.throughInput === inputHigh(store, agent.session_id,agent.id) ? assessment.code : null;
}
