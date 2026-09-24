import { visibleInputSQL, sourceAllowed, type SourceRow } from './source-access.js';
import { randomUUID } from 'node:crypto';
import { ensure, type AgendaContext, type AgendaSignal, type Context, type PrivateState, type PrivateStateEntry, type Settings } from '../contracts/index.js';
import type { AgentRow, MessageRow, RunRow, Store } from '../storage-sqlite/index.js';

type Condition = NonNullable<PrivateStateEntry['resume']>;
type PlanRow = { id: string; agent_id: string; entry_id: string; condition_json: string; status: string;
  checked_input: number; effective_at: number | null; matched_input: number | null;
  matched_version: number | null; notified: number; created_at: number; triggered_at: number | null };
type Notification = { id: number; kind: string; entity_id: string; version: number };
const normal = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ja');

/** Durable owner-selected opportunities to reconsider. Caller owns the synchronous DB transaction. */
export class AgentAgenda {
  constructor(private readonly store: Store, private readonly now: () => number) {}
  private active(agentId: string): PlanRow[] {
    return this.store.all<PlanRow>(`SELECT p.* FROM agent_agenda p JOIN agent_agenda_bindings b ON b.plan_id=p.id
      WHERE p.agent_id=? AND p.status IN ('PENDING','TRIGGERED') ORDER BY p.created_at,p.id`, agentId);
  }
  private minimum(settings: Settings): number { return settings.agendaMinIntervalMs ?? 30000; }
  private nextAt(agentId: string, settings: Settings): number {
    const previous = this.store.get<{last_wake_at: number}>('SELECT last_wake_at FROM agent_agenda_clock WHERE agent_id=?', agentId);
    return previous ? previous.last_wake_at + this.minimum(settings) : 0;
  }
  private transaction(): void { ensure(this.store.db.inTransaction, 500, 'AGENDA_TRANSACTION_REQUIRED'); }

  /** Condition identity, not unrelated text/state changes, determines rearming. Consumed bindings stay bound. */
  sync(agent: AgentRow, state: PrivateState, settings: Settings, fromInput: number): void {
    this.transaction();
    ensure(state.agentId === agent.id && state.sessionId === agent.session_id, 403, 'AGENDA_OWNER_MISMATCH');
    const requested = new Map(state.entries.filter(e => e.resume !== null).map(e => [e.id, e.resume!]));
    const bound = this.store.all<PlanRow>(`SELECT p.* FROM agent_agenda p JOIN agent_agenda_bindings b ON b.plan_id=p.id
      WHERE b.agent_id=?`, agent.id);
    for (const old of bound) {
      const condition = requested.get(old.entry_id);
      if (condition && JSON.stringify(condition) === old.condition_json) { requested.delete(old.entry_id); continue; }
      this.store.run("UPDATE agent_agenda SET status='CANCELLED',ended_at=?,reason='INTENTION_WITHDRAWN_OR_REPLACED' WHERE id=? AND status IN ('PENDING','TRIGGERED')", this.now(), old.id);
      this.store.run('DELETE FROM agent_agenda_bindings WHERE agent_id=? AND entry_id=?', agent.id, old.entry_id);
    }
    for (const [entryId, condition] of requested) {
      const id = randomUUID();
      const due = condition.kind === 'time' ? Math.max(condition.notBefore!, this.now() + this.minimum(settings), this.nextAt(agent.id, settings)) : null;
      this.store.run(`INSERT INTO agent_agenda(id,agent_id,entry_id,condition_json,checked_input,effective_at,created_at)
        VALUES(?,?,?,?,?,?,?)`, id, agent.id, entryId, JSON.stringify(condition), fromInput, due, this.now());
      this.store.run('INSERT INTO agent_agenda_bindings(agent_id,entry_id,plan_id) VALUES(?,?,?)', agent.id, entryId, id);
    }
  }

  private matchValid(plan: PlanRow): boolean {
    if (plan.matched_input === null) return true;
    const input = this.store.get<Notification>('SELECT id,kind,entity_id,version FROM agent_input_log WHERE id=?', plan.matched_input);
    if (!input || input.version !== plan.matched_version) return false;
    const live = input.kind === 'message'
      ? this.store.get<{version:number;deleted:number}>('SELECT revision version,deleted FROM messages WHERE id=?', input.entity_id)
      : this.store.get<SourceRow & {deleted:number}>('SELECT *,1-enabled deleted FROM source_items WHERE id=?', input.entity_id);
    return !!live && !live.deleted && live.version === plan.matched_version && (input.kind==='message'||sourceAllowed(live as SourceRow,plan.agent_id));
  }

  reusable(run: RunRow): boolean {
    const context = JSON.parse(run.context_json) as Context;
    return (context.agenda?.triggered ?? []).every(signal => {
      const plan = this.store.get<PlanRow>('SELECT * FROM agent_agenda WHERE id=? AND agent_id=?', signal.planId, run.agent_id);
      return !!plan && plan.status === 'TRIGGERED' && plan.matched_input === signal.matchedInput &&
        plan.matched_version === signal.matchedVersion && this.matchValid(plan);
    });
  }

  /** Returns true at most once per notification cohort. SessionService turns it into one wake, not a post. */
  dispatch(agent: AgentRow, settings: Settings): boolean {
    this.transaction();
    for (let plan of this.active(agent.id)) {
      if (plan.status === 'TRIGGERED' && !this.matchValid(plan)) {
        this.store.run("UPDATE agent_agenda SET status='PENDING',matched_input=NULL,matched_version=NULL,notified=0,triggered_at=NULL,reason='MATCH_INVALIDATED' WHERE id=?", plan.id);
        plan = this.store.get<PlanRow>('SELECT * FROM agent_agenda WHERE id=?', plan.id)!;
      }
      if (plan.status !== 'PENDING') continue;
      const condition = JSON.parse(plan.condition_json) as Condition;
      if (condition.kind === 'time') {
        const due = Math.max(plan.effective_at ?? 0, plan.created_at + this.minimum(settings));
        if (due !== plan.effective_at) this.store.run('UPDATE agent_agenda SET effective_at=? WHERE id=?', due, plan.id);
        if (settings.selfWakeEnabled && this.now() >= due)
          this.store.run("UPDATE agent_agenda SET status='TRIGGERED',triggered_at=?,reason='TIME_DUE' WHERE id=?", this.now(), plan.id);
        continue;
      }
      const rows = this.store.all<Notification>(`SELECT i.id,i.kind,i.entity_id,i.version FROM agent_input_log i WHERE i.session_id=? AND i.id>? AND ${visibleInputSQL()} ORDER BY i.id LIMIT 100`, agent.session_id, plan.checked_input,agent.id);
      for (const input of rows) {
        const message = input.kind === 'message' ? this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?', input.entity_id, agent.session_id) : undefined;
        const source = input.kind === 'source' ? this.store.get<SourceRow>('SELECT * FROM source_items WHERE id=? AND session_id=?', input.entity_id, agent.session_id) : undefined;
        const isOther = !!message && !message.deleted && message.author_id !== agent.id && message.revision === input.version;
        let matches = condition.kind === 'new_message' ? isOther : condition.kind === 'answer_from' ? isOther && message!.author_id === condition.agentId : false;
        if (condition.kind === 'related_topic') {
          const text = isOther ? message!.text : source?.version === input.version ? source.title + '\n' + source.text : '';
          matches = !!text && normal(text).includes(normal(condition.topic!));
        }
        this.store.run('UPDATE agent_agenda SET checked_input=? WHERE id=?', input.id, plan.id);
        if (!matches) continue;
        this.store.run("UPDATE agent_agenda SET status='TRIGGERED',matched_input=?,matched_version=?,triggered_at=?,reason='INPUT_MATCHED' WHERE id=?", input.id, input.version, this.now(), plan.id);
        break;
      }
    }
    if (this.now() < this.nextAt(agent.id, settings)) return false;
    const signals = this.active(agent.id).filter(p => p.status === 'TRIGGERED' && !p.notified &&
      (settings.selfWakeEnabled || (JSON.parse(p.condition_json) as Condition).kind !== 'time'));
    if (!signals.length) return false;
    for (const plan of signals) this.store.run('UPDATE agent_agenda SET notified=1 WHERE id=?', plan.id);
    this.store.run('INSERT INTO agent_agenda_clock(agent_id,last_wake_at) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_wake_at=excluded.last_wake_at', agent.id, this.now());
    return true;
  }

  view(agentId: string, settings: Settings, remainingMs = Infinity): AgendaContext {
    const nextAutonomousAt = this.nextAt(agentId, settings);
    const result: AgendaContext = { now: this.now(), minimumIntervalMs: this.minimum(settings),
      timeWakeEnabled: !!settings.selfWakeEnabled, nextAutonomousAt, pending: [], triggered: [] };
    for (const plan of this.active(agentId)) {
      const condition = JSON.parse(plan.condition_json) as Condition, timed = condition.kind === 'time';
      const reason: AgendaSignal['reason'] = timed && !settings.selfWakeEnabled ? 'TIME_WAKE_DISABLED'
        : timed && plan.effective_at !== null && plan.effective_at - this.now() >= remainingMs ? 'OUTSIDE_CURRENT_BUDGET'
        : plan.status === 'TRIGGERED' ? (!plan.notified && this.now() < nextAutonomousAt ? 'MINIMUM_INTERVAL' : 'TRIGGERED')
        : timed ? 'AWAITING_TIME' : 'AWAITING_INPUT';
      const signal: AgendaSignal = { planId: plan.id, entryId: plan.entry_id, kind: condition.kind,
        status: plan.status === 'TRIGGERED' ? 'TRIGGERED' : 'PENDING', requestedAt: condition.notBefore,
        effectiveAt: plan.effective_at, matchedInput: plan.matched_input, matchedVersion: plan.matched_version, reason };
      if (plan.status === 'TRIGGERED' && !(timed && !settings.selfWakeEnabled)) result.triggered.push(signal);
      else result.pending.push(signal);
    }
    return result;
  }

  /** Consume only the opportunities present in the completed participation request, not later arrivals. */
  complete(run: RunRow): void {
    this.transaction();
    if (run.kind === 'memory' || run.kind === 'observe') return;
    const context = JSON.parse(run.context_json) as Context;
    ensure(this.reusable(run), 409, 'STALE_AGENDA');
    if (!context.delivery?.complete || context.coverage?.complete === false) return;
    for (const signal of context.agenda?.triggered ?? []) {
      this.store.run("UPDATE agent_agenda SET status='CONSUMED',consumed_run=?,ended_at=?,reason='PARTICIPATION_RECONSIDERED' WHERE id=? AND agent_id=? AND status='TRIGGERED'",
        run.id, this.now(), signal.planId, run.agent_id);
    }
  }
  endSession(sessionId: string): void {
    this.transaction();
    this.store.run("UPDATE agent_agenda SET status='CANCELLED',ended_at=?,reason='SESSION_ENDED' WHERE agent_id IN (SELECT id FROM agent_instances WHERE session_id=?) AND status IN ('PENDING','TRIGGERED')", this.now(), sessionId);
  }
}
