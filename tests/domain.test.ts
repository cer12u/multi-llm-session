import { describe,expect,it } from 'vitest';
import { canonical,hash,coalesceDue,selectCandidate,seededRandom,type Eligible } from '../packages/domain/index.js';
import { CharacterSchema,DecisionSchema,SessionCreateSchema,SettingsSchema } from '../packages/contracts/index.js';

describe('contracts and deterministic scheduling',()=>{
  it('hashes object keys canonically, without changing array order',()=>{
    expect(hash({b:2,a:1})).toBe(hash({a:1,b:2}));expect(canonical([2,1])).not.toBe(canonical([1,2]));
  });
  it('rejects an agent trying to select a different sender',()=>{
    expect(()=>DecisionSchema.parse({decision:'ABSTAIN',reason:'聞いている',agentId:'another'})).toThrow();
    expect(()=>DecisionSchema.parse({decision:'SPEAK',text:'a whole script'})).toThrow();
  });
  it('validates versioned character contracts and independent participation',()=>{
    expect(()=>CharacterSchema.parse({schemaVersion:1,id:'a',version:0,name:'a',persona:'x'})).toThrow();
    expect(()=>SessionCreateSchema.parse({title:'x',participants:[]})).toThrow();
    expect(()=>SettingsSchema.parse({selfWakeMinMs:2000,selfWakeMaxMs:1000})).toThrow();
  });
  it('coalesces within a bounded delay rather than starving on continuous traffic',()=>{
    let state=coalesceDue(null,null,0,800,2000);
    for(let now=100;now<10000;now+=100)state=coalesceDue(state.since,state.due,now,800,2000);
    expect(state.due).toBeLessThanOrEqual(2000);
  });
  it('gives an aged valid intention priority without equalizing speech counts',()=>{
    const base={state:'READY',reviewedRevision:5,reviewedWake:1,currentWake:1,notBefore:0};
    const candidates:Eligible[]=[{...base,id:'old',agentId:'a',firstInterestedAt:0,directed:false},{...base,id:'reply',agentId:'b',firstInterestedAt:49000,directed:true}];
    expect(selectCandidate(candidates,5,50000,30000,['b'],60000)?.id).toBe('old');
  });
  it('checks 10,000 seeded arbitration schedules (3, 5 and 8 agents)',()=>{
    const rng=seededRandom(20260920);
    for(let trial=0;trial<10000;trial++){
      const count=[3,5,8][trial%3],revision=Math.floor(rng()*100),now=Math.floor(rng()*100000);
      const candidates:Eligible[]=Array.from({length:count},(_,i)=>({id:String(i),agentId:'agent-'+i,state:rng()<.8?'READY':'NEEDS_REVIEW',
        reviewedRevision:rng()<.7?revision:revision-1,reviewedWake:1,currentWake:rng()<.8?1:2,notBefore:now+(rng()<.7?-10:100),firstInterestedAt:now-Math.floor(rng()*60000),directed:rng()<.2}));
      const selected=selectCandidate(candidates,revision,now,30000);
      const valid=candidates.filter(c=>c.state==='READY'&&c.reviewedRevision===revision&&c.reviewedWake===c.currentWake&&c.notBefore<=now);
      expect(!!selected,`seed=20260920 case=${trial}`).toBe(valid.length>0);
      if(selected){expect(valid.map(v=>v.id)).toContain(selected.id);expect(selectCandidate(candidates,revision,now,30000)).toEqual(selected);}
    }
  });
});
