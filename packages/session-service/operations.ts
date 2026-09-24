import { currentDisposition } from './participation.js';
import { credential } from '../config/credentials.js';
import { hash } from '../domain/index.js';
import { ModelProfileSchema, type ModelProfile, type RunKind } from '../contracts/index.js';
import type { AgentOperation, Operations, OperationReason, ProviderReport } from '../contracts/operations.js';
import { profileOf } from '../storage-sqlite/index.js';
import type { SessionService } from './index.js';

/** Metadata only. Key presence is inspected on Core; it does not attest to a remote Worker's environment. */
export function providerReport(service:SessionService,profile:ModelProfile,env:NodeJS.ProcessEnv=process.env):ProviderReport {
  let configured=profile.provider==='mock'||!profile.authRequired,error:string|null=null;
  if(!configured){try{configured=!!credential(profile,env);if(!configured)error='MISSING_MODEL_KEY';}catch{error='MODEL_CREDENTIAL_UNAVAILABLE';}}
  const health=service.providers.status(profile);
  const usage=service.store.get<{calls:number;inputKnown:number;outputKnown:number}>(
    'SELECT COUNT(*) calls,COUNT(input_tokens) inputKnown,COUNT(output_tokens) outputKnown FROM llm_calls WHERE scope=?',health.scope)!;
  return {profile,hash:hash(profile),health,liveEnabled:service.config.allowLive,credentialConfiguredOnCore:configured,credentialError:error,usageObserved:usage};
}
export function profileCatalog(service:SessionService,env:NodeJS.ProcessEnv=process.env):ProviderReport[]{
  return service.store.tx(()=>service.modelProfiles().map(p=>providerReport(service,p,env)));
}
export function profileVersions(service:SessionService,id:string,env:NodeJS.ProcessEnv=process.env):ProviderReport[]{
  return service.store.tx(()=>service.store.all<{definition:string}>('SELECT definition FROM model_profiles WHERE id=? ORDER BY version DESC',id)
    .map(row=>providerReport(service,ModelProfileSchema.parse(JSON.parse(row.definition)),env)));
}
export function operations(service:SessionService,id:string,env:NodeJS.ProcessEnv=process.env):Operations{
  return service.store.tx(()=>{
    const s=service.session(id),session=service.publicSession(s),settings=session.settings,now=service.now();
    const latest=new Map(service.modelProfiles().map(p=>[p.id,p.version]));
    const agents:AgentOperation[]=service.agents(id).map(a=>{
      const agent=service.publicAgent(a),frozen=providerReport(service,profileOf(a),env),health=frozen.health;
      const run=service.store.get<{kind:RunKind}>("SELECT kind FROM runs WHERE agent_id=? AND state='ACTIVE'",a.id);
      const candidate=service.store.get<{state:string;not_before:number}>("SELECT state,not_before FROM candidates WHERE agent_id=? AND state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')",a.id);
      const cursor=service.store.get<{observed_input:number;memory_input:number}>('SELECT observed_input,memory_input FROM agent_input_cursors WHERE agent_id=?',a.id);
      const pending=service.store.get<{observation:number;memory:number}>(
        'SELECT COALESCE(SUM(id>?),0) observation,COALESCE(SUM(id>?),0) memory FROM agent_input_log WHERE session_id=?',cursor?.observed_input??0,cursor?.memory_input??0,id)!;
      const deferral=a.deferral_json?JSON.parse(a.deferral_json) as {kind:string;agentId:string|null;until:number}:null;
      let reason:OperationReason='QUIET',next:number|null=null;
      if(s.lifecycle==='ENDED')reason='SESSION_ENDED';
      else if(!a.enabled)reason='AGENT_DISABLED';
      else if(s.activity==='BUDGET_PAUSED'||session.budget.callsUsed>=settings.maxCalls||session.budget.messagesUsed>=settings.maxMessages||session.budget.activeMs>=settings.maxDurationMs)reason='BUDGET_STOPPED';
      else if(s.lifecycle==='PAUSED')reason='SESSION_PAUSED';
      else if(s.lifecycle==='DRAFT')reason='NOT_STARTED';
      else if(frozen.profile.provider!=='mock'&&!service.config.allowLive)reason='LIVE_DISABLED';
      else if(!agent.workerOnline)reason='WORKER_OFFLINE';
      else if(health.state==='BLOCKED')reason=health.lastError==='AUTH_ERROR'?'AUTH_ERROR':'CONFIG_ERROR';
      else if(health.state==='OPEN'){reason=health.lastError==='RATE_LIMIT'?'RATE_LIMIT':'PROVIDER_OPEN';next=Math.max(health.retryAt??0,a.retry_at??0);}
      else if(health.state==='HALF_OPEN'){reason='PROVIDER_PROBE';next=health.probeUntil;}
      else if(a.error_count>settings.maxRetries&&health.state!=='PROBE_DUE')reason='RETRY_EXHAUSTED';
      else if(a.retry_at!==null&&a.retry_at>now){reason='RETRY_WAIT';next=a.retry_at;}
      else if(run)reason=({decide:'THINKING',draft:'GENERATING',review:'REVIEWING',memory:'REMEMBERING',observe:'OBSERVING'} as const)[run.kind];
      else if(deferral){reason=deferral.kind==='answer_from'?'WAITING_REPLY':'DEFERRED';next=deferral.until;}
      else if(candidate){reason='WAITING_CANDIDATE';next=Math.max(now,candidate.not_before);}
      else if(a.last_post_at+settings.agentCooldownMs>now){reason='COOLDOWN';next=a.last_post_at+settings.agentCooldownMs;}
      else if(a.wake_seq>a.processed_wake||pending.observation>0){reason='WAITING_INPUT';next=Math.max(now,a.due_at??now);}
      else if(settings.selfWakeEnabled){
        const planned=service.store.get<{due:number|null}>("SELECT MIN(effective_at) due FROM agent_agenda WHERE agent_id=? AND status IN ('PENDING','TRIGGERED')",a.id)?.due;
        next=planned===null||planned===undefined?a.next_self_at:Math.min(a.next_self_at,planned);
      }
      if (['QUIET','DEFERRED'].includes(reason) && currentDisposition(service.store,a) === 'CONTENT_LOOP') reason='CONTENT_LOOP';
      return {agent,frozen,latestVersion:latest.get(frozen.profile.id)??frozen.profile.version,reason,
        lastError:a.last_error,errorCount:a.error_count,nextOpportunityAt:next,waitingFor:deferral?.agentId??null,
        activeRun:run?.kind??null,candidateState:candidate?.state??null,observationPending:pending.observation,memoryPending:pending.memory};
    });
    return {schemaVersion:1,now,session,agents};
  });
}
