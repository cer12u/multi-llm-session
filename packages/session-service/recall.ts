import type { Context, MemoryNote } from '../contracts/index.js';
import type { Store, MessageRow } from '../storage-sqlite/index.js';

export type RecallRequest = { sessionId: string; agentId: string; text: string; evidenceIds: string[]; limit: number };
export type RecallCandidate = { note: MemoryNote; score: number; originals: MessageRow[]; provenance: 'versioned' | 'legacy-unversioned' };
export interface MemoryRetriever { search(request: RecallRequest): RecallCandidate[] }

/** Deterministic baseline, not semantic equivalence: exact word relevance plus personal evidence links. */
export class LocalMemoryRetriever implements MemoryRetriever {
  constructor(private readonly store: Store) {}
  search(request: RecallRequest): RecallCandidate[] {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    const terms = [...new Set([...segmenter.segment(request.text.toLocaleLowerCase('ja'))]
      .filter(s => s.isWordLike && [...s.segment].length >= 2).map(s => s.segment))].slice(0, 32);
    const rows = this.store.all<{ id: string; text: string; sources_json: string; score: number; evidence_json: string | null }>(`
      SELECT m.id,m.text,m.sources_json,o.evidence_json,
        (SELECT COUNT(*) FROM json_each(?) t WHERE instr(lower(m.text),t.value)>0) +
        4*(SELECT COUNT(*) FROM json_each(m.sources_json) s JOIN json_each(?) e ON s.value=e.value) score
      FROM memories m LEFT JOIN memory_input_origins o ON o.memory_id=m.id
      WHERE m.agent_id=? AND json_array_length(m.sources_json)>0
        AND NOT EXISTS (SELECT 1 FROM json_each(m.sources_json) s WHERE NOT EXISTS
          (SELECT 1 FROM messages x WHERE x.id=s.value AND x.session_id=? AND x.deleted=0))
        AND (o.evidence_json IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(o.evidence_json) e WHERE NOT EXISTS
          (SELECT 1 FROM messages x WHERE x.id=json_extract(e.value,'$.id') AND x.session_id=? AND x.deleted=0
            AND x.revision=json_extract(e.value,'$.version'))))
      ORDER BY score DESC,m.sequence DESC LIMIT ?`, JSON.stringify(terms), JSON.stringify(request.evidenceIds),
      request.agentId, request.sessionId, request.sessionId, request.limit);
    return rows.map(row => {
      const ids = JSON.parse(row.sources_json) as string[];
      return { note: { id: row.id, text: row.text, sourceMessageIds: ids }, score: row.score,
        originals: this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence', request.sessionId, row.sources_json),
        provenance: row.evidence_json ? 'versioned' : 'legacy-unversioned' };
    });
  }
}

export function recallRequest(context: Context, sessionId: string, agentId: string): RecallRequest {
  const entries = context.self.privateState?.entries ?? [];
  return { sessionId, agentId, limit: 12,
    text: [...context.messages.slice(-3).map(m => m.text), ...context.questions.map(q => q.text), ...entries.map(e => e.text)].join('\n'),
    evidenceIds: [...new Set([...entries.flatMap(e => e.evidence.filter(r => r.kind === 'message').map(r => r.id)),
      ...context.questions.map(q => q.messageId)])] };
}
