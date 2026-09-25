import {ensure,type Context,type ModelProfile,type Settings} from '../contracts/index.js';
import type {BudgetLimits} from '../contracts/budget.js';
import {settingsOf,type SessionRow,type RunRow,type Store,type CallRow} from '../storage-sqlite/index.js';

export type TokenReservation={callId:string;estimatedInputTokens:number;reservedOutputTokens:number;estimateMethod:'utf8-upper-bound'};
type Metered=CallRow&{kind:string;agent_id:string};
const valid=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;

/** The persisted bound context already reserves schema/framing and worst-case bounded repair. */
export function tokenReservation(run:RunRow,profile:ModelProfile,callId:string):TokenReservation {
  const context=JSON.parse(run.context_json) as Context,input=context.inputBudget?.estimatedInputTokens;
  ensure(valid(input),409,'BUDGET_CONTEXT_UNMEASURED');
  return {callId,estimatedInputTokens:input,reservedOutputTokens:profile.maxOutputTokens,estimateMethod:'utf8-upper-bound'};
}

/** Match exact call IDs, not the mutable run context after a later LOOKUP. Retain unknown usage as reserved consumption. */
export function windowUsage(store:Store,session:SessionRow){
  const count=Math.max(0,session.call_count-session.window_call_start);
  const calls=store.all<Metered>('SELECT c.*,r.kind,r.agent_id FROM llm_calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=? ORDER BY c.rowid DESC LIMIT ?',session.id,count);
  const reservations=new Map<string,TokenReservation>();
  for(const row of store.all<{detail:string}>("SELECT detail FROM traces WHERE session_id=? AND code='CALL_RESERVED' ORDER BY id DESC LIMIT ?",session.id,count)){
    const value=JSON.parse(row.detail) as Partial<TokenReservation>;
    if(typeof value.callId==='string'&&valid(value.estimatedInputTokens)&&valid(value.reservedOutputTokens))reservations.set(value.callId,value as TokenReservation);
  }
  let charged=0,missingReservation=Math.max(0,count-calls.length),missingInput=0,missingOutput=0,inputKnown=0,outputKnown=0,inputTokens=0,outputTokens=0,reservedUnknown=0;
  const groups=new Map<string,{kind:string;stage:string;calls:number;reportedInputTokens:number|null;reportedOutputTokens:number|null;missingInput:number;missingOutput:number;reservedUnknownTokens:number;latencyMs:number|null;completedLatencyCalls:number}>();
  for(const call of calls){
    const reservation=reservations.get(call.id),key=call.kind+':'+call.stage;
    const group=groups.get(key)??{kind:call.kind,stage:call.stage,calls:0,reportedInputTokens:null,reportedOutputTokens:null,missingInput:0,missingOutput:0,reservedUnknownTokens:0,latencyMs:null,completedLatencyCalls:0};
    group.calls++;
    if(call.input_tokens===null){missingInput++;group.missingInput++;}
    else {inputKnown++;inputTokens+=call.input_tokens;group.reportedInputTokens=(group.reportedInputTokens??0)+call.input_tokens;}
    if(call.output_tokens===null){missingOutput++;group.missingOutput++;}
    else {outputKnown++;outputTokens+=call.output_tokens;group.reportedOutputTokens=(group.reportedOutputTokens??0)+call.output_tokens;}
    const unknown=(call.input_tokens===null?(reservation?.estimatedInputTokens??0):0)+(call.output_tokens===null?(reservation?.reservedOutputTokens??0):0);
    if(!reservation&&(call.input_tokens===null||call.output_tokens===null))missingReservation++;
    else charged+=(call.input_tokens??reservation!.estimatedInputTokens)+(call.output_tokens??reservation!.reservedOutputTokens);
    reservedUnknown+=unknown;group.reservedUnknownTokens+=unknown;
    if(call.finished_at!==null){group.latencyMs=(group.latencyMs??0)+Math.max(0,call.finished_at-call.started_at);group.completedLatencyCalls++;}
    groups.set(key,group);
  }
  return {calls:count,recordedCalls:calls.length,chargedTokens:missingReservation?null:charged,missingReservation,
    reportedInputTokens:inputKnown?inputTokens:null,reportedOutputTokens:outputKnown?outputTokens:null,
    missingInput,missingOutput,reservedUnknownTokens:reservedUnknown,groups:[...groups.values()].sort((a,b)=>(a.kind+':'+a.stage).localeCompare(b.kind+':'+b.stage))};
}

export function windowClock(store:Store,s:SessionRow,now:number){
  const renewed=store.get<{created_at:number}>("SELECT created_at FROM events WHERE session_id=? AND kind='budget.renewed' ORDER BY id DESC LIMIT 1",s.id)?.created_at;
  const openedAt=s.started_at===null?null:Math.max(s.started_at,renewed??s.started_at);
  return {openedAt,wallMs:openedAt===null?0:Math.max(0,now-openedAt),activeMs:s.active_elapsed_ms+(s.active_since===null?0:Math.max(0,now-s.active_since))};
}

/** Additional caps are checked before reservations, on accounting completion, and before publication. */
export function additionalBudgetReason(store:Store,s:SessionRow,now:number):string|null {
  const limits=settingsOf(s) as Settings&BudgetLimits;
  if(limits.maxWallDurationMs!==undefined&&windowClock(store,s,now).wallMs>=limits.maxWallDurationMs)return 'MAX_WALL_DURATION';
  if(limits.maxWindowTokens!==undefined){const usage=windowUsage(store,s);
    if(usage.chargedTokens===null)return 'BUDGET_USAGE_UNKNOWN';
    if(usage.chargedTokens>limits.maxWindowTokens)return 'MAX_TOKENS';
  }
  return null;
}
export function fitsTokenReservation(store:Store,s:SessionRow,reservation:TokenReservation):boolean {
  const limit=(settingsOf(s) as Settings&BudgetLimits).maxWindowTokens;if(limit===undefined)return true;
  const used=windowUsage(store,s).chargedTokens;
  return used!==null&&used+reservation.estimatedInputTokens+reservation.reservedOutputTokens<=limit;
}

/** Administrator report. Public transcripts remain free of internal accounting and private decisions. */
export function budgetReport(store:Store,s:SessionRow,now:number){
  const usage=windowUsage(store,s),posts=Math.max(0,s.bot_count-s.window_post_start),clock=windowClock(store,s,now);
  const lifecycle=s.lifecycle,settings=settingsOf(s) as Settings&BudgetLimits;
  const renewal=store.get<{id:number;created_at:number}>("SELECT id,created_at FROM events WHERE session_id=? AND kind='budget.renewed' ORDER BY id DESC LIMIT 1",s.id);
  const windowCalls=store.all<{run_id:string}>('SELECT c.run_id FROM llm_calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=? ORDER BY c.rowid DESC LIMIT ?',s.id,usage.calls);
  const runIds=JSON.stringify([...new Set(windowCalls.map(c=>c.run_id))]);
  const control=store.all<{code:string;count:number}>("SELECT code,COUNT(*) count FROM traces WHERE session_id=? AND run_id IN (SELECT value FROM json_each(?)) GROUP BY code ORDER BY code",s.id,runIds);
  const waits=store.get<{mean:number|null;maximum:number|null;count:number}>("SELECT AVG(json_extract(detail,'$.waitMs')) mean,MAX(json_extract(detail,'$.waitMs')) maximum,COUNT(*) count FROM traces WHERE session_id=? AND code='COMMITTED' AND id IN (SELECT id FROM traces WHERE session_id=? AND code='COMMITTED' ORDER BY id DESC LIMIT ?)",s.id,s.id,posts)!;
  return {schemaVersion:1,session:{id:s.id,lifecycle,activity:s.activity,epoch:s.epoch,stopReason:s.stop_reason},settings,window:{callStart:s.window_call_start,postStart:s.window_post_start,renewalEventId:renewal?.id??null,...clock},
    usage,publicMessages:posts,normalization:{denominator:posts,per100Calls:posts?100*usage.calls/posts:null,smallSample:posts<100,forcedSpeech:false},
    groupsPer100:usage.groups.map(group=>({...group,callsPer100:posts?100*group.calls/posts:null,meanLatencyMs:group.completedLatencyCalls?group.latencyMs!/group.completedLatencyCalls:null})),
    candidateWait:waits,control,
    policy:{automaticRenewal:false,missingUsage:'retains recorded reservation; absent legacy reservation fails closed when a token cap is configured',
      tokenEstimate:'conservative local request estimate, not a Provider tokenizer or monetary guarantee',billing:'No currency, subscription allowance, Actions minutes or artifact storage is inferred from token counts'},
    additionalStopReason:additionalBudgetReason(store,s,now)};
}
