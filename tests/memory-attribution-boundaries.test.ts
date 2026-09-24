import {expect,it} from 'vitest';
import {fixture} from './helpers.js';
import type {ClaimedRun,MemoryChange,MemoryMeaning} from '../packages/contracts/index.js';

type Fixture=ReturnType<typeof fixture>;
const meaning=(patch:Partial<MemoryMeaning>={}):MemoryMeaning=>({subjectId:null,topic:'集まり',key:'meeting.day',value:'水曜日',epistemic:'self_report',validFrom:null,validTo:null,aliases:['集まり','日程'],...patch});
function next(f:Fixture,text:string){
  const source=f.say(text);f.say('集まりの日程を確認する');f.say('集まりの記憶を照合する');
  for(let i=0;i<12;i++){
    const run=f.claim();expect(run).not.toBeNull();
    if(run!.kind==='memory')return {run:run!,source};
    f.finish(run!,{decision:'ABSTAIN',reason:'synthetic observer'});
  }
  throw new Error('Memory was starved');
}
function save(f:Fixture,run:ClaimedRun,source:string,change:Partial<MemoryChange>={}){
  f.finish(run,{notes:[],changes:[{operation:'add',text:'集まりの日程',sourceMessageIds:[source],meaning:meaning(),targets:[],parents:[],...change}]});
  return f.service.workerMemories('worker-0',run.context.self.id).at(-1)!;
}

it('R5-MEANING-036: a non-overlapping date is not allowed to supersede a previously valid period',()=>{
  const f=fixture(3,{memoryEvery:3,contextTokens:131072});f.start();
  try{
    const first=next(f,'以前の集まりは水曜日'),old=save(f,first.run,first.source.id,{meaning:meaning({validFrom:0,validTo:1000000})});
    const later=next(f,'別の日付範囲の集まりは木曜日');
    expect(later.run.context.memories.some(m=>m.id===old.id)).toBe(true);
    const count=f.store.all('SELECT * FROM memory_changes').length;
    expect(()=>save(f,later.run,later.source.id,{operation:'correct',targets:[old.id],meaning:meaning({value:'木曜日',validFrom:2000000,validTo:3000000})})).toThrow('MEMORY_TARGET_TIME_MISMATCH');
    expect(f.service.workerMemories('worker-0',first.run.context.self.id)).toEqual([old]);
    expect(f.store.all('SELECT * FROM memory_changes')).toHaveLength(count);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',later.run.id)).toHaveLength(0);
  }finally{f.close();}
});

it('R5-MEANING-037: merging an inference into a self-report cannot relabel inherited evidence',()=>{
  const f=fixture(3,{memoryEvery:3,contextTokens:131072});f.start();
  try{
    const first=next(f,'集まりは水曜日らしい'),old=save(f,first.run,first.source.id,{meaning:meaning({epistemic:'inference'})});
    const later=next(f,'私の集まりは水曜日です');
    expect(later.run.context.memories.some(m=>m.id===old.id)).toBe(true);
    expect(()=>save(f,later.run,later.source.id,{operation:'merge',targets:[old.id],meaning:meaning()})).toThrow('MEMORY_MERGE_ATTRIBUTION_MISMATCH');
    expect(f.service.workerMemories('worker-0',first.run.context.self.id)).toEqual([old]);
    expect(f.store.all('SELECT * FROM agent_state_updates WHERE run_id=?',later.run.id)).toHaveLength(0);
  }finally{f.close();}
});

it('R5-MEANING-038: an interpretation derived from conflicting parents retains the unresolved status',()=>{
  const f=fixture(3,{memoryEvery:3,contextTokens:131072});f.start();
  try{
    const first=next(f,'本人の集まりは水曜日'),old=save(f,first.run,first.source.id);
    const conflict=next(f,'他者の推測では集まりは木曜日');
    const disputed=save(f,conflict.run,conflict.source.id,{operation:'conflict',targets:[old.id],meaning:meaning({value:'木曜日',epistemic:'inference'})});
    expect(disputed.provenance!.status).toBe('CONFLICT');
    const later=next(f,'集まりの準備を考える');
    expect(later.run.context.memories.some(m=>m.id===disputed.id)).toBe(true);
    const derived=save(f,later.run,later.source.id,{parents:[disputed.id],meaning:meaning({key:'meeting.preparation',value:'要確認',epistemic:'inference'})});
    expect(derived.provenance).toMatchObject({status:'CONFLICT',verified:false,independentSupport:null,parents:[disputed.id]});
    expect(derived.sourceMessageIds).toContain(conflict.source.id);
  }finally{f.close();}
});
