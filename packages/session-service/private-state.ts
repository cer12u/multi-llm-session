import { createHash } from 'node:crypto';
import {
  ensure, PrivateStateSchema, StatePatchSchema,
  type Context, type EvidenceRef, type ObservationManifest, type PrivateState, type StatePatch,
} from '../contracts/index.js';
import type { Store, AgentRow, RunRow } from '../storage-sqlite/index.js';
import { currentMemoryPredicate } from './memory-ledger.js';
import { validateQuestionEntry } from './questions.js';

type StateRow = { agent_id: string; version: number; entries_json: string; updated_at: number };
const refKey = (ref: EvidenceRef) => `${ref.kind}:${ref.id}:${ref.version}`;
const distinct = (refs: EvidenceRef[]) => [...new Map(refs.map(ref => [refKey(ref), ref])).values()];

/** No model calls, public events, or independent write endpoint. SessionService owns every transaction. */
export class PrivateStates {
  constructor(private readonly store: Store, private readonly now: () => number) {}

  read(agentId: string, sessionId: string): PrivateState {
    const owner = this.store.get<{ session_id: string }>('SELECT session_id FROM agent_instances WHERE id=?', agentId);
    ensure(owner?.session_id === sessionId, 403, 'STATE_OWNER_MISMATCH');
    this.store.run('INSERT OR IGNORE INTO agent_private_states(agent_id,updated_at) VALUES(?,?)', agentId, this.now());
    const row = this.store.get<StateRow>('SELECT * FROM agent_private_states WHERE agent_id=?', agentId)!;
    return PrivateStateSchema.parse({ schemaVersion: 1, agentId, sessionId, version: row.version,
      entries: JSON.parse(row.entries_json), updatedAt: row.updated_at });
  }

  /** Recomputed after LOOKUP. Its ID binds the exact context, including private state and evidence text. */
  prepare(agent: AgentRow, input: Context): Context {
    const { observation: _previous, ...withoutManifest } = input;
    const context: Context = { ...withoutManifest, self: { ...input.self, privateState: this.read(agent.id, agent.session_id) } };
    context.observation = this.manifest(context);
    return context;
  }

  private manifest(context: Context): ObservationManifest {
    const { observation: _ignored, ...input } = context;
    const messages = distinct([...input.messages, ...input.delta, ...(input.retrieved ?? []).flatMap(r => r.messages)]
      .map(m => ({ kind: 'message' as const, id: m.id, version: m.revision })));
    const sources = distinct(input.sources.map(s => ({ kind: 'source' as const, id: s.id, version: s.fetchedAt })));
    return { id: createHash('sha256').update(JSON.stringify(input)).digest('hex'), targetRevision: input.revision,
      trigger: input.trigger, scope: 'selected-input-only', historyTruncated: input.historyTruncated, messages, sources };
  }

  /** The caller has already validated worker/session epochs, lease, run ownership and recorded call. */
  complete(run: RunRow, patch: StatePatch | null | undefined): { version: number; changed: boolean; observationId: string } {
    ensure(this.store.db.inTransaction, 500, 'STATE_TRANSACTION_REQUIRED');
    const context = JSON.parse(run.context_json) as Context;
    const captured = context.self.privateState, observed = context.observation;
    ensure(captured && observed && context.self.id === run.agent_id, 409, 'STATE_CONTEXT_REQUIRED');
    ensure(captured.agentId === run.agent_id && captured.sessionId === run.session_id, 403, 'STATE_OWNER_MISMATCH');
    ensure(observed.id === this.manifest(context).id, 409, 'STATE_OBSERVATION_MISMATCH');
    const current = this.read(run.agent_id, run.session_id);
    ensure(captured.version === current.version, 409, 'STALE_PRIVATE_STATE');
    const suppliedMemories=new Set([...context.memories,...(context.retrieved??[]).flatMap(r=>r.memories)].map(m=>m.id));
    for(const id of suppliedMemories)ensure(this.store.get(`SELECT m.id FROM memories m WHERE m.id=? AND m.agent_id=? AND ${currentMemoryPredicate()}`,id,run.agent_id),409,'STALE_MEMORY_EVIDENCE');
    const entries = new Map(current.entries.map(entry => [entry.id, entry]));
    if (patch) {
      patch = StatePatchSchema.parse(patch);
      ensure(patch.agentId === run.agent_id && patch.sessionId === run.session_id, 403, 'STATE_OWNER_MISMATCH');
      ensure(patch.expectedVersion === current.version, 409, 'STALE_PRIVATE_STATE');
      ensure(patch.observationId === observed.id, 409, 'STATE_OBSERVATION_MISMATCH');
      const ids = [...patch.upsert.map(entry => entry.id), ...patch.remove];
      ensure(new Set(ids).size === ids.length, 422, 'DUPLICATE_STATE_OPERATION');
      const allowed = new Set([...observed.messages, ...observed.sources].map(refKey));
      for (const entry of patch.upsert) {
        ensure(new Set(entry.evidence.map(refKey)).size === entry.evidence.length, 422, 'DUPLICATE_STATE_EVIDENCE');
        const parents=entry.derivedFrom??[];
        ensure(new Set(parents).size===parents.length,422,'DUPLICATE_STATE_MEMORY');
        for(const id of parents)ensure(suppliedMemories.has(id),422,'UNOBSERVED_STATE_MEMORY');
        for (const ref of entry.evidence) {
          ensure(allowed.has(refKey(ref)), 422, 'UNOBSERVED_STATE_EVIDENCE');
          if (ref.kind === 'message') {
            const source = this.store.get<{ session_id: string; revision: number; deleted: number }>('SELECT session_id,revision,deleted FROM messages WHERE id=?', ref.id);
            ensure(source?.session_id === run.session_id && !source.deleted && source.revision === ref.version, 422, 'STALE_STATE_EVIDENCE');
          } else {
            const source = this.store.get<{ session_id: string; fetched_at: number }>('SELECT session_id,fetched_at FROM source_items WHERE id=?', ref.id);
            ensure(source?.session_id === run.session_id && source.fetched_at === ref.version, 422, 'STALE_STATE_EVIDENCE');
          }
        }
        validateQuestionEntry(this.store, run.session_id, entry);
        if (entry.resume?.agentId) {
          const target = this.store.get<{ session_id: string }>('SELECT session_id FROM agent_instances WHERE id=?', entry.resume.agentId);
          ensure(target?.session_id === run.session_id && entry.resume.agentId !== run.agent_id, 422, 'INVALID_STATE_RESUME_TARGET');
        }
        entries.set(entry.id, entry);
      }
      for (const id of patch.remove) { ensure(entries.has(id), 422, 'UNKNOWN_STATE_ENTRY'); entries.delete(id); }
    }
    const nextEntries = [...entries.values()];
    const questionIds = nextEntries.flatMap(entry => entry.question ? [entry.question.messageId] : []);
    ensure(new Set(questionIds).size === questionIds.length, 422, 'DUPLICATE_QUESTION_ASSESSMENT');
    const changed = JSON.stringify(current.entries) !== JSON.stringify(nextEntries);
    const next = PrivateStateSchema.parse({ ...current, entries: nextEntries,
      version: current.version + (changed ? 1 : 0), updatedAt: changed ? this.now() : current.updatedAt });
    ensure(JSON.stringify(next).length <= 16000, 422, 'PRIVATE_STATE_CAPACITY');
    if (changed) {
      const result = this.store.run('UPDATE agent_private_states SET version=?,entries_json=?,updated_at=? WHERE agent_id=? AND version=?',
        next.version, JSON.stringify(next.entries), next.updatedAt, run.agent_id, current.version);
      ensure(result.changes === 1, 409, 'STALE_PRIVATE_STATE');
    }
    this.store.run(`INSERT INTO agent_state_updates(agent_id,run_id,kind,from_version,to_version,observation_json,patch_json,before_json,after_json,created_at)
      VALUES(?,?,'RUN_RESULT',?,?,?,?,?,?,?)`, run.agent_id, run.id, current.version, next.version,
      JSON.stringify(observed), JSON.stringify(patch ?? null), JSON.stringify(current.entries), JSON.stringify(next.entries), this.now());
    return { version: next.version, changed, observationId: observed.id };
  }

  invalidateMemories(sessionId:string,memoryIds:string[]):void {
    ensure(this.store.db.inTransaction,500,'STATE_TRANSACTION_REQUIRED');
    if(!memoryIds.length)return;const affected=new Set(memoryIds);
    for(const row of this.store.all<StateRow>(`SELECT p.* FROM agent_private_states p JOIN agent_instances a ON a.id=p.agent_id WHERE a.session_id=?`,sessionId)){
      const current=this.read(row.agent_id,sessionId),entries=current.entries.filter(e=>!(e.derivedFrom??[]).some(id=>affected.has(id)));
      if(entries.length===current.entries.length)continue;
      this.store.run('UPDATE agent_private_states SET entries_json=?,version=version+1,updated_at=? WHERE agent_id=? AND version=?',JSON.stringify(entries),this.now(),row.agent_id,current.version);
      this.store.run(`INSERT INTO agent_state_updates(agent_id,run_id,kind,from_version,to_version,observation_json,patch_json,before_json,after_json,created_at)
        VALUES(?,NULL,'MEMORY_INVALIDATED',?,?,NULL,?,?,?,?)`,row.agent_id,current.version,current.version+1,JSON.stringify({memoryIds}),JSON.stringify(current.entries),JSON.stringify(entries),this.now());
    }
  }
  /** Conservatively remove dependent entries; retained journal is private history, not current knowledge. */
  invalidateMessage(sessionId: string, messageId: string): void {
    ensure(this.store.db.inTransaction, 500, 'STATE_TRANSACTION_REQUIRED');
    const rows = this.store.all<StateRow>(`SELECT p.* FROM agent_private_states p JOIN agent_instances a ON a.id=p.agent_id
      WHERE a.session_id=?`, sessionId);
    for (const row of rows) {
      const current = this.read(row.agent_id, sessionId);
      const entries = current.entries.filter(entry => !entry.evidence.some(ref => ref.kind === 'message' && ref.id === messageId));
      if (entries.length === current.entries.length) continue;
      this.store.run('UPDATE agent_private_states SET entries_json=?,version=version+1,updated_at=? WHERE agent_id=? AND version=?',
        JSON.stringify(entries), this.now(), row.agent_id, current.version);
      this.store.run(`INSERT INTO agent_state_updates(agent_id,run_id,kind,from_version,to_version,observation_json,patch_json,before_json,after_json,created_at)
        VALUES(?,NULL,'SOURCE_INVALIDATED',?,?,NULL,?,?,?,?)`, row.agent_id, current.version, current.version + 1,
        JSON.stringify({ messageId }), JSON.stringify(current.entries), JSON.stringify(entries), this.now());
    }
  }
}
