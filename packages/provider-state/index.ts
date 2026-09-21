import { createHash } from 'node:crypto';
import { ensure, type ModelProfile, type ModelErrorCode } from '../contracts/index.js';
import { Store } from '../storage-sqlite/index.js';

type Health = {scope:string;failures:number;open_until:number;blocked:number;last_error:string|null;probe_call:string|null;probe_until:number;updated_at:number};
export function providerScope(profile: ModelProfile): string {
  if(profile.provider==='mock') return 'mock';
  if(profile.limitGroup) return 'group:'+profile.limitGroup;
  return 'provider:'+createHash('sha256').update(JSON.stringify([profile.provider,profile.baseUrl!.replace(/\/+$/,''),profile.apiKeyEnv??'anonymous'])).digest('hex');
}
export class ProviderState {
  constructor(readonly store:Store,readonly now:()=>number) {}
  private row(profile:ModelProfile): Health {
    const scope=providerScope(profile);
    this.store.run('INSERT OR IGNORE INTO provider_health(scope,updated_at) VALUES(?,?)',scope,this.now());
    return this.store.get<Health>('SELECT * FROM provider_health WHERE scope=?',scope)!;
  }
  status(profile:ModelProfile) {
    const h=this.row(profile);
    return {scope:h.scope,state:h.blocked?'BLOCKED':h.probe_call&&h.probe_until>this.now()?'HALF_OPEN':h.open_until>this.now()?'OPEN':h.open_until>0?'PROBE_DUE':'CLOSED',
      failures:h.failures,lastError:h.last_error,retryAt:h.blocked?null:h.open_until||null,probeUntil:h.probe_until||null};
  }
  mayClaim(profile:ModelProfile,agentFailures:number,maxRetries:number):boolean {
    const h=this.row(profile);
    if(h.blocked||h.open_until>this.now()||(h.probe_call&&h.probe_until>this.now())) return false;
    return agentFailures<=maxRetries||h.open_until>0;
  }
  reserve(profile:ModelProfile,callId:string,deadline:number,cap:number):void {
    const h=this.row(profile);
    ensure(!h.blocked,409,'PROVIDER_BLOCKED');
    ensure(h.open_until<=this.now()&&(!h.probe_call||h.probe_until<=this.now()),429,'PROVIDER_COOLDOWN');
    const active=this.store.get<{n:number}>("SELECT COUNT(*) n FROM llm_calls WHERE scope=? AND status IN ('RESERVED','ABANDONED') AND expires_at>?",h.scope,this.now())!.n;
    ensure(active<cap,429,'PROVIDER_BUSY');
    if(h.open_until>0) this.store.run('UPDATE provider_health SET probe_call=?,probe_until=?,updated_at=? WHERE scope=?',callId,deadline,this.now(),h.scope);
  }
  finish(profile:ModelProfile,callId:string,error:ModelErrorCode|null,retryAfterMs=0):void {
    if(profile.provider==='mock') return;
    const h=this.row(profile);
    if(!error) {
      if(h.probe_call===callId||(!h.open_until&&!h.blocked)) this.store.run('UPDATE provider_health SET failures=0,open_until=0,blocked=0,last_error=NULL,probe_call=NULL,probe_until=0,updated_at=? WHERE scope=?',this.now(),h.scope);
      return;
    }
    if(!['API_ERROR','AUTH_ERROR','RATE_LIMIT','TIMEOUT','CONFIG_ERROR','DELIVERY_UNKNOWN'].includes(error)) return;
    const failures=h.failures+1,permanent=error==='AUTH_ERROR'||error==='CONFIG_ERROR';
    const trip=permanent||error==='RATE_LIMIT'||failures>=profile.failureThreshold||h.open_until>0;
    const wait=Math.max(profile.circuitCooldownMs,Math.min(86400000,Math.max(0,retryAfterMs)));
    this.store.run('UPDATE provider_health SET failures=?,open_until=?,blocked=?,last_error=?,probe_call=NULL,probe_until=0,updated_at=? WHERE scope=?',
      failures,trip?Math.max(h.open_until,this.now()+wait):0,permanent?1:h.blocked,error,this.now(),h.scope);
  }
  /** Operator-authorized recovery allows one probe, not an unlimited burst. */
  requestProbe(profile:ModelProfile):void {
    const h=this.row(profile);ensure(!h.probe_call||h.probe_until<=this.now(),409,'PROBE_INFLIGHT');
    this.store.run('UPDATE provider_health SET blocked=0,open_until=?,probe_call=NULL,probe_until=0,updated_at=? WHERE scope=?',this.now(),this.now(),h.scope);
  }
}
