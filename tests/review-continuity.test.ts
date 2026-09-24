import { expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { fixture } from './helpers.js';
import { hash } from '../packages/domain/index.js';
import { characterOf,profileOf,type CandidateRow } from '../packages/storage-sqlite/index.js';

type Fixture=ReturnType<typeof fixture>;
const candidate=(f:Fixture,agentId:string)=>f.store.get<CandidateRow>("SELECT * FROM candidates WHERE agent_id=? AND state NOT IN ('DROPPED','COMMITTED')",agentId)!;

it('R4-REVIEW-001: the first chunk correction survives every later chunk as a reconstructed candidate, without resetting interest age',()=>{
  const f=fixture(3,{contextMessages:5,contextChars:12000,memoryEvery:1000});
  try {
    f.say('最初の予定は15時');f.start();f.speak(f.claim()!);const draft=f.claim()!;
    const correction=f.say('訂正：集合は16時です。');for(let i=0;i<45;i++)f.say('他の話題 '+i);
    f.finish(draft,{decision:'DRAFT',text:'集合は15時です。'});
    const owner=f.service.agents(f.id)[0],first=candidate(f,owner.id).first_interested_at;
    let rounds=0,sawCorrection=false,retainedWithoutOriginal=false;
    const seen=new Set<string>();
    for(;;){
      const review=f.claim()!;expect(review.kind).toBe('review');rounds++;
      for(const m of review.context.delta)seen.add(m.id);
      if(review.context.delta.some(m=>m.id===correction.id))sawCorrection=true;
      if(rounds>1){expect(review.context.candidate!.text).toContain('16時');if(!review.context.delta.some(m=>m.id===correction.id))retainedWithoutOriginal=true;}
      expect(sawCorrection).toBe(true);
      const complete=review.context.coverage!.complete;
      f.finish(review,complete?{decision:'KEEP'}:{decision:'REWRITE',text:'集合は16時です。',intent:review.context.candidate!.intent});
      expect(candidate(f,owner.id).first_interested_at).toBe(first);
      if(complete){expect(f.service.commitNext(f.id)?.text).toBe('集合は16時です。');break;}
      expect(f.service.commitNext(f.id)).toBeNull();expect(rounds).toBeLessThan(60);f.advance(1);
    }
    expect(rounds).toBeGreaterThan(1);expect(seen.has(correction.id)).toBe(true);expect(retainedWithoutOriginal).toBe(true);
    expect(f.service.session(f.id).bot_count).toBe(1);
  } finally { f.close(); }
});

it.each(['persona','model','membership'] as const)('R4-REVIEW-002: a ready candidate with changed %s cannot bypass re-review',field=>{
  const f=fixture();
  try {
    f.say('public input');f.start();f.speak(f.claim()!);f.finish(f.claim()!,{decision:'DRAFT',text:'候補'});
    const owner=f.service.agents(f.id)[0],before=candidate(f,owner.id);
    // Synthetic fault injection bypasses normal application mutation fencing on purpose.
    if(field==='persona')f.store.run('UPDATE agent_instances SET character_json=? WHERE id=?',JSON.stringify({...characterOf(owner),version:2,persona:'replacement synthetic persona'}),owner.id);
    else if(field==='model')f.store.run('UPDATE agent_instances SET profile_json=? WHERE id=?',JSON.stringify({...profileOf(owner),version:2,model:'replacement-mock'}),owner.id);
    else f.store.run('UPDATE agent_instances SET enabled=0 WHERE id=?',f.service.agents(f.id)[2].id);
    expect(f.service.commitNext(f.id)).toBeNull();expect(candidate(f,owner.id).state).toBe('NEEDS_REVIEW');
    const review=f.claim()!;expect(review.kind).toBe('review');expect(review.context.self.profileHash).toBe(hash(profileOf(f.service.agent(owner.id))));
    expect(review.context.self.character).toEqual(characterOf(f.service.agent(owner.id)));
    f.finish(review,{decision:'KEEP'});expect(candidate(f,owner.id).first_interested_at).toBe(before.first_interested_at);
    expect(f.service.commitNext(f.id)?.text).toBe('候補');expect(f.service.commitNext(f.id)).toBeNull();
  } finally { f.close(); }
});

it('R4-REVIEW-003: an active result captured before a model change is rejected atomically, then replaced without a Provider failure',()=>{
  const f=fixture();
  try {
    f.say('old model request');f.start();const old=f.claim()!,owner=f.service.agent(old.context.self.id);
    const call=f.service.reserveCall(owner.slot,old.workerEpoch,old.id,old.token,randomUUID(),'primary');
    f.service.finishCall(owner.slot,old.id,old.token,call.id,{inputTokens:1,outputTokens:1},null);
    f.store.run('UPDATE agent_instances SET profile_json=? WHERE id=?',JSON.stringify({...profileOf(owner),version:2,model:'new-mock'}),owner.id);
    expect(()=>f.service.completeRun(owner.slot,old.workerEpoch,old.id,old.token,{decision:'SPEAK',intent:{act:'comment',intent:'obsolete model intent',replyTo:null,addressedTo:[]}})).toThrow('STALE_AGENT_IDENTITY');
    expect(f.store.all('SELECT * FROM candidates')).toHaveLength(0);expect(f.store.all('SELECT * FROM agent_input_receipts')).toHaveLength(0);
    const next=f.claim()!;expect(next.id).not.toBe(old.id);expect(next.profile.model).toBe('new-mock');
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',old.id)!.state).toBe('CANCELLED');
    expect(f.service.agent(owner.id).error_count).toBe(0);f.finish(next,{decision:'ABSTAIN',reason:'new model chooses silence'});
  } finally { f.close(); }
});

it('R4-REVIEW-004: five-times-slower generation and repeated interrupts preserve age until a valid opportunity; report waits, reviews and discards',()=>{
  const f=fixture(3,{agingMs:200,memoryEvery:1000});
  try {
    f.say('同時に考える題材');f.start();const agents=f.service.agents(f.id),slots=agents.map(a=>a.slot);
    const decisions=slots.map(s=>f.claim(s)!);decisions.forEach(f.speak);
    const drafts=slots.map(s=>f.claim(s)!);const slowId=candidate(f,agents[2].id).id,interested=candidate(f,agents[2].id).first_interested_at;
    f.advance(100);f.finish(drafts[0],{decision:'DRAFT',text:'速い参加者の最初の発言'});expect(f.service.commitNext(f.id)?.authorId).toBe(agents[0].id);
    f.say('新しい割込み');f.advance(1);f.speak(f.claim(slots[0])!);const newFast=f.claim(slots[0])!;
    f.finish(drafts[1],{decision:'DRAFT',text:'二人目の候補'});
    f.advance(399);f.finish(drafts[2],{decision:'DRAFT',text:'5倍遅い参加者の候補'});
    const reviews=[f.claim(slots[1])!,f.claim(slots[2])!];
    f.finish(newFast,{decision:'DRAFT',text:'速い参加者の新しい候補'});
    for(const [i,run] of reviews.entries())f.finish(run,{decision:'REWRITE',text:i?'5倍遅い参加者の更新候補':'二人目の更新候補',intent:run.context.candidate!.intent});
    const firstOld=f.service.commitNext(f.id)!;expect(firstOld.authorId).not.toBe(agents[0].id);
    let slowPosted=firstOld.authorId===agents[2].id;
    if(!slowPosted){
      for(let i=0;i<3;i++){
        const run=f.claim(slots[2])!;expect(run.kind).toBe('review');f.say('連続する人間の割込み '+i);
        f.finish(run,{decision:'REWRITE',text:'割込みも踏まえた遅い候補 '+i,intent:run.context.candidate!.intent});
        expect(candidate(f,agents[2].id).id).toBe(slowId);expect(candidate(f,agents[2].id).first_interested_at).toBe(interested);
        expect(f.service.commitNext(f.id)).toBeNull();f.advance(100);
      }
      const final=f.claim(slots[2])!;f.finish(final,{decision:'REWRITE',text:'追従完了した遅い候補',intent:final.context.candidate!.intent});
      expect(f.service.commitNext(f.id)?.authorId).toBe(agents[2].id);slowPosted=true;
    }
    expect(slowPosted).toBe(true);
    const completed=f.store.get<CandidateRow>('SELECT * FROM candidates WHERE id=?',slowId)!;
    expect(completed.first_interested_at).toBe(interested);expect(completed.state).toBe('COMMITTED');
    const report={mode:'synthetic-injected-clock',fastGenerationMs:100,slowGenerationMs:500,
      slowWaitMs:f.now()-interested,slowReviews:f.store.get<{n:number}>("SELECT COUNT(*) n FROM traces WHERE agent_id=? AND code LIKE 'REVIEW_%'",agents[2].id)!.n,
      slowDiscards:f.store.get<{n:number}>("SELECT COUNT(*) n FROM candidates WHERE agent_id=? AND state='DROPPED'",agents[2].id)!.n,
      posts:f.store.all('SELECT author_id,COUNT(*) n FROM messages WHERE author_id IS NOT NULL GROUP BY author_id')};
    expect(report.slowWaitMs).toBeGreaterThanOrEqual(500);expect(report.slowReviews).toBeGreaterThan(0);expect(report.slowDiscards).toBe(0);
    mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/review-fairness.json',JSON.stringify(report,null,2));
  } finally { f.close(); }
});
