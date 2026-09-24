import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { SettingsSchema, type ClaimedRun, type PublicMessage } from '../packages/contracts/index.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function setup(...args:Parameters<typeof fixture>){const f=fixture(...args);cleanup.push(()=>{try{f.close();}catch{}});return f;}
function run(r:ClaimedRun|null):ClaimedRun {expect(r).not.toBeNull();return r!;}

describe('backend boundaries: corrected invariants, not live model acceptance',()=>{
  it('pages 1205 durable messages exactly once after edits, appends, SQLite reopen and VACUUM',()=>{
    const dir=mkdtempSync(join(tmpdir(),'history-page-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
    const f=setup(3,{},join(dir,'db.sqlite'));
    const all=Array.from({length:1205},(_,i)=>f.say(`検索共通語 ${i}`));
    const first=f.service.pages.history(f.id,{limit:73});
    f.service.changeMessage(f.id,all[0].id,'編集済み 検索共通語',randomUUID());
    f.service.changeMessage(f.id,all[40].id,null,randomUUID());
    f.say('ページ開始後の新着');
    const got=[...first.items];let cursor=first.nextCursor;
    while(cursor){const next=f.service.pages.history(f.id,{limit:73,cursor});got.push(...next.items);cursor=next.nextCursor;}
    expect(got).toHaveLength(1205);expect(new Set(got.map(x=>x.id)).size).toBe(1205);
    expect(got.find(x=>x.id===all[0].id)?.text).toBe('編集済み 検索共通語');
    expect(got.find(x=>x.id===all[40].id)?.deleted).toBe(true);
    const sequences=all.map(x=>x.sequence);f.store.db.exec('VACUUM');f.close();
    const reopened=new Store(f.config.dbPath);cleanup.push(()=>reopened.close());
    const service=new SessionService(reopened,f.config,f.now);service.recover();
    const exported=service.exportSession(f.id).transcript as PublicMessage[];
    expect(exported).toHaveLength(1206);expect(exported.slice(0,1205).map(x=>x.sequence)).toEqual(sequences);
    expect(service.archiveMessage(f.id,all[0].id).text).toContain('編集済み');
  });
  it('search pages continue past 50 matches and ignore post-fence inserts; edits demand explicit resync',()=>{
    const f=setup();const messages=Array.from({length:270},(_,i)=>f.say(`特殊検索語 ${i}`));
    const first=f.service.pages.search(f.id,'特殊検索語',{limit:31});const items=[...first.items];let cursor=first.nextCursor;
    f.say('特殊検索語 ページ開始後');
    while(cursor){const page=f.service.pages.search(f.id,'特殊検索語',{cursor,limit:31});items.push(...page.items);cursor=page.nextCursor;}
    expect(new Set(items.map(m=>m.id))).toEqual(new Set(messages.map(m=>m.id)));
    f.service.changeMessage(f.id,messages[0].id,'検索対象が変更された',randomUUID());
    expect(()=>f.service.pages.search(f.id,'特殊検索語',{cursor:first.nextCursor!})).toThrow('PAGE_RESYNC_REQUIRED');
  });
  it('loads a full old reply thread, including nested replies and tombstones, outside the recent window',()=>{
    const f=setup();const root=f.say('古い親');let parent=root.id;
    for(let i=0;i<240;i++){const reply=f.service.humanMessage(f.id,{text:'返信 '+i,replyTo:parent},randomUUID());if(i%7===0)parent=reply.id;}
    for(let i=0;i<240;i++)f.say('別の会話 '+i);
    expect(f.service.snapshot(f.id).messages.some(m=>m.id===root.id)).toBe(false);
    f.service.changeMessage(f.id,root.id,null,randomUUID());
    let cursor:string|null=null;const ids:string[]=[];
    do{const page=f.service.pages.thread(f.id,parent,{cursor,limit:27});expect(page.rootId).toBe(root.id);ids.push(...page.items.map(m=>m.id));cursor=page.nextCursor;}while(cursor);
    expect(ids).toHaveLength(241);expect(new Set(ids).size).toBe(241);expect(ids[0]).toBe(root.id);
    const other=f.service.createSession({...f.input,title:'別セッション'},randomUUID()).id;
    expect(()=>f.service.pages.thread(other,root.id)).toThrow('MESSAGE_NOT_FOUND');
    expect(()=>f.service.pages.history(other,{cursor:f.service.pages.history(f.id,{limit:10}).nextCursor!})).toThrow('PAGE_RESYNC_REQUIRED');
  });
  it('retains every grounded memory instead of evicting notes beyond 50',()=>{
    const f=setup(3,{memoryEvery:3});f.start();
    for(let batch=0;batch<15;batch++){
      for(let i=0;i<3;i++)f.say(`根拠 ${batch}-${i}`);
      f.finish(run(f.claim()),{decision:'ABSTAIN',reason:'記憶試験'});
      const memory=run(f.claim());expect(memory.kind).toBe('memory');
      f.finish(memory,{notes:Array.from({length:4},(_,i)=>({text:`永続記憶 ${batch}-${i}`,sourceMessageIds:[memory.context.messages.at(-1)!.id]}))});
    }
    const agent=f.service.agents(f.id)[0];
    expect(f.service.workerMemories(agent.slot,agent.id)).toHaveLength(60);
    expect(f.service.pages.memories(agent.id,'永続記憶 0-0').items[0].text).toBe('永続記憶 0-0');
    let cursor:string|null=null;const ids:string[]=[];
    do{const page=f.service.pages.memories(agent.id,'',{cursor,limit:7});ids.push(...page.items.map(m=>m.id));cursor=page.nextCursor;}while(cursor);
    expect(new Set(ids).size).toBe(60);
    f.say('次の入力');expect(run(f.claim()).context.memories.length).toBeLessThanOrEqual(12);
    expect(f.service.workerMemories(agent.slot,agent.id)).toHaveLength(60);
  });
  it('cannot commit KEEP before all 200 intervening messages have actually been reviewed',()=>{
    const f=setup(3,{contextMessages:40,memoryEvery:1000});f.say('最初');f.start();f.speak(run(f.claim()));f.finish(run(f.claim()),{decision:'DRAFT',text:'候補'});
    const intervening=Array.from({length:200},(_,i)=>f.say(i===130?'重要な訂正':'新着 '+i));
    const seen=new Set<string>();let rounds=0;
    for(;;){
      const review=run(f.claim());expect(review.kind).toBe('review');rounds++;
      for(const m of review.context.delta)seen.add(m.id);
      const coverage=review.context.coverage!;expect(coverage.throughRevision).toBeLessThanOrEqual(coverage.targetRevision);
      expect(review.context.delta.length).toBeLessThanOrEqual(100);
      f.finish(review,coverage.complete?{decision:'KEEP'}:{decision:'REWRITE',text:review.context.candidate!.text!,intent:review.context.candidate!.intent});
      if(!coverage.complete){expect(f.service.commitNext(f.id)).toBeNull();expect(rounds).toBeLessThan(40);continue;}
      expect(f.service.commitNext(f.id)?.text).toBe('候補');break;
    }
    expect(rounds).toBeGreaterThan(1);expect(seen).toEqual(new Set(intervening.map(m=>m.id)));
  });
  it('reviewed coverage remains incomplete when another edit arrives between chunk responses',()=>{
    const f=setup(3,{contextChars:8000,memoryEvery:1000});const first=f.say('初期');f.start();f.speak(run(f.claim()));f.finish(run(f.claim()),{decision:'DRAFT',text:'候補'});
    for(let i=0;i<12;i++)f.say('長めの変更 '.repeat(120));
    const review=run(f.claim());expect(review.context.coverage?.complete).toBe(false);
    f.service.changeMessage(f.id,first.id,'修正後の原文',randomUUID());f.finish(review,{decision:'REWRITE',text:review.context.candidate!.text!,intent:review.context.candidate!.intent});
    expect(f.service.commitNext(f.id)).toBeNull();
  });
  it('normal conversation events never clear error counts or shorten persisted retry times',()=>{
    const f=setup();f.start();
    for(let i=0;i<3;i++){const r=run(f.claim());f.service.failRun('worker-0',r.workerEpoch,r.id,r.token,'API_ERROR');f.advance(10000);}
    expect(f.claim()).toBeNull();const a=f.service.agents(f.id)[0],deadline=a.retry_at;
    f.say('無関係な新着');f.service.injectSource(f.id,{title:'題材',text:'本文'},randomUUID());
    expect(f.service.agent(a.id).error_count).toBe(3);expect(f.service.agent(a.id).retry_at).toBe(deadline);expect(f.claim()).toBeNull();
    f.service.retryAgent(f.id,a.id,randomUUID());expect(f.claim()).not.toBeNull();
  });
  it('distinguishes worker offline from a deliberate silence decision',()=>{
    const f=setup();f.start();for(const slot of Object.keys(f.epochs))f.finish(run(f.claim(slot)),{decision:'ABSTAIN',reason:'聞く'});
    expect(f.service.snapshot(f.id).agents.every(a=>a.workerOnline)).toBe(true);
    f.advance(40000);f.service.tick();expect(f.service.snapshot(f.id).agents.every(a=>!a.workerOnline)).toBe(true);
    expect(f.service.session(f.id).activity).toBe('DEGRADED');
  });
  it('default autonomous scheduling fits the budget and can wake without human input',()=>{
    const settings=SettingsSchema.parse({});expect(settings.selfWakeMaxMs).toBeLessThan(settings.maxDurationMs);
    const f=setup(3,{...settings,debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0});f.start();for(const slot of Object.keys(f.epochs))f.finish(run(f.claim(slot)),{decision:'ABSTAIN',reason:'聞く'});
    f.advance(settings.idleMs);for(const slot of Object.keys(f.epochs))f.finish(run(f.claim(slot)),{decision:'ABSTAIN',reason:'まだ静か'});
    f.advance(settings.selfWakeMinMs-settings.idleMs);
    const awake=run(f.claim());expect(awake.context.trigger).toBe('SELF_WAKE');expect(f.service.session(f.id).lifecycle).toBe('RUNNING');
    expect(()=>SettingsSchema.parse({maxDurationMs:1000})).toThrow();
    expect(()=>SettingsSchema.parse({maxDurationMs:1000,selfWakeEnabled:false})).not.toThrow();
  });
  it('pause time does not consume active time; renewing a budget preserves messages and lifetime counters',()=>{
    const f=setup(3,{maxDurationMs:3000,selfWakeEnabled:false,maxCalls:1});f.start();f.advance(1000);
    f.service.lifecycle(f.id,'pause',randomUUID());f.advance(100000);f.service.lifecycle(f.id,'resume',randomUUID());
    expect(f.service.publicSession(f.service.session(f.id)).budget.activeMs).toBe(1000);
    const r=run(f.claim());f.finish(r,{decision:'ABSTAIN',reason:'終了'});f.advance(2000);f.service.tick();
    expect(f.service.session(f.id).stop_reason).toBe('MAX_DURATION');f.say('次の実験の前にも残る');
    expect(()=>f.service.lifecycle(f.id,'resume',randomUUID())).toThrow('LIMIT_ALREADY_REACHED');
    f.service.renewBudget(f.id,randomUUID());f.service.lifecycle(f.id,'resume',randomUUID());
    const s=f.service.snapshot(f.id);expect(s.session.calls).toBe(1);expect(s.session.budget.callsUsed).toBe(0);expect(s.messages).toHaveLength(1);
  });
});
