import type { Page, PublicMessage, Snapshot } from '../../../packages/contracts/index.js';

export type ArchiveRead = <T>(path:string,body?:unknown)=>Promise<T>;
type Patch = Pick<PublicMessage,'id'|'sessionId'|'revision'> & Partial<PublicMessage>;
/** Read-only projection. It has no lifecycle, worker or message-publication API. */
export class ArchiveSession {
  private records=new Map<string,PublicMessage>();
  private historyIds=new Set<string>();
  private searchIds:string[]=[];
  private threadIds=new Set<string>();
  private alive=true;
  private notificationBatch=0;
  private initialized=false;
  private observedRevision=0;
  private revision=0;
  private historyGeneration=0;
  private searchGeneration=0;
  private threadGeneration=0;
  private olderPromise:Promise<void>|null=null;
  private repairPromise:Promise<void>|null=null;
  private repairAgain=false;
  private repairPending=false;
  private recoveryHigh:number|null=null;
  historyCursor:string|null=null;
  historyBusy=false;
  historyError='';
  searchCursor:string|null=null;
  searchBusy=false;
  searchError='';
  searchQuery='';
  searchStarted=false;
  searchStale=false;
  threadCursor:string|null=null;
  threadBusy=false;
  threadError='';
  threadRoot:string|null=null;
  constructor(readonly sessionId:string,private readonly read:ArchiveRead,private readonly changed:()=>void) {}
  private notify(){if(this.alive&&this.notificationBatch===0)this.changed();}
  private url(path:string){return `/v1/sessions/${encodeURIComponent(this.sessionId)}/${path}`;}
  private merge(messages:PublicMessage[],history=false){
    for(const message of messages){
      if(message.sessionId!==this.sessionId)continue;
      const previous=this.records.get(message.id);
      if(!previous||message.revision>=previous.revision)this.records.set(message.id,{...message,text:message.deleted?'':message.text});
      if(history)this.historyIds.add(message.id);
    }
  }
  private values(ids:Iterable<string>){return [...ids].map(id=>this.records.get(id)).filter((m):m is PublicMessage=>!!m);}
  get messages(){return this.values(this.historyIds).sort((a,b)=>a.sequence-b.sequence);}
  get results(){return this.values(this.searchIds).filter(m=>!m.deleted);}
  get thread(){return this.values(this.threadIds).sort((a,b)=>a.sequence-b.sequence);}
  /** SSE may patch loaded originals outside the latest snapshot; older versions can never resurrect text. */
  event(event:{revision:number;kind:string;message?:Patch}){
    if(!this.alive||!event.message||event.message.sessionId!==this.sessionId)return;
    if(this.initialized&&event.revision>Math.max(this.observedRevision,this.revision)+1){
      this.repairPending=true;
      if(this.repairPromise)this.repairAgain=true;
    }
    this.observedRevision=Math.max(this.observedRevision,event.revision);
    const old=this.records.get(event.message.id);
    if(old&&event.message.revision>=old.revision)this.merge([{...old,...event.message}]);
    if(event.kind==='message.updated'||event.kind==='message.deleted')this.searchStale=true;
    this.notify();
  }
  async synchronize(snapshot:Snapshot):Promise<void>{
    if(!this.alive||snapshot.session.id!==this.sessionId||snapshot.session.revision<this.revision)return;
    const previousHigh=this.recoveryHigh??this.messages.at(-1)?.sequence??0;
    const repair=this.initialized&&(this.repairPending||snapshot.session.revision>Math.max(this.observedRevision,this.revision));
    if(repair)this.repairPending=true;
    if(!this.initialized){this.historyCursor=snapshot.historyCursor;this.initialized=true;}
    this.revision=snapshot.session.revision;this.merge(snapshot.messages,true);
    if(this.threadRoot)for(const m of snapshot.messages)if(m.threadRootId===this.threadRoot)this.threadIds.add(m.id);
    this.notify();
    try{
      let cursor=snapshot.historyCursor;
      if(previousHigh&&snapshot.messages.length&&(snapshot.messages[0].sequence>previousHigh+1)){
        // Receiving the newest page does not acknowledge the missing interval. Retain
        // its earlier high-water mark until every bridging page has been recovered.
        this.recoveryHigh=previousHigh;this.notificationBatch++;
        try{
          while(cursor&&this.alive){
            const page=await this.read<Page<PublicMessage>>(this.url('history?limit=100&cursor='+encodeURIComponent(cursor)));
            if(!this.alive)return;this.merge(page.items,true);
            if(!page.items.length||page.items[0].sequence<=previousHigh+1)break;
            if(page.nextCursor===cursor)throw new Error('PAGE_CURSOR_STALLED');cursor=page.nextCursor;
          }
          this.recoveryHigh=null;
        }finally{this.notificationBatch--;this.notify();}
      }
      if(repair)await this.revalidateKnown();
    }catch(error){if(this.alive){this.historyError=error instanceof Error?error.message:'履歴を再同期できませんでした。';this.notify();}}
  }
  private revalidateKnown():Promise<void>{
    this.repairPending=true;this.repairAgain=true;if(this.repairPromise)return this.repairPromise;
    this.repairPromise=(async()=>{
      this.notificationBatch++;
      try{
        while(this.repairAgain&&this.alive){
          this.repairAgain=false;const ids=[...this.records.keys()];
          for(let i=0;i<ids.length&&this.alive;i+=200){
            const messages=await this.read<PublicMessage[]>(this.url('messages/lookup'),{ids:ids.slice(i,i+200)});
            if(!this.alive)return;this.merge(messages);
          }
        }
        // Snapshot revision alone does not prove old records were reconciled. Keep
        // this flag on failure so a later snapshot of the SAME revision retries.
        this.repairPending=false;this.historyError='';
      }finally{this.notificationBatch--;this.notify();}
    })().finally(()=>{this.repairPromise=null;});return this.repairPromise;
  }
  async resynchronize():Promise<void>{
    const generation=++this.historyGeneration, first=this.messages[0]?.sequence;
    this.historyBusy=true;this.historyError='';this.notify();
    try {
      const snapshot=await this.read<Snapshot>(this.url('snapshot'));
      if(!this.alive||generation!==this.historyGeneration)return;
      this.historyCursor=snapshot.historyCursor;this.merge(snapshot.messages,true);
      while(this.historyCursor&&first!==undefined&&this.alive) {
        const cursor=this.historyCursor;
        const page=await this.read<Page<PublicMessage>>(this.url('history?limit=100&cursor='+encodeURIComponent(cursor)));
        if(!this.alive||generation!==this.historyGeneration)return;
        if(page.nextCursor===cursor)throw new Error('PAGE_CURSOR_STALLED');
        this.merge(page.items,true);this.historyCursor=page.nextCursor;this.notify();
        if(!page.items.length||page.items[0].sequence<=first)break;
      }
      await this.revalidateKnown();await this.synchronize(snapshot);
    }catch(error){if(this.alive&&generation===this.historyGeneration){this.historyError=error instanceof Error?error.message:'履歴を再同期できませんでした。';throw error;}}
    finally{if(generation===this.historyGeneration){this.historyBusy=false;this.notify();}}
  }
  loadOlder():Promise<void>{
    if(this.olderPromise)return this.olderPromise;
    if(!this.historyCursor||!this.alive)return Promise.resolve();
    const cursor=this.historyCursor,generation=this.historyGeneration;this.historyBusy=true;this.historyError='';this.notify();
    this.olderPromise=(async()=>{
      try{
        const page=await this.read<Page<PublicMessage>>(this.url('history?limit=100&cursor='+encodeURIComponent(cursor)));
        if(!this.alive||generation!==this.historyGeneration)return;
        if(page.nextCursor===cursor)throw new Error('PAGE_CURSOR_STALLED');
        this.merge(page.items,true);this.historyCursor=page.nextCursor;
      }catch(error){if(this.alive&&generation===this.historyGeneration){this.historyError=error instanceof Error?error.message:'以前の発言を取得できませんでした。';throw error;}}
      finally{if(generation===this.historyGeneration)this.historyBusy=false;this.olderPromise=null;this.notify();}
    })();return this.olderPromise;
  }
  changeQuery(){this.searchGeneration++;this.searchBusy=false;this.searchCursor=null;this.searchError='';this.searchIds=[];this.searchStarted=false;this.notify();}
  async search(query:string,more=false):Promise<void>{
    if(!this.alive||more&&(!this.searchCursor||this.searchBusy))return;
    if(more&&this.searchStale){this.searchError='検索結果が更新されました。先頭から再検索してください。';this.notify();return;}
    const generation=++this.searchGeneration,cursor=more?this.searchCursor:null;
    if(!more){this.searchIds=[];this.searchQuery=query;this.searchStale=false;}
    this.searchBusy=true;this.searchError='';this.searchStarted=true;this.notify();
    try{
      const page=await this.read<Page<PublicMessage>>(this.url('search-page?limit=50&q='+encodeURIComponent(query)+(cursor?'&cursor='+encodeURIComponent(cursor):'')));
      if(!this.alive||generation!==this.searchGeneration)return;
      this.merge(page.items);this.searchIds=[...new Set([...this.searchIds,...page.items.map(m=>m.id)])];this.searchCursor=page.nextCursor;
    }catch(error){
      if(this.alive&&generation===this.searchGeneration)this.searchError=error instanceof Error&&error.message.includes('PAGE_RESYNC_REQUIRED')?'検索結果が更新されました。先頭から再検索してください。':error instanceof Error?error.message:'検索に失敗しました。';
    }finally{if(generation===this.searchGeneration){this.searchBusy=false;this.notify();}}
  }
  async openThread(id:string,more=false):Promise<void>{
    if(!this.alive||more&&(!this.threadCursor||this.threadBusy))return;
    const generation=++this.threadGeneration,cursor=more?this.threadCursor:null;
    if(!more){this.threadIds.clear();this.threadRoot=null;this.threadCursor=null;}
    this.threadBusy=true;this.threadError='';this.notify();
    try{
      const page=await this.read<Page<PublicMessage>&{rootId:string}>(this.url('threads/'+encodeURIComponent(id)+'?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):'')));
      if(!this.alive||generation!==this.threadGeneration)return;
      this.merge(page.items);for(const m of page.items)this.threadIds.add(m.id);this.threadRoot=page.rootId;this.threadCursor=page.nextCursor;
    }catch(error){if(this.alive&&generation===this.threadGeneration)this.threadError=error instanceof Error?error.message:'返信を取得できませんでした。';}
    finally{if(generation===this.threadGeneration){this.threadBusy=false;this.notify();}}
  }
  async locate(id:string):Promise<boolean>{
    // Batch deep-link paging: render the final range once, not a growing thousand-row tree after every page.
    this.historyBusy=true;this.notify();this.notificationBatch++;
    try {
      const originals=await this.read<PublicMessage[]>(this.url('messages/lookup'),{ids:[id]});
      if(!this.alive)return false;const target=originals[0];if(!target)return false;this.merge(originals);
      while(this.alive&&!this.historyIds.has(id)&&this.historyCursor)await this.loadOlder();
      return this.alive&&this.historyIds.has(id);
    } finally { this.notificationBatch--;this.historyBusy=false;this.notify(); }
  }
  dispose(){this.alive=false;this.historyGeneration++;this.searchGeneration++;this.threadGeneration++;this.records.clear();this.historyIds.clear();this.searchIds=[];this.threadIds.clear();}
}
