import { randomUUID } from 'node:crypto';
import { ensure, type Context, type MemoryNote } from '../contracts/index.js';
import { MemoryChangeSchema, type MemoryChange, type MemoryMeaning, type MemoryProvenance, type MemoryStatus } from '../contracts/memory.js';
import type { Store, RunRow, MessageRow } from '../storage-sqlite/index.js';

type Ref={kind:'message';id:string;version:number};
type Row={id:string;agent_id:string;text:string;sources_json:string;created_at:number;sequence:number};
type Meta={memory_id:string;status:MemoryStatus;meaning_json:string|null;evidence_json:string|null;reason:string|null};
export const normalizeMemory=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\p{P}\p{Z}\s]+/gu,' ').trim();
const sameMeaning=(a:MemoryMeaning,b:MemoryMeaning)=>a.subjectId===b.subjectId&&normalizeMemory(a.key)===normalizeMemory(b.key);
const overlaps=(a:MemoryMeaning,b:MemoryMeaning)=>(a.validFrom??0)<(b.validTo??Infinity)&&(b.validFrom??0)<(a.validTo??Infinity);

/** Shared by automatic recall, LOOKUP and private paging. History stays in the base tables. */
export function currentMemoryPredicate(alias='m'):string {
  if(!/^[a-z]+$/.test(alias))throw new Error('INVALID_SQL_ALIAS');
  return `NOT EXISTS (SELECT 1 FROM memory_metadata mm WHERE mm.memory_id=${alias}.id AND mm.status IN ('SUPERSEDED','INVALID'))
    AND NOT EXISTS (SELECT 1 FROM json_each(${alias}.sources_json) src WHERE NOT EXISTS
      (SELECT 1 FROM messages msg JOIN agent_instances owner ON owner.id=${alias}.agent_id
       WHERE msg.id=src.value AND msg.session_id=owner.session_id AND msg.deleted=0))
    AND NOT EXISTS (SELECT 1 FROM memory_metadata mm,json_each(mm.evidence_json) ev
      WHERE mm.memory_id=${alias}.id AND NOT EXISTS
      (SELECT 1 FROM messages msg WHERE msg.id=json_extract(ev.value,'$.id') AND msg.deleted=0
        AND msg.revision=json_extract(ev.value,'$.version')))
    AND NOT EXISTS (SELECT 1 FROM memory_input_origins mo,json_each(mo.evidence_json) ev
      WHERE mo.memory_id=${alias}.id AND NOT EXISTS
      (SELECT 1 FROM messages msg WHERE msg.id=json_extract(ev.value,'$.id') AND msg.deleted=0
        AND msg.revision=json_extract(ev.value,'$.version')))`;
}
export function memoryNote(store:Store,row:Row):MemoryNote {
  const meta=store.get<Meta>('SELECT * FROM memory_metadata WHERE memory_id=?',row.id);
  const origin=meta?.evidence_json??store.get<{evidence_json:string}>('SELECT evidence_json FROM memory_input_origins WHERE memory_id=?',row.id)?.evidence_json;
  const provenance:MemoryProvenance={status:meta?.status??'ACTIVE',meaning:meta?.meaning_json?JSON.parse(meta.meaning_json):null,
    verified:false,evidence:origin?JSON.parse(origin):null,
    parents:store.all<{parent_id:string}>('SELECT parent_id FROM memory_edges WHERE child_id=? ORDER BY parent_id',row.id).map(x=>x.parent_id),
    independentSupport:null};
  return {id:row.id,text:row.text,sourceMessageIds:JSON.parse(row.sources_json),provenance};
}

/** Called only by SessionService's existing result/edit transaction; no new write endpoint. */
export class MemoryLedger {
  constructor(private readonly store:Store,private readonly now:()=>number){}
  private transaction(){ensure(this.store.db.inTransaction,500,'MEMORY_TRANSACTION_REQUIRED');}
  private journal(owner:string,run:string|null,kind:string,oldIds:string[],newId:string|null){
    this.store.run('INSERT INTO memory_changes(agent_id,run_id,kind,old_ids_json,new_id,created_at) VALUES(?,?,?,?,?,?)',owner,run,kind,JSON.stringify(oldIds),newId,this.now());
  }
  private status(id:string,state:MemoryStatus,reason:string){
    this.store.run(`INSERT INTO memory_metadata(memory_id,status,reason) VALUES(?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET status=excluded.status,reason=excluded.reason`,id,state,reason);
  }
  private row(id:string,owner:string):Row{
    const row=this.store.get<Row>('SELECT * FROM memories WHERE id=? AND agent_id=?',id,owner);
    ensure(row,422,'MEMORY_OWNER_MISMATCH');return row;
  }
  private current(id:string,owner:string){ensure(this.store.get(`SELECT m.id FROM memories m WHERE m.id=? AND m.agent_id=? AND ${currentMemoryPredicate()}`,id,owner),422,'MEMORY_NOT_CURRENT');}
  private evidence(run:RunRow,ids:string[]):Ref[]{
    const context=JSON.parse(run.context_json) as Context;
    ensure(new Set(ids).size===ids.length,422,'DUPLICATE_MEMORY_SOURCE');
    return ids.map(id=>{
      const supplied=context.messages.find(m=>m.id===id&&!m.deleted);
      const current=this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND session_id=?',id,run.session_id);
      ensure(supplied&&current&&!current.deleted&&current.revision===supplied.revision,422,'INVALID_MEMORY_SOURCE');
      return {kind:'message',id,version:current.revision};
    });
  }
  private observed(run:RunRow,ids:string[]):Row[]{
    const context=JSON.parse(run.context_json) as Context;
    const supplied=new Set([...context.memories,...(context.retrieved??[]).flatMap(r=>r.memories)].map(m=>m.id));
    ensure(new Set(ids).size===ids.length,422,'DUPLICATE_MEMORY_TARGET');
    return ids.map(id=>{ensure(supplied.has(id),422,'UNOBSERVED_MEMORY_TARGET');this.current(id,run.agent_id);return this.row(id,run.agent_id);});
  }
  private insert(run:RunRow,text:string,evidence:Ref[],meaning:MemoryMeaning|null,parents:string[],state:MemoryStatus):string{
    const refs=[...new Map(evidence.map(e=>[e.id+':'+e.version,e])).values()];
    ensure(refs.length<=64,422,'MEMORY_EVIDENCE_CAPACITY');
    this.store.run('UPDATE agent_instances SET memory_seq=memory_seq+1 WHERE id=?',run.agent_id);
    const sequence=this.store.get<{memory_seq:number}>('SELECT memory_seq FROM agent_instances WHERE id=?',run.agent_id)!.memory_seq,id=randomUUID();
    this.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',id,run.agent_id,text,JSON.stringify([...new Set(refs.map(r=>r.id))].sort()),this.now(),sequence);
    this.store.run('INSERT INTO memory_metadata(memory_id,status,meaning_json,evidence_json) VALUES(?,?,?,?)',id,state,meaning?JSON.stringify(meaning):null,JSON.stringify(refs));
    this.store.run('INSERT INTO memory_input_origins(memory_id,run_id,evidence_json) VALUES(?,?,?)',id,run.id,JSON.stringify(refs));
    for(const parent of new Set(parents))this.store.run('INSERT INTO memory_edges(parent_id,child_id) VALUES(?,?)',parent,id);
    return id;
  }
  save(run:RunRow,result:{notes:{text:string;sourceMessageIds:string[]}[];changes?:MemoryChange[]}):string[]{
    this.transaction();const invalidated:string[]=[];
    for(const note of result.notes){
      const refs=this.evidence(run,note.sourceMessageIds),sources=JSON.stringify([...new Set(note.sourceMessageIds)].sort());
      const duplicate=this.store.get(`SELECT m.id FROM memories m WHERE m.agent_id=? AND m.text=? AND m.sources_json=? AND ${currentMemoryPredicate()}`,run.agent_id,note.text,sources);
      if(!duplicate){const id=this.insert(run,note.text,refs,null,[],'ACTIVE');this.journal(run.agent_id,run.id,'LEGACY_NOTE',[],id);}
    }
    for(const raw of result.changes??[]){
      const change=MemoryChangeSchema.parse(raw),meaning=change.meaning,refs=this.evidence(run,change.sourceMessageIds);
      if(meaning.subjectId!==null)ensure(this.store.get('SELECT id FROM agent_instances WHERE id=? AND session_id=?',meaning.subjectId,run.session_id),422,'INVALID_MEMORY_SUBJECT');
      if(meaning.epistemic==='self_report')for(const ref of refs){
        const source=this.store.get<{author_id:string|null}>('SELECT author_id FROM messages WHERE id=?',ref.id)!;
        ensure(source.author_id===meaning.subjectId,422,'MEMORY_NOT_SUBJECT_REPORT');
      }
      const explicit=this.observed(run,change.targets),parents=this.observed(run,change.parents);
      for(const target of explicit){const meta=memoryNote(this.store,target).provenance?.meaning;ensure(meta&&sameMeaning(meta,meaning),422,'MEMORY_TARGET_MEANING_MISMATCH');}
      const active=this.store.all<Row>(`SELECT m.* FROM memories m WHERE m.agent_id=? AND ${currentMemoryPredicate()}`,run.agent_id);
      const matching=active.filter(row=>{const old=memoryNote(this.store,row).provenance?.meaning;return !!old&&sameMeaning(old,meaning)&&overlaps(old,meaning);});
      const equivalent=matching.filter(row=>{const old=memoryNote(this.store,row).provenance!.meaning!;return normalizeMemory(old.value)===normalizeMemory(meaning.value)&&old.epistemic===meaning.epistemic&&old.validFrom===meaning.validFrom&&old.validTo===meaning.validTo;});
      // An unseen equivalent is not silently rewritten. The next memory request recalls it for explicit reconciliation.
      const visible=new Set((JSON.parse(run.context_json) as Context).memories.map(m=>m.id));
      ensure(equivalent.every(row=>visible.has(row.id)||explicit.some(x=>x.id===row.id)),422,'UNOBSERVED_MEMORY_DUPLICATE');
      const replace=[...new Map([...explicit,...equivalent].map(row=>[row.id,row])).values()];
      if(change.operation==='merge')ensure(replace.every(row=>normalizeMemory(memoryNote(this.store,row).provenance!.meaning!.value)===normalizeMemory(meaning.value)),422,'MEMORY_MERGE_VALUE_MISMATCH');
      const correction=change.operation==='correct'&&meaning.epistemic==='self_report'&&replace.every(row=>change.sourceMessageIds.some(id=>!JSON.parse(row.sources_json).includes(id)));
      const conflicts=matching.filter(row=>!equivalent.some(x=>x.id===row.id)&&!(correction&&explicit.some(x=>x.id===row.id)));
      const state:MemoryStatus=change.operation==='conflict'||(change.operation==='correct'&&!correction)||conflicts.length>0?'CONFLICT':'ACTIVE';
      const merge=change.operation==='merge'||equivalent.length>0;
      const sourceParents=merge?[...parents,...equivalent,...(change.operation==='merge'?explicit:[])]:parents;
      for(const parent of sourceParents){
        const inherited=memoryNote(this.store,parent).provenance?.evidence;
        // Do not fabricate historic versions for pre-versioned notes.
        ensure(inherited,422,'MEMORY_PARENT_VERSION_UNKNOWN');refs.push(...inherited);
      }
      const id=this.insert(run,change.text,refs,meaning,sourceParents.map(p=>p.id),state);
      const superseded=replace.filter(row=>equivalent.some(x=>x.id===row.id)||change.operation==='merge'||(correction&&explicit.some(x=>x.id===row.id)));
      for(const row of superseded){this.status(row.id,'SUPERSEDED','RECONCILED');invalidated.push(row.id);}
      for(const row of [...conflicts,...(!correction&&change.operation==='correct'?explicit:[])])this.status(row.id,'CONFLICT','CONFLICTING_INTERPRETATION');
      this.journal(run.agent_id,run.id,change.operation.toUpperCase(),replace.map(row=>row.id),id);
    }
    return invalidated;
  }
  invalidateMessage(session:string,messageId:string):string[]{
    this.transaction();
    const rows=this.store.all<Row>(`WITH RECURSIVE affected(id) AS (
      SELECT m.id FROM memories m JOIN agent_instances a ON a.id=m.agent_id
      WHERE a.session_id=? AND EXISTS(SELECT 1 FROM json_each(m.sources_json) WHERE value=?)
      UNION SELECT e.child_id FROM memory_edges e JOIN affected p ON p.id=e.parent_id)
      SELECT m.* FROM memories m JOIN affected x ON x.id=m.id`,session,messageId);
    for(const row of rows){this.status(row.id,'INVALID','SOURCE_CHANGED');this.journal(row.agent_id,null,'SOURCE_INVALIDATED',[row.id],null);}
    return rows.map(row=>row.id);
  }
}
