import { MeaningMemoryRetriever, recallRequest, type MemoryRetriever } from './recall.js';
import { AppError, ensure, InputWindowSchema, type Context, type InputProgress, type InputWindow, type RunKind, type Settings } from '../contracts/index.js';
import { profileOf, type Store, type AgentRow, type MessageRow, type RunRow } from '../storage-sqlite/index.js';
import { boundedContext, contextFits } from '../models/context-budget.js';
import { memoriesCurrent } from './memory-ledger.js';

type CursorRow = { agent_id: string; observed_input: number; memory_input: number; memory_target: number; foreground_runs: number };
type InputRow = { id: number; session_id: string; kind: 'message' | 'source'; entity_id: string; version: number; created_at: number };
type SourceRow = { id: string; session_id: string; title: string; text: string; url: string | null; published_at: string | null; fetched_at: number };

/** Only called inside SessionService transactions. Input notification order is independent of model output. */
export class AgentInputs {
  constructor(private readonly store: Store, private readonly now: () => number,
    private readonly project: (row: MessageRow) => Context['messages'][number],
    private readonly retriever: MemoryRetriever = new MeaningMemoryRetriever(store),
    private readonly measure:()=>number=()=>performance.now()) {}

  private cursor(agentId: string): CursorRow {
    this.store.run('INSERT OR IGNORE INTO agent_input_cursors(agent_id) VALUES(?)', agentId);
    return this.store.get<CursorRow>('SELECT * FROM agent_input_cursors WHERE agent_id=?', agentId)!;
  }
  high(sessionId: string): number {
    return this.store.get<{ n: number }>('SELECT COALESCE(MAX(id),0) n FROM agent_input_log WHERE session_id=?', sessionId)!.n;
  }
  private backlog(sessionId: string, cursor: number) {
    return this.store.get<{ n: number; oldest: number | null }>('SELECT COUNT(*) n,MIN(created_at) oldest FROM agent_input_log WHERE session_id=? AND id>?', sessionId, cursor)!;
  }
  progress(agentId: string, sessionId: string): InputProgress {
    const c = this.cursor(agentId), observation = this.backlog(sessionId, c.observed_input), memory = this.backlog(sessionId, c.memory_input);
    return { observedInput: c.observed_input, memoryInput: c.memory_input, highWater: this.high(sessionId),
      observationPending: observation.n, memoryPending: memory.n, oldestObservationAt: observation.oldest, oldestMemoryAt: memory.oldest };
  }
  memoryDue(agent: AgentRow, settings: Settings): boolean {
    const c = this.cursor(agent.id), backlog = this.backlog(agent.session_id, c.memory_input);
    return c.memory_target > c.memory_input || backlog.n >= settings.memoryEvery ||
      (backlog.n > 0 && backlog.oldest !== null && this.now() - backlog.oldest >= (settings.memoryFlushMs ?? 60000));
  }
  memoryTurn(agent: AgentRow, settings: Settings): boolean {
    return this.memoryDue(agent, settings) && this.cursor(agent.id).foreground_runs >= (settings.memoryShareEvery ?? 3);
  }

  /** Build the oldest exact prefix first. Budget the actual request structure BEFORE binding its observation hash. */
  context(agent: AgentRow, input: Context, kind: RunKind, settings: Settings): Context {
    const c = this.cursor(agent.id), memory = kind === 'memory', from = memory ? c.memory_input : c.observed_input;
    const profile=profileOf(agent);
    let target = this.high(agent.session_id);
    if (memory) {
      if (c.memory_target <= c.memory_input) this.store.run('UPDATE agent_input_cursors SET memory_target=? WHERE agent_id=?', target, agent.id);
      else target = c.memory_target;
    }
    const rows = this.store.all<InputRow>('SELECT * FROM agent_input_log WHERE session_id=? AND id>? AND id<=? ORDER BY id LIMIT ?',
      agent.session_id, from, target, settings.contextMessages);
    const { observation: _oldManifest, inputBudget:_oldBudget, ...base } = structuredClone(input);
    const originalMessages = base.messages, originalMemories = base.memories, originalSources = base.sources;
    base.messages = []; base.memories = []; base.sources = [];
    if (kind === 'observe' || memory) { base.delta = []; base.candidate = null; base.questions = []; }
    const coverageComplete=base.coverage?.complete;
    const context: Context = { ...base, historyTruncated:true, progress: this.progress(agent.id, agent.session_id),
      selection: { omittedRecent: originalMessages.length, omittedMemories: originalMemories.length,
        omittedSources: originalSources.length, reason: 'bounded-before-observation-binding' },
      delivery: { purpose: memory ? 'memory' : 'observation', fromInput: from, throughInput: from,
        targetInput: target, complete: from >= target, entries: [] } };
    const coverage=()=>{if(context.coverage)context.coverage.complete=!!coverageComplete&&context.delivery!.complete;};
    coverage();
    const fits = () => contextFits(context,kind,profile,settings);
    ensure(fits(), 422, 'CONTEXT_LIMIT');
    for (const row of rows) {
      const message = row.kind === 'message' ? this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?', row.entity_id, agent.session_id) : undefined;
      const source = row.kind === 'source' ? this.store.get<SourceRow>('SELECT * FROM source_items WHERE id=? AND session_id=?', row.entity_id, agent.session_id) : undefined;
      ensure(message || source, 409, 'INPUT_SOURCE_MISSING');
      const previousMessages = context.messages.length, previousSources = context.sources.length,previousThrough=context.delivery!.throughInput;
      if (message && !context.messages.some(m => m.id === message.id)) context.messages.push(this.project(message));
      if (source && !context.sources.some(s => s.id === source.id)) context.sources.push({ id: source.id, title: source.title,
        text: source.text.slice(0, 1600), url: source.url, publishedAt: source.published_at, fetchedAt: source.fetched_at });
      const version = message?.revision ?? source!.fetched_at;
      context.delivery!.entries.push({ inputId: row.id, kind: row.kind, id: row.entity_id,
        eventVersion: row.version, version, superseded: version !== row.version, excerpt: !!source && source.text.length > 1600 });
      context.delivery!.throughInput=row.id;context.delivery!.complete=row.id>=target;coverage();
      if (!fits()) {
        context.delivery!.entries.pop(); context.messages.length = previousMessages; context.sources.length = previousSources;
        context.delivery!.throughInput=previousThrough;context.delivery!.complete=previousThrough>=target;coverage();
        ensure(context.delivery!.entries.length > 0, 422, 'CONTEXT_LIMIT'); break;
      }
    }
    const mandatoryMessages = context.messages.length;
    if (!memory && kind !== 'observe') {
      for (const m of originalMessages) {
        if (context.messages.some(v => v.id === m.id)) { context.selection!.omittedRecent--; continue; }
        context.messages.push(m);
        if (!fits()) context.messages.pop(); else context.selection!.omittedRecent--;
      }
    }
    // Memory reconciliation sees prior owner interpretations, but never adds newer messages to its acknowledged prefix.
    if(kind!=='observe'){
      context.messages.sort((a,b)=>a.sequence-b.sequence);
      const started=this.measure(),recalled=this.retriever.search(recallRequest(context,agent.session_id,agent.id,this.now(),memory));
      context.recall={algorithm:'owner-meaning-v2',selected:[],omittedForBudget:[],candidates:recalled.length,additionalCalls:0,elapsedMs:999999999};
      context.selection!.omittedMemories=recalled.length;
      for(const candidate of recalled){
        const evidence={request:{kind:'memories' as const,query:'automatic related memory',cursor:null},
          messages:candidate.originals.map(this.project),memories:[candidate.note],nextCursor:null};
        context.memories.push(candidate.note);context.retrieved??=[];context.retrieved.push(evidence);
        context.recall.selected.push({id:candidate.note.id,score:candidate.score,provenance:candidate.provenance});
        if(!fits()){
          context.memories.pop();context.retrieved.pop();context.recall.selected.pop();context.recall.omittedForBudget.push(candidate.note.id);
        }else context.selection!.omittedMemories--;
      }
      context.recall.elapsedMs=Math.min(999999999,Math.max(0,Math.ceil(this.measure()-started)));
      if(!memory)for(const source of originalSources){
        if(context.sources.some(s=>s.id===source.id)){context.selection!.omittedSources--;continue;}
        context.sources.push(source);if(!fits())context.sources.pop();else context.selection!.omittedSources--;
      }
    }
    context.messages.sort((a, b) => a.sequence - b.sequence);
    context.historyTruncated = context.selection!.omittedRecent > 0 || input.historyTruncated || !context.delivery!.complete;
    ensure(context.messages.length >= mandatoryMessages, 500, 'INPUT_SELECTION_LOST');
    return boundedContext(context,kind,profile,settings);
  }

  validate(run: RunRow): InputWindow {
    const context = JSON.parse(run.context_json) as Context;
    const window = InputWindowSchema.parse(context.delivery), c = this.cursor(run.agent_id);
    ensure(window.purpose === (run.kind === 'memory' ? 'memory' : 'observation'), 409, 'INPUT_PURPOSE_MISMATCH');
    ensure(window.fromInput === (run.kind === 'memory' ? c.memory_input : c.observed_input), 409, 'STALE_INPUT_CURSOR');
    const expected = this.store.all<InputRow>('SELECT * FROM agent_input_log WHERE session_id=? AND id>? AND id<=? ORDER BY id',
      run.session_id, window.fromInput, window.throughInput);
    ensure(expected.length === window.entries.length && expected.every((r, i) => r.id === window.entries[i].inputId &&
      r.kind === window.entries[i].kind && r.entity_id === window.entries[i].id && r.version === window.entries[i].eventVersion), 409, 'INPUT_COVERAGE_MISMATCH');
    ensure(window.throughInput >= window.fromInput && window.throughInput <= window.targetInput && window.targetInput <= this.high(run.session_id) &&
      window.complete === (window.throughInput >= window.targetInput), 409, 'INPUT_COVERAGE_MISMATCH');
    for (const entry of window.entries) {
      const current = entry.kind === 'message'
        ? this.store.get<{ version: number }>('SELECT revision version FROM messages WHERE id=? AND session_id=?', entry.id, run.session_id)
        : this.store.get<{ version: number }>('SELECT fetched_at version FROM source_items WHERE id=? AND session_id=?', entry.id, run.session_id);
      ensure(current?.version === entry.version, 409, 'STALE_INPUT_EVIDENCE');
    }
    return window;
  }
  reusable(run: RunRow): boolean {
    const captured = (JSON.parse(run.context_json) as Context).self.privateState;
    const current = this.store.get<{version:number}>('SELECT version FROM agent_private_states WHERE agent_id=?', run.agent_id);
    if (!captured || captured.version !== (current?.version ?? 0)||!memoriesCurrent(this.store,run)) return false;
    try { this.validate(run); return true; }
    catch (error) {
      if (error instanceof AppError && ['STALE_INPUT_CURSOR','STALE_INPUT_EVIDENCE'].includes(error.code)) return false;
      throw error;
    }
  }
  complete(run: RunRow): void {
    const window = this.validate(run), memory = run.kind === 'memory';
    const column = memory ? 'memory_input' : 'observed_input';
    this.store.run(`UPDATE agent_input_cursors SET ${column}=?,foreground_runs=${memory ? '0' : 'foreground_runs+1'} WHERE agent_id=?`, window.throughInput, run.agent_id);
    if (memory && window.complete) this.store.run('UPDATE agent_input_cursors SET memory_target=? WHERE agent_id=?', this.high(run.session_id), run.agent_id);
    this.store.run('INSERT INTO agent_input_receipts(run_id,agent_id,purpose,from_input,through_input,target_input,window_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      run.id, run.agent_id, window.purpose, window.fromInput, window.throughInput, window.targetInput, JSON.stringify(window), this.now());
  }
  validateMemory(run: RunRow, sourceIds: string[]): { kind: 'message'; id: string; version: number }[] {
    const context = JSON.parse(run.context_json) as Context;
    return sourceIds.map(id => {
      const supplied = context.messages.find(m => m.id === id);
      const current = this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?', id, run.session_id);
      ensure(supplied && current && !current.deleted && current.revision === supplied.revision, 422, 'INVALID_MEMORY_SOURCE');
      return { kind: 'message', id, version: current.revision };
    });
  }
  bindCandidate(candidateId: string, stateVersion: number): void {
    this.store.run('INSERT INTO candidate_state_bindings(candidate_id,state_version) VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET state_version=excluded.state_version', candidateId, stateVersion);
  }
  candidateCurrent(candidateId: string, agentId: string): boolean {
    const binding = this.store.get<{ state_version: number }>('SELECT state_version FROM candidate_state_bindings WHERE candidate_id=?', candidateId);
    const current = this.store.get<{ version: number }>('SELECT version FROM agent_private_states WHERE agent_id=?', agentId);
    return !!binding && binding.state_version === (current?.version ?? 0);
  }
}
