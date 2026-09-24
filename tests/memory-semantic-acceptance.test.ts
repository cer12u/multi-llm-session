import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './helpers.js';
import {Store} from '../packages/storage-sqlite/index.js';
import {SessionService} from '../packages/session-service/index.js';
import type {ClaimedRun,MemoryChange,MemoryMeaning} from '../packages/contracts/index.js';

type Fixture=ReturnType<typeof fixture>;
const meaning=(patch:Partial<MemoryMeaning>={}):MemoryMeaning=>({subjectId:null,topic:'集まりの日程',key:'meeting.day',value:'水曜日',epistemic:'self_report',validFrom:null,validTo:null,aliases:['集まり','日程','予定'],...patch});
function memory(f:Fixture,text:string){
  const source=f.say(text);f.say('集まりの日程と予定を確認する');f.say('集まりについて記憶を照合する');
  for(let step=0;step<12;step++){
    const run=f.claim();expect(run,'an eligible memory input must not disappear').not.toBeNull();
    if(run!.kind==='memory')return {run:run!,source};
    f.finish(run!,run!.kind==='draft'||run!.kind==='review'?{decision:'DROP',reason:'synthetic silent participant'}:{decision:'ABSTAIN',reason:'synthetic observer'});
  }
  throw new Error('Memory processing was starved');
}
function save(f:Fixture,run:ClaimedRun,sourceId:string,patch:Partial<MemoryChange>={}){
  const change:MemoryChange={operation:'add',text:'集まりの日程は水曜日',sourceMessageIds:[sourceId],meaning:meaning(),targets:[],parents:[],...patch};
  f.finish(run,{notes:[],changes:[change]});
  return f.service.workerMemories('worker-0',run.context.self.id).findLast(note=>note.text===change.text)!;
}
function setup(path=':memory:'){const f=fixture(3,{memoryEvery:3,contextTokens:131072},path);f.start();return f;}

it('R5-MEANING-030: a subject correction preserves past interpretation and advances only the owning Agent current value',()=>{
  const f=setup();
  try{
    const first=memory(f,'本人の集まりの日程は水曜日'),old=save(f,first.run,first.source.id);
    expect(old.provenance).toMatchObject({status:'ACTIVE',verified:false,independentSupport:null,meaning:{subjectId:null,epistemic:'self_report',value:'水曜日'}});
    const next=memory(f,'本人による訂正：集まりの日程は木曜日');
    expect(next.run.context.memories.some(note=>note.id===old.id)).toBe(true);
    const updated=save(f,next.run,next.source.id,{operation:'correct',text:'集まりの日程は木曜日に訂正',meaning:meaning({value:'木曜日'}),targets:[old.id]});
    expect(updated.provenance?.status).toBe('ACTIVE');
    expect(f.store.get<{status:string}>('SELECT status FROM memory_metadata WHERE memory_id=?',old.id)!.status).toBe('SUPERSEDED');
    expect(f.store.get<{text:string}>('SELECT text FROM memories WHERE id=?',old.id)!.text).toBe('集まりの日程は水曜日');
    expect(f.service.workerMemories('worker-0',next.run.context.self.id).map(note=>note.id)).toEqual([updated.id]);
    expect(f.service.pages.memories(next.run.context.self.id,'水曜日').items).toHaveLength(0);
    for(const other of f.service.agents(f.id).slice(1))expect(f.service.workerMemories(other.slot,other.id)).toEqual([]);
    expect(f.store.all("SELECT * FROM memory_changes WHERE agent_id=? AND kind='CORRECT'",next.run.context.self.id)).toHaveLength(1);
  }finally{f.close();}
});

it('R5-MEANING-031: inferred and repeated claims remain unresolved alternatives, never independent confirmation',()=>{
  const f=setup();
  try{
    const first=memory(f,'本人は集まりを水曜日と説明した'),old=save(f,first.run,first.source.id);
    const next=memory(f,'他者は集まりが木曜日かもしれないと推測している');
    const inferred=save(f,next.run,next.source.id,{operation:'conflict',text:'集まりは木曜日という他者の推測',meaning:meaning({value:'木曜日',epistemic:'inference'}),targets:[old.id]});
    expect(inferred.provenance?.status).toBe('CONFLICT');
    const third=memory(f,'別の人も木曜日という伝聞を繰り返している');
    save(f,third.run,third.source.id,{text:'集まりは木曜日という伝聞の繰返し',meaning:meaning({value:'木曜日',epistemic:'hearsay'})});
    const notes=f.service.workerMemories('worker-0',first.run.context.self.id);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.every(note=>note.provenance?.status==='CONFLICT'&&note.provenance.verified===false&&note.provenance.independentSupport===null)).toBe(true);
    expect(notes.some(note=>note.provenance?.meaning?.epistemic==='self_report')).toBe(true);
    expect(notes.some(note=>note.provenance?.meaning?.epistemic==='hearsay')).toBe(true);
  }finally{f.close();}
});

it('R5-MEANING-032: canonical paraphrase reconciliation bounds current duplicates while retaining every original/history row',()=>{
  const f=setup(),originals:string[]=[];
  try{
    const owner=f.service.agents(f.id)[0].id;
    for(let i=0;i<5;i++){
      const batch=memory(f,'集まりの日程を別の言い方で再確認：水曜日 '+i);originals.push(batch.source.id);
      save(f,batch.run,batch.source.id,{text:'言い換えた集まりの予定 '+i});
      expect(f.service.workerMemories('worker-0',owner)).toHaveLength(1);
    }
    const selected=f.service.workerMemories('worker-0',owner)[0];
    expect(selected.sourceMessageIds.sort()).toEqual(originals.sort());expect(selected.provenance?.independentSupport).toBeNull();
    expect(f.store.all('SELECT id FROM memories WHERE agent_id=?',owner)).toHaveLength(5);
    expect(f.store.all('SELECT * FROM memory_changes WHERE agent_id=?',owner)).toHaveLength(5);
    for(const id of originals)expect(f.service.archiveMessage(f.id,id).deleted).toBe(false);
  }finally{f.close();}
});

it('R5-MEANING-033: non-overlapping validity intervals are retained as different times, not a contradiction or blind replacement',()=>{
  const f=setup();
  try{
    const first=memory(f,'以前の集まりの日程は水曜日');save(f,first.run,first.source.id,{meaning:meaning({validFrom:0,validTo:2000000})});
    const next=memory(f,'その後の集まりの日程は木曜日');save(f,next.run,next.source.id,{text:'別の時点では木曜日',meaning:meaning({value:'木曜日',validFrom:2000000,validTo:3000000})});
    const notes=f.service.workerMemories('worker-0',next.run.context.self.id);
    expect(notes).toHaveLength(2);expect(notes.every(note=>note.provenance?.status==='ACTIVE')).toBe(true);
    expect(notes.map(note=>note.provenance?.meaning?.validFrom)).toEqual([0,2000000]);
  }finally{f.close();}
});

it.each(['nonexistent','foreign-session','unobserved','wrong-subject'] as const)('R5-MEANING-034: %s evidence/attribution is rejected atomically with no memory receipt',kind=>{
  const f=setup();
  try{
    const batch=memory(f,'本人の集まりの日程は水曜日'),owner=batch.run.context.self.id;
    let sourceId=batch.source.id,m=meaning();
    if(kind==='nonexistent')sourceId=randomUUID();
    if(kind==='foreign-session'){const other=f.service.createSession(f.input,randomUUID()).id;sourceId=f.service.humanMessage(other,{text:'別の部屋の集まりの日程'},randomUUID()).id;}
    if(kind==='unobserved')sourceId=f.say('このrunには渡されていない後の集まりの日程').id;
    if(kind==='wrong-subject')m=meaning({subjectId:f.service.agents(f.id)[1].id});
    expect(()=>save(f,batch.run,sourceId,{meaning:m})).toThrow();
    expect(f.store.all('SELECT * FROM memories WHERE agent_id=?',owner)).toHaveLength(0);
    expect(f.store.all('SELECT * FROM memory_changes WHERE agent_id=?',owner)).toHaveLength(0);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',batch.run.id)).toHaveLength(0);
    expect(f.store.get<{memory_input:number}>('SELECT memory_input FROM agent_input_cursors WHERE agent_id=?',owner)!.memory_input).toBe(0);
  }finally{f.close();}
});

it.each(['edit','delete'] as const)('R5-MEANING-035: %s invalidates parent/derived memory and derived working state across database reopen',kind=>{
  const dir=mkdtempSync(join(tmpdir(),'memory-transitive-')),path=join(dir,'state.sqlite'),f=setup(path);let reopened:Store|undefined;
  try{
    const first=memory(f,'本人の集まりの日程は水曜日'),parent=save(f,first.run,first.source.id);
    const next=memory(f,'集まりの予定から準備を考える');expect(next.run.context.memories.some(note=>note.id===parent.id)).toBe(true);
    const child=save(f,next.run,next.source.id,{text:'集まりの予定から派生した準備の要約',meaning:meaning({key:'meeting.preparation',value:'移動を検討',epistemic:'inference'}),parents:[parent.id]});
    expect(child.provenance?.parents).toContain(parent.id);
    f.say('集まりの準備の要約を使って検討する');const run=f.claim()!;
    expect(run.context.memories.some(note=>note.id===child.id)).toBe(true);
    const state=run.context.self.privateState!;
    f.finish(run,{action:{decision:'ABSTAIN',reason:'hold own interpretation'},statePatch:{agentId:state.agentId,sessionId:f.id,expectedVersion:state.version,observationId:run.context.observation!.id,
      upsert:[{id:'derived-working',kind:'understanding',text:'派生した要約に依存する本人の理解',evidence:[],derivedFrom:[child.id],resume:null}],remove:[]}});
    f.service.changeMessage(f.id,first.source.id,kind==='delete'?null:'元の日程説明を訂正した',randomUUID());
    const owner=run.context.self.id;
    for(const id of [parent.id,child.id])expect(f.store.get<{status:string}>('SELECT status FROM memory_metadata WHERE memory_id=?',id)!.status).toBe('INVALID');
    expect(f.service.workerMemories('worker-0',owner)).toEqual([]);
    expect(JSON.parse(f.store.get<{entries_json:string}>('SELECT entries_json FROM agent_private_states WHERE agent_id=?',owner)!.entries_json)).toEqual([]);
    f.close();reopened=new Store(path);const service=new SessionService(reopened,f.config,f.now);service.recover();
    expect(service.workerMemories('worker-0',owner)).toEqual([]);expect(service.pages.memories(owner,'集まり').items).toEqual([]);
    expect(reopened.all('SELECT id FROM memories WHERE agent_id=?',owner)).toHaveLength(2);
    expect(reopened.all("SELECT * FROM agent_state_updates WHERE agent_id=? AND kind='MEMORY_INVALIDATED'",owner)).toHaveLength(1);
    expect(JSON.stringify(service.snapshot(f.id))).not.toContain('派生した要約に依存する本人の理解');
  }finally{reopened?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});
