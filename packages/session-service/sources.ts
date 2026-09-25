import { ManualSource, type AcquiredItem } from '../sources/adapters.js';
export type { AcquiredItem } from '../sources/adapters.js';
import { randomUUID } from 'node:crypto';
import { ensure, type SourceInput } from '../contracts/index.js';
import { SourceSchema, SourceUpdateSchema, FeedSubscriptionSchema } from '../contracts/source.js';
import { hash } from '../domain/index.js';
import type { Config } from '../config/index.js';
import type { AgentRow, SessionRow, Store } from '../storage-sqlite/index.js';
import { sourceAllowed, type SourceRow } from './source-access.js';

export type SourcePort = {
  store:Store;config:Config;now:()=>number;session:(id:string)=>SessionRow;agents:(id:string)=>AgentRow[];
  write:<T>(fn:()=>T)=>T;receipt:<T>(scope:string,key:string,input:unknown,fn:()=>T)=>T;
  cancel:(session:string,reason:string,slot:string)=>void;wake:(agent:string,reason:string)=>void;
  invalidate:(session:string,id:string)=>void;
  emit:(session:string,kind:string,data:Record<string,unknown>)=>void;
  trace:(session:string,agent:string|null,run:string|null,code:string,detail?:Record<string,unknown>)=>void;
};
export type FeedDefinition={configId:string;url:string;intervalMs:number;audience:string[]|null;enabled:boolean};
export type FeedRow={id:string;session_id:string;config_id:string;version:number;definition_json:string;enabled:number;
  next_at:number;last_success_at:number|null;last_error:string|null;failures:number;job_token:string|null;lease_until:number|null};
export type FeedJob={id:string;feedId:string;sessionId:string;version:number;definition:FeedDefinition};

export { validateFeedUrl } from '../config/source-url.js';
import { validateFeedUrl } from '../config/source-url.js';
const sourceInput=(row:SourceRow):SourceInput=>({title:row.title,text:row.text,url:row.url,publishedAt:row.published_at,
  audience:JSON.parse(row.audience_json),enabled:!!row.enabled});

/** Synchronous source transitions are part of SessionService's command/write transaction. Network I/O is outside. */
export class SessionSources {
  constructor(private readonly p:SourcePort){}
  private audience(session:string,value:string[]|null){
    const members=new Set(this.p.agents(session).map(a=>a.id));
    ensure(value===null||value.every(id=>members.has(id)),422,'SOURCE_AUDIENCE_FORBIDDEN');
  }
  private mutable(session:string){ensure(this.p.session(session).lifecycle!=='ENDED',409,'SESSION_ENDED');}
  private row(session:string,id:string):SourceRow {
    this.p.session(session);const row=this.p.store.get<SourceRow>('SELECT * FROM source_items WHERE session_id=? AND id=?',session,id);
    ensure(row,404,'SOURCE_NOT_FOUND');return row;
  }
  list(session:string){
    this.p.session(session);return this.p.store.all<Omit<SourceRow,'text'> & {total_chars:number}>(
      'SELECT id,session_id,source,external_id,version,title,url,published_at,fetched_at,enabled,audience_json,length(text) total_chars FROM source_items WHERE session_id=? ORDER BY fetched_at DESC,rowid DESC',session)
      .map(row=>({id:row.id,version:row.version,source:row.source,title:row.title,url:row.url,publishedAt:row.published_at,
        audience:JSON.parse(row.audience_json) as string[]|null,enabled:!!row.enabled,fetchedAt:row.fetched_at,totalCodePoints:row.total_chars}));
  }
  get(session:string,id:string,version?:number){
    const current=this.row(session,id),row=version===undefined?current:this.p.store.get<SourceRow>('SELECT *,source_id id FROM source_versions WHERE source_id=? AND version=?',id,version);
    ensure(row,404,'SOURCE_VERSION_NOT_FOUND');return {id,version:row.version,...sourceInput(row),fetchedAt:row.fetched_at};
  }
  versions(session:string,id:string){
    this.row(session,id);return this.p.store.all<{version:number;title:string;fetched_at:number;published_at:string|null;enabled:number;audience_json:string}>(
      'SELECT version,title,fetched_at,published_at,enabled,audience_json FROM source_versions WHERE source_id=? ORDER BY version DESC',id)
      .map(row=>({version:row.version,title:row.title,fetchedAt:row.fetched_at,publishedAt:row.published_at,enabled:!!row.enabled,audience:JSON.parse(row.audience_json)}));
  }
  inject(session:string,input:unknown,key:string,source='manual'):{id:string;version:number}{
    const [{externalId:_,...data}]=new ManualSource(input,key).acquire();
    if(data.audience)data.audience.sort();
    const {audience,enabled,...legacy}=data;
    const receiptInput={...legacy,...audience===null?{}:{audience},...enabled?{}:{enabled}};
    return this.p.receipt(`operator:${session}:source:${source}`,key,receiptInput,()=>{
      this.mutable(session);this.audience(session,data.audience);
      const old=this.p.store.get<SourceRow>('SELECT * FROM source_items WHERE session_id=? AND source=? AND external_id=?',session,source,key);
      if(old){ensure(hash(sourceInput(old))===hash(data),409,'SOURCE_REVISION_REQUIRED');return {id:old.id,version:old.version};}
      return this.apply(session,undefined,data,source,key);
    });
  }
  update(session:string,id:string,input:unknown,key:string){
    const data=SourceUpdateSchema.parse(input);if(data.audience)data.audience.sort();return this.p.receipt(`operator:${session}:source-update`,key,{id,...data},()=>{
      this.mutable(session);this.audience(session,data.audience);const row=this.row(session,id);
      ensure(row.version===data.expectedVersion,409,'STALE_SOURCE_VERSION');
      const {expectedVersion:_,...next}=data;return this.apply(session,row,next,row.source,row.external_id);
    });
  }
  private apply(session:string,old:SourceRow|undefined,data:SourceInput,source:string,key:string){
    ensure(this.p.store.db.inTransaction,500,'SOURCE_TRANSACTION_REQUIRED');
    if(old&&hash(sourceInput(old))===hash(data))return {id:old.id,version:old.version};
    const id=old?.id??randomUUID(),version=old?old.version+1:1,now=this.p.now();
    ensure(Number.isSafeInteger(version),409,'SOURCE_VERSION_EXHAUSTED');
    if(old)this.p.store.run('UPDATE source_items SET title=?,text=?,url=?,published_at=?,fetched_at=?,enabled=?,audience_json=?,version=? WHERE id=?',
      data.title,data.text,data.url,data.publishedAt,now,data.enabled?1:0,JSON.stringify(data.audience),version,id);
    else this.p.store.run('INSERT INTO source_items(id,session_id,source,external_id,title,text,url,published_at,fetched_at,enabled,audience_json,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id,session,source,key,data.title,data.text,data.url,data.publishedAt,now,data.enabled?1:0,JSON.stringify(data.audience),version);
    const next=this.row(session,id);
    if(old)this.p.invalidate(session,id);
    for(const agent of this.p.agents(session)){
      const was=old&&sourceAllowed(old,agent.id),can=sourceAllowed(next,agent.id);
      if(!was&&!can)continue;
      if(old){
        this.p.cancel(session,'SOURCE_VERSION_CHANGED',agent.slot);
        // Cached LOOKUP command responses can contain the old private original. Do not replay them after revocation.
        for(const run of this.p.store.all<{id:string}>('SELECT id FROM runs WHERE agent_id=?',agent.id))
          this.p.store.run('DELETE FROM command_receipts WHERE scope=?',`worker:${agent.slot}:${run.id}:lookup`);
        if(was&&!can)this.p.store.run("UPDATE candidates SET state='DROPPED',reason='SOURCE_ACCESS_REVOKED' WHERE agent_id=? AND state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED')",agent.id);
        else this.p.store.run("UPDATE candidates SET state='NEEDS_REVIEW',reason='SOURCE_VERSION_CHANGED' WHERE agent_id=? AND text IS NOT NULL AND state IN ('READY','NEEDS_REVIEW','DEFERRED')",agent.id);
      }
      this.p.wake(agent.id,old?'SOURCE_CHANGED':'SOURCE_AVAILABLE');
    }
    // Sources are not public messages. Never publish private titles, IDs, target lists or excerpts to SSE.
    if(data.audience===null&&data.enabled)this.p.emit(session,'source.available',{sourceId:id,title:data.title,version});
    else if(old?.audience_json==='null')this.p.emit(session,'source.withdrawn',{sourceId:id});
    this.p.trace(session,null,null,old?'SOURCE_REVISED':'SOURCE_ACQUIRED',{sourceId:id,version});
    return {id,version};
  }
  configured(){return this.p.config.feeds.map(feed=>{let usable=true;try{validateFeedUrl(feed.url);ensure(feed.intervalMs>=60000&&feed.intervalMs<=86400000,422,'INVALID_FEED_INTERVAL');}catch{usable=false;}
    return {id:feed.id,url:usable?feed.url:null,intervalMs:feed.intervalMs,usable};});}
  feeds(session:string){
    this.p.session(session);return this.p.store.all<FeedRow>('SELECT * FROM source_feeds WHERE session_id=? ORDER BY config_id',session)
      .map(({definition_json,job_token,...row})=>({...row,definition:JSON.parse(definition_json) as FeedDefinition,working:!!job_token&&row.lease_until!==null&&row.lease_until>this.p.now()}));
  }
  putFeed(session:string,input:unknown,key:string){
    const data=FeedSubscriptionSchema.parse(input);if(data.audience)data.audience.sort();return this.p.receipt(`operator:${session}:feed`,key,data,()=>{
      this.mutable(session);this.audience(session,data.audience);
      const config=this.p.config.feeds.find(feed=>feed.id===data.configId);ensure(config,422,'FEED_NOT_ALLOWLISTED');validateFeedUrl(config.url);
      const old=this.p.store.get<FeedRow>('SELECT * FROM source_feeds WHERE session_id=? AND config_id=?',session,data.configId);
      ensure((old?.version??0)===data.expectedVersion,409,'STALE_FEED_VERSION');
      const definition:FeedDefinition={configId:config.id,url:config.url,intervalMs:data.intervalMs??config.intervalMs,audience:data.audience,enabled:data.enabled};
      ensure(definition.intervalMs>=60000&&definition.intervalMs<=86400000,422,'INVALID_FEED_INTERVAL');
      const id=old?.id??randomUUID(),version=(old?.version??0)+1;
      if(old){
        this.p.store.run("UPDATE source_feed_jobs SET state='STALE',finished_at=?,error_code='CONFIG_CHANGED' WHERE feed_id=? AND state='RUNNING'",this.p.now(),id);
        this.p.store.run('UPDATE source_feeds SET version=?,definition_json=?,enabled=?,next_at=?,job_token=NULL,lease_until=NULL,last_error=NULL,failures=0 WHERE id=?',version,JSON.stringify(definition),data.enabled?1:0,this.p.now(),id);
        // Only an explicit audience change retargets originals; changing the interval must not widen item overrides.
        const previous=JSON.parse(old.definition_json) as FeedDefinition;
        if(hash(previous.audience)!==hash(data.audience))for(const source of this.p.store.all<SourceRow>('SELECT * FROM source_items WHERE session_id=? AND source=?',session,'feed:'+id))
          if(source.audience_json!==JSON.stringify(data.audience))this.apply(session,source,{...sourceInput(source),audience:data.audience},source.source,source.external_id);
      }else {
        this.p.store.run('INSERT INTO source_feeds(id,session_id,config_id,version,definition_json,enabled,next_at) VALUES(?,?,?,?,?,?,?)',
          id,session,config.id,version,JSON.stringify(definition),data.enabled?1:0,this.p.now());
        // Adopt the pre-V8 configured-feed namespace without replacing IDs, originals, versions or observations.
        this.p.store.run('UPDATE source_items SET source=? WHERE session_id=? AND source=?','feed:'+id,session,config.id);
      }
      this.p.store.run('INSERT INTO source_feed_versions(feed_id,version,definition_json,created_at) VALUES(?,?,?,?)',id,version,JSON.stringify(definition),this.p.now());
      return {id,version};
    });
  }
  retryFeed(session:string,id:string,key:string){return this.p.receipt(`operator:${session}:feed-retry`,key,{id},()=>{
    this.mutable(session);const row=this.p.store.get<FeedRow>('SELECT * FROM source_feeds WHERE id=? AND session_id=?',id,session);
    ensure(row,404,'FEED_NOT_FOUND');ensure(row.enabled,409,'FEED_DISABLED');
    ensure(!row.job_token||!row.lease_until||row.lease_until<=this.p.now(),409,'FEED_BUSY');
    this.p.store.run('UPDATE source_feeds SET next_at=? WHERE id=?',this.p.now(),id);return {ok:true};
  });}
  seedConfigured():void {
    for(const session of this.p.store.all<{id:string}>("SELECT id FROM sessions WHERE lifecycle='RUNNING'"))for(const config of this.configured().filter(feed=>feed.usable)){
      if(this.p.store.get('SELECT id FROM source_feeds WHERE session_id=? AND config_id=?',session.id,config.id))continue;
      this.putFeed(session.id,{configId:config.id,expectedVersion:0},'configured:'+hash([session.id,config.id]));
    }
  }
  dueFeeds():string[]{return this.p.store.all<{id:string}>(`SELECT f.id FROM source_feeds f JOIN sessions s ON s.id=f.session_id
    WHERE s.lifecycle='RUNNING' AND f.enabled=1 AND f.next_at<=? AND (f.job_token IS NULL OR f.lease_until<=?) ORDER BY f.next_at,f.id LIMIT 20`,this.p.now(),this.p.now()).map(row=>row.id);}
  claimFeed(id:string):FeedJob|null{return this.p.write(()=>{
    const row=this.p.store.get<FeedRow>('SELECT * FROM source_feeds WHERE id=?',id);
    if(!row||!row.enabled||this.p.session(row.session_id).lifecycle!=='RUNNING'||row.next_at>this.p.now()||
      row.job_token&&row.lease_until!==null&&row.lease_until>this.p.now())return null;
    const definition=JSON.parse(row.definition_json) as FeedDefinition,config=this.p.config.feeds.find(feed=>feed.id===row.config_id);
    if(!config||config.url!==definition.url){this.p.store.run("UPDATE source_feeds SET last_error='FEED_CONFIGURATION_CHANGED',next_at=? WHERE id=?",this.p.now()+60000,id);return null;}
    validateFeedUrl(definition.url);
    this.p.store.run("UPDATE source_feed_jobs SET state='FAILED',error_code='LEASE_EXPIRED',finished_at=? WHERE feed_id=? AND state='RUNNING'",this.p.now(),id);
    const token=randomUUID(),expires=this.p.now()+30000;
    this.p.store.run('INSERT INTO source_feed_jobs(id,feed_id,feed_version,state,started_at,expires_at) VALUES(?,?,?,\'RUNNING\',?,?)',token,id,row.version,this.p.now(),expires);
    this.p.store.run('UPDATE source_feeds SET job_token=?,lease_until=? WHERE id=?',token,expires,id);
    return {id:token,feedId:id,sessionId:row.session_id,version:row.version,definition};
  });}
  finishFeed(job:FeedJob,items:AcquiredItem[],error:string|null=null):boolean{return this.p.write(()=>{
    const row=this.p.store.get<FeedRow>('SELECT * FROM source_feeds WHERE id=?',job.feedId);
    const recorded=this.p.store.get<{state:string}>('SELECT state FROM source_feed_jobs WHERE id=? AND feed_id=? AND feed_version=?',job.id,job.feedId,job.version);
    if(recorded?.state==='DONE')return true;
    if(!row||row.session_id!==job.sessionId||!recorded||recorded.state!=='RUNNING'||row.job_token!==job.id||row.version!==job.version||!row.enabled||
      row.lease_until===null||row.lease_until<=this.p.now()||this.p.session(job.sessionId).lifecycle==='ENDED'){
      if(recorded?.state==='RUNNING')this.p.store.run("UPDATE source_feed_jobs SET state='STALE',error_code='STALE_FEED_RESULT',finished_at=? WHERE id=?",this.p.now(),job.id);
      if(row?.job_token===job.id)this.p.store.run('UPDATE source_feeds SET job_token=NULL,lease_until=NULL WHERE id=?',job.feedId);
      return false;
    }
    const safeErrors=['FEED_HTTP_ERROR','FEED_SIZE_LIMIT','FEED_TIMEOUT','UNSAFE_FEED','FEED_PARSE_ERROR'];
    const code=error?(safeErrors.includes(error)?error:'FEED_HTTP_ERROR'):null;
    ensure(items.length<=20,422,'FEED_ITEM_LIMIT');
    const definition=JSON.parse(row.definition_json) as FeedDefinition;
    if(!code)for(const item of items){
      ensure(/^[a-f0-9]{64}$/.test(item.externalId),422,'INVALID_FEED_ITEM_ID');
      const {externalId:_,...content}=item;SourceSchema.parse(content);
    }
    if(!code)for(const item of items){
      const {externalId,...content}=item;
      const old=this.p.store.get<SourceRow>('SELECT * FROM source_items WHERE session_id=? AND source=? AND external_id=?',job.sessionId,'feed:'+job.feedId,externalId);
      // Acquiring revised text never grants access or re-enables an individually disabled original.
      // Previously validated instance IDs may now be retired; do not transfer them to a replacement.
      const data=SourceSchema.parse({...content,audience:old?JSON.parse(old.audience_json):definition.audience,enabled:old?!!old.enabled:true});
      this.apply(job.sessionId,old,data,'feed:'+job.feedId,externalId);
    }
    const failures=code?row.failures+1:0,interval=code?Math.min(3600000,60000*2**Math.min(failures-1,6)):definition.intervalMs;
    this.p.store.run('UPDATE source_feed_jobs SET state=?,finished_at=?,error_code=?,item_count=? WHERE id=?',code?'FAILED':'DONE',this.p.now(),code,code?0:items.length,job.id);
    this.p.store.run('UPDATE source_feeds SET job_token=NULL,lease_until=NULL,next_at=?,last_success_at=?,last_error=?,failures=? WHERE id=?',
      this.p.now()+interval,code?row.last_success_at:this.p.now(),code,failures,row.id);
    if(code)this.p.trace(job.sessionId,null,null,'FEED_ERROR',{feedId:row.id,code});return true;
  });}
}
