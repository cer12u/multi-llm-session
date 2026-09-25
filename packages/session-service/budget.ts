import {randomUUID} from 'node:crypto';
import {ensure,type OperationalBudget,type Context,type Usage} from '../contracts/index.js';
import {settingsOf,profileOf,type Store,type SessionRow,type RunRow,type AgentRow} from '../storage-sqlite/index.js';
import {providerScope} from '../provider-state/index.js';

export type BudgetWindow={id:string;session_id:string;started_at:number;ends_at:number|null;ended_at:number|null;reason:string;policy_json:string|null;call_start:number;post_start:number;call_boundary:number};
type ScopePolicy=Pick<OperationalBudget,'windowMs'|'scopeMaxCalls'|'scopeMaxTokens'>;
// Legacy records have no reservation. Conservatively account their captured envelope rather than treating missing usage as zero.
const estimatedInput="COALESCE(b.estimated_input,json_extract(r.context_json,'$.inputBudget.estimatedInputTokens'),json_extract(s.settings_json,'$.contextTokens'),65536)";
const estimatedOutput="COALESCE(b.reserved_output,json_extract(a.profile_json,'$.maxOutputTokens'),768)";
const charge=`COALESCE(b.charged_tokens,CASE WHEN c.status='FINISHED' AND c.input_tokens IS NOT NULL AND c.output_tokens IS NOT NULL THEN c.input_tokens+c.output_tokens ELSE MAX(COALESCE(c.input_tokens,0)+COALESCE(c.output_tokens,0),${estimatedInput}+${estimatedOutput}) END)`;
const joined='llm_calls c JOIN runs r ON r.id=c.run_id JOIN sessions s ON s.id=r.session_id JOIN agent_instances a ON a.id=r.agent_id LEFT JOIN call_budgets b ON b.call_id=c.id';

/** Reservation, settlement and period records participate in the caller's ordinary SQLite transaction. */
export class SessionBudget {
  constructor(private readonly store:Store,private readonly now:()=>number){}
  policy(s:SessionRow):OperationalBudget|undefined{return settingsOf(s).operationalBudget;}
  current(s:SessionRow):BudgetWindow|undefined{return this.store.get<BudgetWindow>('SELECT * FROM budget_windows WHERE session_id=? AND ended_at IS NULL',s.id);}
  open(s:SessionRow,reason='FIRST_USE',reset=false):BudgetWindow{
    ensure(this.store.db.inTransaction,500,'BUDGET_TRANSACTION_REQUIRED');
    const old=this.current(s);if(old&&!reset)return old;
    if(old)this.store.run('UPDATE budget_windows SET ended_at=? WHERE id=?',this.now(),old.id);
    const p=this.policy(s),id=randomUUID(),start=this.now();
    // Existing manual renewal's count boundary is preserved on first upgrade/use.
    const boundary=reset?this.store.get<{n:number}>('SELECT COALESCE(MAX(rowid),0) n FROM llm_calls')!.n:
      s.window_call_start?this.store.get<{n:number}>('SELECT c.rowid n FROM llm_calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=? ORDER BY c.rowid LIMIT 1 OFFSET ?',s.id,s.window_call_start-1)?.n??0:0;
    this.store.run('INSERT INTO budget_windows(id,session_id,started_at,ends_at,reason,policy_json,call_start,post_start,call_boundary) VALUES(?,?,?,?,?,?,?,?,?)',
      id,s.id,start,p?start+p.windowMs:null,reason,p?JSON.stringify(p):null,reset?s.call_count:s.window_call_start,reset?s.bot_count:s.window_post_start,boundary);
    return this.current(s)!;
  }
  /** Updating limits never grants a fresh period or resets consumption. */
  changed(s:SessionRow):void{
    const w=this.current(s),p=this.policy(s);if(!w)return;
    this.store.run('UPDATE budget_windows SET policy_json=?,ends_at=? WHERE id=?',p?JSON.stringify(p):null,p?w.started_at+p.windowMs:null,w.id);
  }
  private total(where:string,args:unknown[]):{calls:number;tokens:number}{
    return this.store.get<{calls:number;tokens:number}>(`SELECT COUNT(*) calls,COALESCE(SUM(${charge}),0) tokens FROM ${joined} WHERE ${where}`,...args)!;
  }
  /** Every non-ended session sharing a credential scope observes the same configured scope limits. */
  private scopePolicy(scope:string):ScopePolicy|undefined{
    let result:ScopePolicy|undefined;
    for(const row of this.store.all<AgentRow&{settings_json:string}>("SELECT a.*,s.settings_json FROM agent_instances a JOIN sessions s ON s.id=a.session_id WHERE a.retired_at IS NULL AND a.enabled=1 AND s.lifecycle!='ENDED'")){
      if(providerScope(profileOf(row))!==scope)continue;
      const p=(JSON.parse(row.settings_json) as {operationalBudget?:OperationalBudget}).operationalBudget;
      if(!p||(p.scopeMaxCalls===null&&p.scopeMaxTokens===null))continue;
      const next={windowMs:p.windowMs,scopeMaxCalls:p.scopeMaxCalls,scopeMaxTokens:p.scopeMaxTokens};
      ensure(!result||JSON.stringify(result)===JSON.stringify(next),409,'BUDGET_SCOPE_POLICY_CONFLICT');result=next;
    }
    return result;
  }
  validate(s:SessionRow):void{
    for(const a of this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE session_id=? AND retired_at IS NULL AND enabled=1',s.id))this.scopePolicy(providerScope(profileOf(a)));
  }
  private windowUsage(s:SessionRow){const w=this.current(s);return w?this.total('r.session_id=? AND c.rowid>?',[s.id,w.call_boundary]):{calls:0,tokens:0};}
  private scopeUsage(scope:string,p:ScopePolicy){return this.total('c.scope=? AND c.started_at>=?',[scope,Math.floor(this.now()/p.windowMs)*p.windowMs]);}
  elapsedReason(s:SessionRow):string|null{
    const w=this.current(s);return w?.ends_at!==null&&w?.ends_at!==undefined&&this.now()>=w.ends_at?'BUDGET_WINDOW_EXPIRED':null;
  }
  exceeded(s:SessionRow):string|null{
    const p=this.policy(s);if(p?.maxTokens!==null&&p?.maxTokens!==undefined&&this.windowUsage(s).tokens>p.maxTokens)return 'MAX_TOKENS';
    for(const a of this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE session_id=? AND retired_at IS NULL AND enabled=1',s.id)){
      const scope=providerScope(profileOf(a)),policy=this.scopePolicy(scope);if(!policy)continue;
      const used=this.scopeUsage(scope,policy);
      if(policy.scopeMaxTokens!==null&&used.tokens>policy.scopeMaxTokens)return 'SCOPE_MAX_TOKENS';
    }
    return null;
  }
  reservation(s:SessionRow,r:RunRow,scope:string):{input:number;output:number;window:BudgetWindow;blocked:string|null}{
    const window=this.open(s),p=this.policy(s),context=JSON.parse(r.context_json) as Context;
    const owner=this.store.get<AgentRow>('SELECT * FROM agent_instances WHERE id=?',r.agent_id)!;
    const input=context.inputBudget?.estimatedInputTokens??settingsOf(s).contextTokens??65536,output=profileOf(owner).maxOutputTokens;
    ensure(Number.isSafeInteger(input)&&input>=0,500,'INVALID_TOKEN_ESTIMATE');
    let blocked=this.elapsedReason(s);
    if(!blocked&&p?.maxTokens!==null&&p?.maxTokens!==undefined&&this.windowUsage(s).tokens+input+output>p.maxTokens)blocked='MAX_TOKENS';
    const policy=this.scopePolicy(scope);
    if(!blocked&&policy){const used=this.scopeUsage(scope,policy);
      if(policy.scopeMaxCalls!==null&&used.calls+1>policy.scopeMaxCalls)blocked='SCOPE_MAX_CALLS';
      else if(policy.scopeMaxTokens!==null&&used.tokens+input+output>policy.scopeMaxTokens)blocked='SCOPE_MAX_TOKENS';
    }
    return {input,output,window,blocked};
  }
  record(callId:string,s:SessionRow,scope:string,reservation:ReturnType<SessionBudget['reservation']>):void{
    this.store.run("INSERT INTO call_budgets(call_id,session_id,window_id,scope,started_at,estimated_input,reserved_output,charged_tokens,usage_kind) VALUES(?,?,?,?,?,?,?,?,'reserved')",
      callId,s.id,reservation.window.id,scope,this.now(),reservation.input,reservation.output,reservation.input+reservation.output);
  }
  settle(callId:string,usage:Usage,unknownDelivery:boolean):void{
    const b=this.store.get<{estimated_input:number;reserved_output:number}>('SELECT * FROM call_budgets WHERE call_id=?',callId);if(!b)return;
    const known=!unknownDelivery&&usage.inputTokens!==null&&usage.outputTokens!==null;
    const reported=(usage.inputTokens??0)+(usage.outputTokens??0);
    this.store.run('UPDATE call_budgets SET charged_tokens=?,usage_kind=? WHERE call_id=?',known?reported:Math.max(reported,b.estimated_input+b.reserved_output),known?'reported':'estimated',callId);
  }
  canAutoRenew(s:SessionRow):boolean{
    const p=this.policy(s),w=this.current(s);
    return !!(p?.mode==='continuous'&&p.autoRenew&&w?.ends_at!==null&&w?.ends_at!==undefined&&this.now()>=w.ends_at&&
      (s.lifecycle==='RUNNING'||s.lifecycle==='PAUSED'&&s.activity==='BUDGET_PAUSED'&&s.stop_reason!=='USER_PAUSED'));
  }
  report(s:SessionRow){
    const w=this.current(s),now=this.now(),activeMs=s.active_elapsed_ms+(s.active_since===null?0:Math.max(0,now-s.active_since));
    const calls=this.store.all<{kind:string;stage:string;calls:number;reportedInput:number|null;reportedOutput:number|null;missingInput:number;missingOutput:number;estimatedInput:number;reservedOutput:number;chargedTokens:number;inflight:number;errors:number;durationMs:number;queueMs:number;finished:number}>(
      `SELECT r.kind,c.stage,COUNT(*) calls,SUM(c.input_tokens) reportedInput,SUM(c.output_tokens) reportedOutput,
      SUM(c.input_tokens IS NULL) missingInput,SUM(c.output_tokens IS NULL) missingOutput,SUM(${estimatedInput}) estimatedInput,SUM(${estimatedOutput}) reservedOutput,
      SUM(${charge}) chargedTokens,SUM(c.status IN ('RESERVED','ABANDONED') AND c.expires_at>?) inflight,SUM(c.error_code IS NOT NULL) errors,
      COALESCE(SUM(CASE WHEN c.finished_at IS NOT NULL THEN MAX(0,c.finished_at-c.started_at) ELSE 0 END),0) durationMs,
      COALESCE(SUM(MAX(0,c.started_at-r.created_at)),0) queueMs,COUNT(c.finished_at) finished FROM ${joined} WHERE r.session_id=? GROUP BY r.kind,c.stage ORDER BY r.kind,c.stage`,now,s.id);
    const scopes=[...new Set(this.store.all<AgentRow>('SELECT * FROM agent_instances WHERE session_id=? AND retired_at IS NULL',s.id).map(a=>providerScope(profileOf(a))))].map(scope=>{
      const policy=this.scopePolicy(scope);return {scope,policy:policy??null,periodStart:policy?Math.floor(now/policy.windowMs)*policy.windowMs:null,...policy?this.scopeUsage(scope,policy):{calls:null,tokens:null}};
    });
    const candidateTotals=this.store.get<{committed:number;discarded:number}>('SELECT COALESCE(SUM(state=\'COMMITTED\'),0) committed,COALESCE(SUM(state=\'DROPPED\'),0) discarded FROM candidates WHERE session_id=?',s.id)!;
    const recalls=this.store.get<{runs:number;elapsedMs:number;lookups:number}>("SELECT COUNT(*) runs,COALESCE(SUM(json_extract(context_json,'$.recall.elapsedMs')),0) elapsedMs,COALESCE(SUM(retrieval_count),0) lookups FROM runs WHERE session_id=?",s.id)!;
    return {sessionId:s.id,epoch:s.epoch,policy:this.policy(s)??null,window:w?{id:w.id,startedAt:w.started_at,endsAt:w.ends_at,...this.windowUsage(s)}:null,
      lifecycle:s.lifecycle,stopReason:s.stop_reason,autoResumeEligible:s.lifecycle==='PAUSED'&&s.activity==='BUDGET_PAUSED'&&s.stop_reason!=='USER_PAUSED'&&!!this.policy(s)?.autoRenew,
      activeMs,wallMs:s.started_at===null?0:Math.max(0,now-s.started_at),windowWallMs:w?Math.max(0,now-w.started_at):0,
      calls,scopes,recall:recalls,candidates:candidateTotals,publicPosts:s.bot_count,
      callsPer100Posts:s.bot_count?100*calls.reduce((n,c)=>n+c.calls,0)/s.bot_count:null,
      denominator:s.bot_count,normalized:s.bot_count>=100,billableCost:null,
      tokenAccounting:'Reported input/output, request estimates, and conservative reservation charges are separate. Unknown delivery/usage retains the reserved envelope. Provider-added tokens or inaccurate reporting can exceed the estimate; configure Provider-side spending limits for a billing guarantee.'};
  }
}
