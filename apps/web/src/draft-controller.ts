import { DraftValueSchema, emptyRecord, type DraftRecord, type DraftStore, type DraftValue } from './draft-store.js';

type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
type Signal={scope:string;kind:'changed'|'clear';key?:string};
/** Durable user drafts and immutable submission receipts. No timer automatically retries a message. */
export class DraftController {
  ready=false;error='';
  private generation=0;private alive=true;
  private records=new Map<string,DraftRecord>();
  private local=new Map<string,{draft:DraftValue;sequence:number}>();
  private queue:Promise<void>=Promise.resolve();
  private sequence=0;private active=new Set<string>();private errors=new Map<string,string>();
  private pending=new Map<string,number>();
  constructor(readonly scope:string,private readonly store:DraftStore,private readonly api:Api,
    private readonly changed:()=>void,private readonly broadcast:(signal:Signal)=>void=()=>{}){}
  private notify(){if(this.alive)this.changed();}
  async initialize(){try{const saved=await this.store.load(this.scope);if(!this.alive)return;this.generation=saved.generation;for(const row of saved.records)this.records.set(row.key,row);this.ready=true;}catch(error){this.error=error instanceof Error?error.message:'DRAFT_STORAGE_UNAVAILABLE';}this.notify();}
  record(key:string){return this.records.get(key)??emptyRecord(this.scope,key);}
  draft(key:string){return this.local.get(key)?.draft??this.record(key).draft;}
  status(key:string){const row=this.record(key);return {error:this.errors.get(key)??this.error,saving:(this.pending.get(key)??0)>0,busy:this.active.has(key),conflict:this.errors.get(key)==='DRAFT_CONFLICT',outbox:row.outbox,
    unknown:!!row.outbox&&['sending','unknown'].includes(row.outbox.state)&&!this.active.has(key),unavailable:!this.ready};}
  private async mutate(key:string,change:(row:DraftRecord)=>DraftRecord){
    if(!this.alive||!this.ready)throw new Error('DRAFT_STORAGE_UNAVAILABLE');
    const value=await this.store.change(this.record(key),this.generation,change);
    if(this.alive){this.records.set(key,value);this.errors.delete(key);this.broadcast({scope:this.scope,kind:'changed',key});this.notify();}return value;
  }
  edit(key:string,input:DraftValue){
    const draft=DraftValueSchema.parse(input),sequence=++this.sequence;
    this.local.set(key,{draft,sequence});this.pending.set(key,(this.pending.get(key)??0)+1);this.notify();
    this.queue=this.queue.then(async()=>{
      try{await this.mutate(key,row=>({...row,draft,editVersion:row.editVersion+1}));if(this.local.get(key)?.sequence===sequence)this.local.delete(key);}
      catch(error){this.errors.set(key,error instanceof Error?error.message:'DRAFT_STORAGE_WRITE_FAILED');}
      finally{this.pending.set(key,(this.pending.get(key)??1)-1);this.notify();}
    });
  }
  async reload(key:string){
    await this.queue;const saved=await this.store.load(this.scope);if(!this.alive)return;
    if(saved.generation!==this.generation)throw new Error('DRAFT_SCOPE_REVOKED');
    this.records.set(key,saved.records.find(row=>row.key===key)??emptyRecord(this.scope,key));this.local.delete(key);this.errors.delete(key);this.notify();
  }
  receive(signal:Signal){
    if(signal.scope!==this.scope||!this.alive)return;
    if(signal.kind==='clear'){this.ready=false;this.records.clear();this.local.clear();this.error='DRAFT_SCOPE_REVOKED';this.notify();return;}
    // Another view's new version is never silently overwritten or used to erase this view's editor.
    if(signal.key){this.errors.set(signal.key,'DRAFT_CONFLICT');this.notify();}
  }
  private async ack(key:string,outboxKey:string,messageId:string){
    // Reloading on version conflict is safe here: clear only the exact draft edit submitted, never a newer edit.
    for(let attempt=0;attempt<3;attempt++){
      try{
        await this.mutate(key,row=>{
          if(row.outbox?.key!==outboxKey)throw new Error('DRAFT_OUTBOX_CHANGED');
          const clear=row.editVersion===row.outbox.editVersion&&row.draft.text===row.outbox.payload.text&&row.draft.addressedTo===(row.outbox.payload.addressedTo[0]??'');
          return {...row,draft:clear?{...row.draft,text:''}:row.draft,outbox:{...row.outbox,state:'confirmed',messageId}};
        });return;
      }catch(error){
        if(!(error instanceof Error)||error.message!=='DRAFT_CONFLICT'||attempt===2)throw error;
        const saved=await this.store.load(this.scope);
        if(saved.generation!==this.generation)throw new Error('DRAFT_SCOPE_REVOKED');
        const row=saved.records.find(r=>r.key===key);if(!row)throw new Error('DRAFT_OUTBOX_CHANGED');this.records.set(key,row);
      }
    }
  }
  async send(key:string){
    await this.queue;if(this.active.has(key))return;
    if(this.errors.has(key))throw new Error(this.errors.get(key));
    const record=this.record(key);if(!record.draft.text.trim())return;
    if(record.outbox&&['sending','unknown'].includes(record.outbox.state))throw new Error('DRAFT_RESULT_UNKNOWN');
    this.active.add(key);this.notify();
    try{
      const stored=await this.mutate(key,row=>({...row,outbox:{key:crypto.randomUUID(),payload:{text:row.draft.text,replyTo:row.replyTo,addressedTo:row.draft.addressedTo?[row.draft.addressedTo]:[]},editVersion:row.editVersion,state:'sending',messageId:null}}));
      await this.deliver(key,stored);
    }finally{this.active.delete(key);this.notify();}
  }
  private async deliver(key:string,record:DraftRecord){
    const outbox=record.outbox!;
    try{
      const message=await this.api<{id:string}>(`/v1/sessions/${record.sessionId}/messages`,outbox.payload,outbox.key);
      await this.ack(key,outbox.key,message.id);
    }catch(error){
      const status=(error as {status?:number}).status;
      // Authorization/transport/conflict failures remain unresolved; only definitive validation rejects can be edited and resubmitted.
      const rejected=status===422||status===410;
      try{await this.mutate(key,row=>row.outbox?.key===outbox.key?{...row,outbox:{...row.outbox,state:rejected?'rejected':'unknown'}}:row);}catch{}
      this.errors.set(key,rejected?'DRAFT_SUBMISSION_REJECTED':'DRAFT_RESULT_UNKNOWN');this.notify();throw error;
    }
  }
  async resolve(key:string){
    await this.queue;const record=this.record(key),outbox=record.outbox;if(!outbox)return;
    try{
      const result=await this.api<{id:string}>(`/v1/sessions/${record.sessionId}/commands/message/${outbox.key}`);
      await this.ack(key,outbox.key,result.id);
    }catch(error){if((error as {status?:number}).status===404){this.errors.set(key,'DRAFT_NO_RECEIPT');this.notify();return;}throw error;}
  }
  async retry(key:string){
    await this.queue;if(this.active.has(key))return;
    const status=this.status(key);if(status.conflict||status.unavailable)throw new Error(status.error||'DRAFT_STORAGE_UNAVAILABLE');
    await this.resolve(key);const record=this.record(key);if(record.outbox?.state==='confirmed'||!record.outbox)return;
    this.active.add(key);this.notify();
    try{const stored=await this.mutate(key,row=>({...row,outbox:row.outbox?{...row.outbox,state:'sending'}:null}));await this.deliver(key,stored);}
    finally{this.active.delete(key);this.notify();}
  }
  async clear(){await this.queue;await this.store.clear(this.scope);this.broadcast({scope:this.scope,kind:'clear'});this.records.clear();this.local.clear();this.ready=false;this.notify();}
  dispose(){this.alive=false;this.store.close();}
}
