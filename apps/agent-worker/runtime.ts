import { longRequestFetch } from '../../packages/models/long-request.js';
import { LookupSchema, type Context, type ClaimedRun, type ModelErrorCode, type Usage } from '../../packages/contracts/index.js';
import { credential } from '../../packages/config/credentials.js';
import { HttpModel, MockModel, ModelError, parseModelOutput, parseOutput, type Model } from '../../packages/models/index.js';

export class CoreError extends Error {
  constructor(readonly status:number,readonly code:string) { super(code); }
}
export class CoreClient {
  constructor(readonly base:string,readonly token:string,readonly fetcher:typeof fetch=fetch) {}
  async request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
    let response:Response;
    try { response=await this.fetcher(new URL(path,this.base),{method:body===undefined?'GET':'POST',
      headers:{authorization:'Bearer '+this.token,...body===undefined?{}:{'content-type':'application/json'}},
      body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),redirect:'error'}); }
    catch { throw new CoreError(0,'CORE_UNREACHABLE'); }
    let value:unknown; try { value=await response.json(); } catch { throw new CoreError(response.status,'INVALID_CORE_RESPONSE'); }
    if(!response.ok) throw new CoreError(response.status,(value as {code?:string}).code??'CORE_ERROR');
    return value as T;
  }
}
export async function delay(ms:number,signal?:AbortSignal):Promise<void> {
  if(signal?.aborted) return;
  await new Promise<void>(resolve=>{ const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}; const timer=setTimeout(done,ms); signal?.addEventListener('abort',done,{once:true}); });
}
export class WorkerRuntime {
  private epoch=0;
  private controller:AbortController|null=null;
  constructor(readonly client:CoreClient,readonly env:NodeJS.ProcessEnv=process.env,readonly factory?:(run:ClaimedRun)=>Model) {}
  async register():Promise<void> { this.epoch=(await this.client.request<{epoch:number}>('/v1/worker/register',{})).epoch; }
  stop():void { this.controller?.abort(); }
  async once(signal?:AbortSignal):Promise<boolean> {
    const run=await this.client.request<ClaimedRun|null>('/v1/worker/claim',{epoch:this.epoch},signal);
    if(!run) return false;
    const controller=new AbortController(); this.controller=controller;
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const base=`/v1/worker/runs/${run.id}`,auth={epoch:this.epoch,token:run.token};
    let heartbeatBusy=false;
    const heartbeat=setInterval(()=>{ if(heartbeatBusy) return; heartbeatBusy=true;
      void this.client.request(base+'/heartbeat',auth).catch(()=>controller.abort()).finally(()=>{heartbeatBusy=false;});
    },Math.min(5000,Math.floor(run.leaseMs/3)));
    let callId:string|null=null;
    try {
      if(run.profile.provider!=='mock'&&this.env.ALLOW_LIVE_MODELS!=='1') throw new ModelError('CONFIG_ERROR');
      const model=this.factory?.(run)??(run.profile.provider==='mock'?new MockModel():new HttpModel(run.profile,credential(run.profile,this.env),run.timeoutMs>180000?longRequestFetch:fetch));
      let invalid:string|undefined,context=run.context,lookups=0,repaired=false;
      let stage:'primary'|'lookup'|'repair'='primary';
      for(let attempt=0;attempt<4;attempt++) {
        if(combined.aborted) throw new ModelError('CANCELLED');
        for(;;) {
          try {callId=(await this.client.request<{id:string}>(base+'/calls',{...auth,requestKey:run.id+':'+attempt,stage},combined)).id;break;}
          catch(e) {if(e instanceof CoreError&&e.status===429){await delay(500,combined);if(combined.aborted)throw new ModelError('CANCELLED');continue;}throw e;}
        }
        const result=await model.complete(run.kind,context,{signal:AbortSignal.any([combined,AbortSignal.timeout(run.timeoutMs)]),maxChars:run.contextChars,...invalid?{repair:invalid}:{}});
        await this.retryResult(base+'/calls/'+callId,{token:run.token,usage:result.usage,error:null});callId=null;
        let parsed:unknown;
        try {parsed=run.profile.provider==='mock'?parseOutput(run.kind,result.text,false):parseModelOutput(run.kind,result.text,context,run.profile.jsonMode==='schema');}
        catch(e) {if(!repaired){repaired=true;invalid=result.text.slice(0,2000);stage='repair';continue;}throw e;}
        const lookup=LookupSchema.safeParse(parsed);
        if(lookup.success) {
          if(lookups>=2)throw new ModelError('FORMAT_ERROR');
          context=await this.client.request<Context>(base+'/lookup',{...auth,requestKey:run.id+':lookup:'+lookups,requests:lookup.data.requests},combined);
          lookups++;stage='lookup';invalid=undefined;continue;
        }
        await this.retryResult(base+'/result',{...auth,output:parsed});return true;
      }
      throw new ModelError('FORMAT_ERROR');
    } catch(e) {
      const stale=e instanceof CoreError&&['STALE_RUN','STALE_WORKER','BUDGET_STOPPED'].includes(e.code);
      const invalidResult=e instanceof CoreError&&(e.status===422||(e.status===409&&!stale));
      const code:ModelErrorCode=e instanceof ModelError?e.code:invalidResult?'FORMAT_ERROR':combined.aborted?'CANCELLED':'API_ERROR';
      const usage:Usage=e instanceof ModelError&&e.usage?e.usage:{inputTokens:null,outputTokens:null};
      if(callId) await this.client.request(base+'/calls/'+callId,{token:run.token,usage,error:code,retryAfterMs:e instanceof ModelError?e.retryAfterMs:0}).catch(()=>{});
      // Stale generations are already fenced. Other rejected results must not leave a reusable active run.
      if(!stale) await this.client.request(base+'/failure',{...auth,code}).catch(()=>{});
      return true;
    } finally { clearInterval(heartbeat); this.controller=null; }
  }
  private async retryResult(path:string,body:unknown):Promise<void> {
    for(let attempt=0;;attempt++) {
      try { await this.client.request(path,body); return; }
      catch(e) { if(attempt>=2||e instanceof CoreError&&e.status>=400&&e.status<500) throw e; await delay(200*(attempt+1)); }
    }
  }
}
