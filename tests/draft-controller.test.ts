import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { DraftController } from '../apps/web/src/draft-controller.js';
import { DraftRecordSchema, emptyRecord, type DraftRecord, type DraftMutation, type DraftStore } from '../apps/web/src/draft-store.js';

const scope='a'.repeat(64);
/** Transactional storage fake for controller invariants; actual IndexedDB is exercised by Chromium. */
class MemoryStore implements DraftStore {
  rows=new Map<string,DraftRecord>();generation=0;failWrites=false;
  async load(owner:string){return {generation:this.generation,records:structuredClone([...this.rows.values()].filter(row=>row.scope===owner))};}
  async change(base:DraftRecord,generation:number,edit:DraftMutation){
    if(this.failWrites)throw new Error('DRAFT_STORAGE_FULL');
    if(generation!==this.generation)throw new Error('DRAFT_SCOPE_REVOKED');
    const current=this.rows.get(base.key)??emptyRecord(base.scope,base.key);
    if(current.version!==base.version)throw new Error('DRAFT_CONFLICT');
    const result=DraftRecordSchema.parse({...edit(structuredClone(current)),version:current.version+1});this.rows.set(base.key,result);return structuredClone(result);
  }
  async clear(owner:string){for(const [key,row] of this.rows)if(row.scope===owner)this.rows.delete(key);this.generation++;}
  close(){}
}
function api(f:ReturnType<typeof fixture>,before?: (body:unknown,key:string)=>void|Promise<void>){
  return async<T>(path:string,body?:unknown,key?:string):Promise<T>=>{
    if(path===`/v1/sessions/${f.id}/messages`){await before?.(body,key!);return f.service.humanMessage(f.id,body,key!) as T;}
    if(path.startsWith(`/v1/sessions/${f.id}/commands/message/`)){
      try{return f.service.commandReceipt(f.id,'message',path.split('/').at(-1)!) as T;}
      catch{throw Object.assign(new Error('COMMAND_NOT_FOUND'),{status:404});}
    }
    throw new Error('UNEXPECTED_DRAFT_ROUTE');
  };
}

it('R7-DRAFT-005: commit response loss survives reconstruction and acknowledgment cannot delete an edited draft',async()=>{
  const f=fixture(),store=new MemoryStore(),keys:string[]=[];let fail=true;
  const real=api(f);
  const transport=async<T>(path:string,body?:unknown,key?:string):Promise<T>=>{
    if(body){keys.push(key!);expect(store.rows.get(f.id)?.outbox?.key).toBe(key);}
    const result=await real<T>(path,body,key);if(body&&fail)throw new Error('SYNTHETIC_RESPONSE_LOST');return result;
  };
  const first=new DraftController(scope,store,transport,()=>{});
  try{
    await first.initialize();first.edit(f.id,{text:'元の投稿',addressedTo:''});await expect(first.send(f.id)).rejects.toThrow('SYNTHETIC_RESPONSE_LOST');
    expect(first.status(f.id).unknown).toBe(true);expect(f.service.snapshot(f.id).messages).toHaveLength(1);
    const second=new DraftController(scope,store,transport,()=>{});await second.initialize();expect(second.draft(f.id).text).toBe('元の投稿');
    second.edit(f.id,{text:'結果不明の元投稿とは別の改稿',addressedTo:''});await expect(second.send(f.id)).rejects.toThrow('DRAFT_RESULT_UNKNOWN');
    fail=false;await second.resolve(f.id);expect(second.draft(f.id).text).toBe('結果不明の元投稿とは別の改稿');
    expect(second.status(f.id).outbox?.state).toBe('confirmed');expect(f.service.snapshot(f.id).messages).toHaveLength(1);
    await second.send(f.id);expect(f.service.snapshot(f.id).messages.map(m=>m.text)).toEqual(['元の投稿','結果不明の元投稿とは別の改稿']);
    expect(new Set(keys).size).toBe(2);expect(second.draft(f.id).text).toBe('');second.dispose();
  }finally{first.dispose();f.close();}
});

it('R7-DRAFT-006: no receipt is not proof of failure; explicit retry uses the old payload/key rather than the revised editor',async()=>{
  const f=fixture(),store=new MemoryStore(),keys:string[]=[];let fail=true;
  const real=api(f),transport=async<T>(path:string,body?:unknown,key?:string):Promise<T>=>{
    if(body){keys.push(key!);if(fail)throw new Error('SYNTHETIC_UNREACHABLE');}return real<T>(path,body,key);
  };
  const controller=new DraftController(scope,store,transport,()=>{});
  try{
    await controller.initialize();controller.edit(f.id,{text:'元の本文',addressedTo:''});await expect(controller.send(f.id)).rejects.toThrow();
    const original=structuredClone(controller.record(f.id).outbox!);
    controller.edit(f.id,{text:'再送に混ぜない新しい本文',addressedTo:''});await controller.resolve(f.id);expect(controller.status(f.id).error).toBe('DRAFT_NO_RECEIPT');
    fail=false;await controller.retry(f.id);expect(keys).toEqual([original.key,original.key]);
    expect(f.service.snapshot(f.id).messages.map(m=>m.text)).toEqual(['元の本文']);expect(controller.draft(f.id).text).toBe('再送に混ぜない新しい本文');
    expect(controller.status(f.id).outbox?.state).toBe('confirmed');expect(f.service.session(f.id).call_count).toBe(0);
  }finally{controller.dispose();f.close();}
});

it('R7-DRAFT-007: independent tabs cannot overwrite another saved version; explicit reload is required',async()=>{
  const f=fixture(),store=new MemoryStore(),a=new DraftController(scope,store,api(f),()=>{}),b=new DraftController(scope,store,api(f),()=>{});
  try{
    await a.initialize();a.edit(f.id,{text:'共有する初期版',addressedTo:''});await a.reload(f.id);await b.initialize();
    a.edit(f.id,{text:'Aが保存した新しい版',addressedTo:''});await a.reload(f.id);
    b.edit(f.id,{text:'Bでまだ保持する競合編集',addressedTo:''});await expect(b.send(f.id)).rejects.toThrow('DRAFT_CONFLICT');
    expect(store.rows.get(f.id)!.draft.text).toBe('Aが保存した新しい版');expect(b.draft(f.id).text).toBe('Bでまだ保持する競合編集');
    await b.reload(f.id);expect(b.draft(f.id).text).toBe('Aが保存した新しい版');expect(b.status(f.id).conflict).toBe(false);
    expect(f.service.snapshot(f.id).messages).toHaveLength(0);
  }finally{a.dispose();b.dispose();f.close();}
});

it('R7-DRAFT-008: logout erasure fences old tabs and separates main/reply/session records without persisting credentials',async()=>{
  const f=fixture(),store=new MemoryStore(),a=new DraftController(scope,store,api(f),()=>{}),b=new DraftController(scope,store,api(f),()=>{});
  try{
    await a.initialize();await b.initialize();const reply=f.id+'/reply/'+randomUUID(),other=randomUUID();
    a.edit(f.id,{text:'主画面',addressedTo:''});a.edit(reply,{text:'返信だけ',addressedTo:''});a.edit(other,{text:'別セッションだけ',addressedTo:''});await a.reload(f.id);
    expect(store.rows.size).toBe(3);expect(a.draft(reply).text).toBe('返信だけ');
    const serialized=JSON.stringify([...store.rows.values()]);expect(serialized).not.toContain(f.config.adminToken);expect(serialized).not.toContain('csrf');
    await a.clear();b.edit(f.id,{text:'古いタブから復活させない',addressedTo:''});await expect(b.send(f.id)).rejects.toThrow('DRAFT_SCOPE_REVOKED');
    expect(store.rows.size).toBe(0);const next=new DraftController(scope,store,api(f),()=>{});await next.initialize();expect(next.draft(f.id).text).toBe('');next.dispose();
  }finally{a.dispose();b.dispose();f.close();}
});

it('R7-DRAFT-009: storage failure preserves the local editor and prevents an unrecorded network submission',async()=>{
  const f=fixture(),store=new MemoryStore(),controller=new DraftController(scope,store,api(f),()=>{});
  try{
    await controller.initialize();store.failWrites=true;controller.edit(f.id,{text:'容量不足でもコピーできる本文',addressedTo:''});
    await expect(controller.send(f.id)).rejects.toThrow('DRAFT_STORAGE_FULL');expect(controller.draft(f.id).text).toBe('容量不足でもコピーできる本文');expect(f.service.snapshot(f.id).messages).toHaveLength(0);
    store.failWrites=false;controller.edit(f.id,{text:'復旧してから投稿する本文',addressedTo:''});await controller.send(f.id);
    expect(f.service.snapshot(f.id).messages).toHaveLength(1);expect(controller.draft(f.id).text).toBe('');
  }finally{controller.dispose();f.close();}
});

it('R7-DRAFT-010: a confirmed response arriving after another tab edits cannot clear that newer edit',async()=>{
  const f=fixture(),store=new MemoryStore();
  const transport=api(f,async()=>{
    const current=store.rows.get(f.id)!;await store.change(current,store.generation,row=>({...row,draft:{text:'応答待ちに別タブで保存した本文',addressedTo:''},editVersion:row.editVersion+1}));
  });
  const controller=new DraftController(scope,store,transport,()=>{});
  try{
    await controller.initialize();controller.edit(f.id,{text:'送信する元の本文',addressedTo:''});await controller.send(f.id);
    expect(controller.draft(f.id).text).toBe('応答待ちに別タブで保存した本文');expect(controller.status(f.id).outbox?.state).toBe('confirmed');
    expect(f.service.snapshot(f.id).messages.map(m=>m.text)).toEqual(['送信する元の本文']);
  }finally{controller.dispose();f.close();}
});

it('R7-DRAFT-011: persisted records reject extra credential fields and mismatched session/reply identities',()=>{
  const row=emptyRecord(scope,randomUUID());
  expect(()=>DraftRecordSchema.parse({...row,token:'not-a-credential-contract'})).toThrow();
  expect(()=>DraftRecordSchema.parse({...row,sessionId:randomUUID()})).toThrow();
  expect(()=>DraftRecordSchema.parse({...row,outbox:{key:randomUUID(),payload:{text:'x',replyTo:randomUUID(),addressedTo:[]},editVersion:0,state:'sending',messageId:null}})).toThrow();
});
