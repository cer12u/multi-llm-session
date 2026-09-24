import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DraftController } from '../apps/web/src/draft-controller.js';
import { emptyRecord, type DraftMutation, type DraftRecord, type DraftStore } from '../apps/web/src/draft-store.js';

class ControlledStore implements DraftStore {
  rows=new Map<string,DraftRecord>();generation=0;
  gate:Promise<void>|null=null;onSubmission=()=>{};
  async load(){return {generation:this.generation,records:structuredClone([...this.rows.values()])};}
  async change(base:DraftRecord,generation:number,edit:DraftMutation){
    if(generation!==this.generation)throw new Error('DRAFT_SCOPE_REVOKED');
    const current=this.rows.get(base.key)??emptyRecord(base.scope,base.key);
    if(current.version!==base.version)throw new Error('DRAFT_CONFLICT');
    const result={...edit(structuredClone(current)),version:current.version+1};
    this.rows.set(base.key,result);
    if(result.outbox?.state==='sending'&&this.gate){this.onSubmission();await this.gate;}
    return structuredClone(result);
  }
  async clear(){this.rows.clear();this.generation++;}
  close(){}
}

it.each(['dispose','clear'] as const)('R7-DRAFT-012: %s during outbox persistence prevents a later network submission',async action=>{
  const store=new ControlledStore(),session=randomUUID();let calls=0,release!:()=>void,started!:()=>void;
  const controller=new DraftController('a'.repeat(64),store,async<T>()=>{calls++;return {id:randomUUID()} as T;},()=>{});
  await controller.initialize();controller.edit(session,{text:'保存後に画面が閉じられる投稿',addressedTo:''});await controller.reload(session);
  const reached=new Promise<void>(resolve=>{started=resolve;});store.onSubmission=started;store.gate=new Promise<void>(resolve=>{release=resolve;});
  const sending=controller.send(session);const rejected=expect(sending).rejects.toThrow('DRAFT_STORAGE_UNAVAILABLE');await reached;
  if(action==='dispose')controller.dispose();else await controller.clear();
  release();await rejected;expect(calls).toBe(0);
  if(action==='clear')expect(store.rows.size).toBe(0);
  else expect(store.rows.get(session)?.outbox?.payload.text).toBe('保存後に画面が閉じられる投稿');
  expect(()=>controller.edit(session,{text:'閉じた画面から書き戻さない',addressedTo:''})).toThrow('DRAFT_STORAGE_UNAVAILABLE');
});
