import { z } from 'zod';

const Id=z.string().uuid();
export const DraftValueSchema=z.object({text:z.string().max(8000),addressedTo:z.union([Id,z.literal('')])}).strict();
export type DraftValue=z.infer<typeof DraftValueSchema>;
const Payload=z.object({text:z.string().max(8000),replyTo:Id.nullable(),addressedTo:z.array(Id).max(16)}).strict();
export const DraftRecordSchema=z.object({
  scope:z.string().regex(/^[a-f0-9]{64}$/),key:z.string().max(200),sessionId:Id,replyTo:Id.nullable(),
  version:z.number().int().nonnegative(),editVersion:z.number().int().nonnegative(),draft:DraftValueSchema,
  outbox:z.object({key:Id,payload:Payload,editVersion:z.number().int().nonnegative(),
    state:z.enum(['sending','unknown','confirmed','rejected']),messageId:Id.nullable()}).strict().nullable(),
}).strict().refine(row=>row.key===row.sessionId+(row.replyTo?'/reply/'+row.replyTo:''),'Draft key must match its session and reply target')
  .refine(row=>!row.outbox||row.outbox.payload.replyTo===row.replyTo,'Outbox reply target cannot change');
export type DraftRecord=z.infer<typeof DraftRecordSchema>;
export type DraftMutation=(current:DraftRecord)=>DraftRecord;
export interface DraftStore {
  load(scope:string):Promise<{generation:number;records:DraftRecord[]}>;
  change(base:DraftRecord,generation:number,edit:DraftMutation):Promise<DraftRecord>;
  clear(scope:string):Promise<void>;
  close():void;
}
export function emptyRecord(scope:string,key:string):DraftRecord {
  const [sessionId,replyTo]=key.split('/reply/');
  if(key!==sessionId+(replyTo?'/reply/'+replyTo:''))throw new Error('DRAFT_KEY_INVALID');
  return DraftRecordSchema.parse({scope,key,sessionId,replyTo:replyTo??null,version:0,editVersion:0,draft:{text:'',addressedTo:''},outbox:null});
}
/** One version check and write in the same IndexedDB transaction, including logout-generation fencing. */
export class IndexedDraftStore implements DraftStore {
  private database:Promise<IDBDatabase>;
  constructor(){
    this.database=new Promise((resolve,reject)=>{
      if(typeof indexedDB==='undefined'){reject(new Error('DRAFT_STORAGE_UNAVAILABLE'));return;}
      const request=indexedDB.open('multi-llm-session-drafts',1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore('records',{keyPath:['scope','key']}).createIndex('scope','scope');
        db.createObjectStore('scopes',{keyPath:'scope'});
      };
      request.onerror=()=>reject(new Error('DRAFT_STORAGE_UNAVAILABLE'));
      request.onblocked=()=>reject(new Error('DRAFT_STORAGE_BLOCKED'));
      request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    });
  }
  async load(scope:string){
    const db=await this.database;
    return new Promise<{generation:number;records:DraftRecord[]}>((resolve,reject)=>{
      const tx=db.transaction(['records','scopes'],'readonly');
      const rows=tx.objectStore('records').index('scope').getAll(scope),meta=tx.objectStore('scopes').get(scope);
      tx.onerror=()=>reject(new Error('DRAFT_STORAGE_READ_FAILED'));
      tx.onabort=()=>reject(new Error('DRAFT_STORAGE_READ_FAILED'));
      tx.oncomplete=()=>{
        try{resolve({generation:meta.result?.generation??0,records:rows.result.map(row=>DraftRecordSchema.parse(row))});}
        catch{reject(new Error('DRAFT_STORAGE_INVALID'));}
      };
    });
  }
  async change(base:DraftRecord,generation:number,edit:DraftMutation){
    const db=await this.database;
    return new Promise<DraftRecord>((resolve,reject)=>{
      const tx=db.transaction(['records','scopes'],'readwrite');let result:DraftRecord;let failure='DRAFT_STORAGE_WRITE_FAILED';
      const abort=(code:string)=>{failure=code;tx.abort();};
      tx.onabort=()=>reject(new Error(failure));tx.onerror=()=>{failure=tx.error?.name==='QuotaExceededError'?'DRAFT_STORAGE_FULL':failure;};
      tx.oncomplete=()=>resolve(result);
      const meta=tx.objectStore('scopes').get(base.scope);
      meta.onsuccess=()=>{
        if((meta.result?.generation??0)!==generation){abort('DRAFT_SCOPE_REVOKED');return;}
        const request=tx.objectStore('records').get([base.scope,base.key]);
        request.onsuccess=()=>{
          try{
            const current=request.result?DraftRecordSchema.parse(request.result):emptyRecord(base.scope,base.key);
            if(current.version!==base.version){abort('DRAFT_CONFLICT');return;}
            result=DraftRecordSchema.parse({...edit(structuredClone(current)),version:current.version+1});
            if(result.scope!==base.scope||result.key!==base.key||result.sessionId!==current.sessionId||result.replyTo!==current.replyTo){abort('DRAFT_OWNER_MISMATCH');return;}
            tx.objectStore('records').put(result);
          }catch(error){abort(error instanceof Error&&/^DRAFT_[A-Z_]+$/.test(error.message)?error.message:'DRAFT_STORAGE_INVALID');}
        };
      };
    });
  }
  async clear(scope:string){
    const db=await this.database;
    return new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(['records','scopes'],'readwrite'),meta=tx.objectStore('scopes').get(scope);
      meta.onsuccess=()=>tx.objectStore('scopes').put({scope,generation:(meta.result?.generation??0)+1});
      const cursor=tx.objectStore('records').index('scope').openCursor(IDBKeyRange.only(scope));
      cursor.onsuccess=()=>{const current=cursor.result;if(current){current.delete();current.continue();}};
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(new Error('DRAFT_STORAGE_CLEAR_FAILED'));tx.onerror=()=>reject(new Error('DRAFT_STORAGE_CLEAR_FAILED'));
    });
  }
  close(){void this.database.then(db=>db.close()).catch(()=>{});}
}
