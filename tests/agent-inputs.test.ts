import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { LocalMemoryRetriever } from '../packages/session-service/recall.js';
import type { ClaimedRun, InputWindow, StatePatch } from '../packages/contracts/index.js';

type Fixture = ReturnType<typeof fixture>;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(...args: Parameters<typeof fixture>) {
  const f = fixture(...args); cleanup.push(() => { if (f.store.db.open) f.close(); }); return f;
}
function claim(f: Fixture, slot = 'worker-0'): ClaimedRun {
  const run = f.claim(slot); expect(run).not.toBeNull(); return run!;
}
function cursor(f: Fixture, slot = 'worker-0') {
  return f.store.get<{observed_input:number;memory_input:number}>(`SELECT c.* FROM agent_input_cursors c
    JOIN agent_instances a ON a.id=c.agent_id WHERE a.session_id=? AND a.slot=?`, f.id, slot)!;
}
function finish(f: Fixture, run: ClaimedRun): void {
  const output = run.kind === 'memory' ? { notes: [] } : run.kind === 'draft' || run.kind === 'review'
    ? { decision: 'DROP', reason: 'No public fixture proposal' } : { decision: 'ABSTAIN', reason: 'Listen' };
  f.finish(run, output);
}
function statePatch(run: ClaimedRun, text: string): StatePatch {
  const source = run.context.messages.find(m => !m.deleted)!;
  return { agentId: run.context.self.id, sessionId: run.context.self.privateState!.sessionId,
    expectedVersion: run.context.self.privateState!.version, observationId: run.context.observation!.id,
    upsert: [{ id: 'held-question', kind: 'question', text,
      evidence: [{kind:'message',id:source.id,version:source.revision}],resume:null }], remove: [] };
}
function windows(f: Fixture, agentId: string, purpose: string): InputWindow[] {
  return f.store.all<{window_json:string}>('SELECT window_json FROM agent_input_receipts WHERE agent_id=? AND purpose=? ORDER BY through_input,created_at', agentId, purpose).map(r => JSON.parse(r.window_json) as InputWindow);
}
function inputIds(f: Fixture): number[] { return f.store.all<{id:number}>('SELECT id FROM agent_input_log WHERE session_id=? ORDER BY id', f.id).map(r => r.id); }
function drain(f: Fixture, limit = 1000): void {
  for (let round = 0; round < limit; round++) {
    let work = false;
    for (const slot of Object.keys(f.epochs)) {
      const r = f.claim(slot); if (r) { work = true; finish(f, r); }
    }
    if (!work) return;
  }
  throw new Error('Input drain did not quiesce within fixture limit');
}

describe('independent durable input and memory windows, not LLM understanding', () => {
  it('R2-LOOP-002: 235 messages, a correction and a tombstone are consumed once per cursor without gaps', () => {
    const f = setup(3, {contextMessages:5,memoryEvery:3,memoryShareEvery:3});
    const original = Array.from({length:235}, (_,i) => f.say(i===117 ? '訂正前の予定は水曜日' : `合成会話 ${i}`));
    f.service.changeMessage(f.id, original[117].id, '訂正された予定は木曜日', randomUUID());
    f.service.changeMessage(f.id, original[90].id, null, randomUUID());
    const ids = inputIds(f); f.start(); drain(f);
    for (const a of f.service.agents(f.id)) {
      for (const purpose of ['observation','memory']) {
        const received = windows(f,a.id,purpose), entries = received.flatMap(w=>w.entries);
        expect(entries.map(e=>e.inputId)).toEqual(ids);
        expect(new Set(entries.map(e=>e.inputId)).size).toBe(ids.length);
        expect(received.every(w=>w.entries.length<=5)).toBe(true);
        expect(entries.some(e=>e.id===original[117].id&&e.superseded)).toBe(true);
      }
      expect(cursor(f,a.slot)).toMatchObject({observed_input:ids.at(-1),memory_input:ids.at(-1)});
    }
    expect(f.service.session(f.id).bot_count).toBe(0);
    expect(f.service.snapshot(f.id).session.activity).toBe('QUIET');
    const contexts = f.store.all<{context_json:string}>('SELECT context_json FROM runs WHERE session_id=?',f.id);
    expect(contexts.some(r=>r.context_json.includes('訂正された予定は木曜日'))).toBe(true);
    expect(contexts.some(r=>r.context_json.includes('訂正前の予定は水曜日'))).toBe(false);
  });

  it('R5-MEMORY-002: continuous new input cannot starve the reserved memory share', () => {
    const f=setup(3,{contextMessages:5,memoryEvery:3,memoryShareEvery:3});
    for(let i=0;i<35;i++)f.say(`初期入力 ${i}`);f.start();
    const a=f.service.agents(f.id)[0];let consecutiveForeground=0,memoryRuns=0;
    for(let i=0;i<50;i++){
      f.say(`継続する入力 ${i}`);const r=claim(f);
      expect(r.context.progress!.memoryPending).toBeGreaterThan(0);
      expect(r.context.progress!.oldestMemoryAt).not.toBeNull();
      if(r.kind==='memory'){memoryRuns++;consecutiveForeground=0;}else consecutiveForeground++;
      expect(consecutiveForeground).toBeLessThanOrEqual(3);finish(f,r);
    }
    expect(memoryRuns).toBeGreaterThan(0);
    const processed=windows(f,a.id,'memory').flatMap(w=>w.entries.map(e=>e.inputId));
    expect(processed.length).toBeGreaterThan(35);
    expect(processed).toEqual(inputIds(f).slice(0,processed.length));
    drain(f);expect(cursor(f).memory_input).toBe(inputIds(f).at(-1));
  });

  it('R2-LOOP-003: observing while deferred updates only the owner and does not end the deferral',()=>{
    const f=setup();f.say('最初の入力');f.start();const initial=claim(f);
    f.finish(initial,{decision:'DEFER',reason:'待つ',defer:{kind:'time',afterMs:10000,agentId:null}});
    const before=f.service.agent(initial.context.self.id).deferral_json;
    f.say('保留中に聞いた訂正');const observed=claim(f);expect(observed.kind).toBe('observe');
    const result={action:{decision:'ABSTAIN',reason:'疑問を残す'},statePatch:statePatch(observed,'本人だけが保存する待機中の疑問')};
    f.finish(observed,result);
    expect(f.service.agent(initial.context.self.id).deferral_json).toBe(before);
    const other=claim(f,'worker-1');expect(JSON.stringify(other.context)).not.toContain('本人だけが保存する待機中の疑問');finish(f,other);
    f.advance(10000);const resumed=claim(f);expect(resumed.kind).toBe('decide');
    expect(resumed.context.self.privateState!.entries[0].text).toBe('本人だけが保存する待機中の疑問');
    expect(f.service.session(f.id).bot_count).toBe(0);
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('本人だけが保存する待機中の疑問');
  });

  it('R2-LOOP-004: observe cannot smuggle a public SPEAK action past a deferral',()=>{
    const f=setup();f.say();f.start();f.finish(claim(f),{decision:'DEFER',reason:'待つ',defer:{kind:'time',afterMs:10000,agentId:null}});
    f.say('新しい入力');const r=claim(f),before=cursor(f);
    expect(()=>f.finish(r,{decision:'SPEAK',intent:{act:'comment',intent:'禁止を回避',replyTo:null,addressedTo:[]}})).toThrow();
    expect(cursor(f)).toEqual(before);expect(f.store.all('SELECT * FROM candidates')).toHaveLength(0);
    expect(f.service.session(f.id).bot_count).toBe(0);
  });

  it('R5-MEMORY-003: a source outside the supplied memory segment cannot become a note',()=>{
    const f=setup(3,{contextMessages:5,memoryEvery:3});let last;
    for(let i=0;i<30;i++)last=f.say(`入力 ${i}`);f.start();let memory:ClaimedRun|null=null;
    for(let i=0;i<8;i++){const r=claim(f);if(r.kind==='memory'){memory=r;break;}finish(f,r);}
    expect(memory).not.toBeNull();const before=cursor(f);
    expect(memory!.context.messages.some(m=>m.id===last!.id)).toBe(false);
    expect(()=>f.finish(memory!,{notes:[{text:'未読の根拠を偽装',sourceMessageIds:[last!.id]}]})).toThrow('INVALID_MEMORY_SOURCE');
    expect(cursor(f)).toEqual(before);expect(f.service.workerMemories('worker-0',memory!.context.self.id)).toHaveLength(0);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',memory!.id)).toHaveLength(0);
  });

  it('R2-LOOP-005: an edited in-flight input rolls back the action, state and both cursors',()=>{
    const f=setup();const original=f.say('処理中の原文');f.start();const r=claim(f),before=cursor(f);
    f.service.changeMessage(f.id,original.id,'訂正された原文',randomUUID());
    expect(()=>f.finish(r,{decision:'SPEAK',intent:{act:'comment',intent:'古い原文に返す',replyTo:null,addressedTo:[]}})).toThrow('STALE_INPUT_EVIDENCE');
    expect(cursor(f)).toEqual(before);expect(f.store.all('SELECT * FROM candidates')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM agent_state_updates WHERE run_id=?',r.id)).toHaveLength(0);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',r.id)).toHaveLength(0);
  });

  it('R5-MEMORY-004: result replay advances one range once and keeps the exact source-version receipt',()=>{
    const f=setup(3,{memoryEvery:3});for(let i=0;i<3;i++)f.say(`原文 ${i}`);f.start();finish(f,claim(f));
    const r=claim(f);expect(r.kind).toBe('memory');const original=r.context.messages[0];
    const result={notes:[{text:'本人が残した原文付きのメモ',sourceMessageIds:[original.id]}]};f.finish(r,result);
    const before=cursor(f);f.service.completeRun('worker-0',r.workerEpoch,r.id,r.token,result);
    expect(cursor(f)).toEqual(before);expect(f.service.workerMemories('worker-0',r.context.self.id)).toHaveLength(1);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',r.id)).toHaveLength(1);
    const origin=f.store.get<{evidence_json:string}>('SELECT * FROM memory_input_origins WHERE run_id=?',r.id)!;
    expect(JSON.parse(origin.evidence_json)).toEqual([{kind:'message',id:original.id,version:original.revision}]);
    expect(()=>f.service.completeRun('worker-0',r.workerEpoch,r.id,r.token,{notes:[]})).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('R5-MEMORY-005: restart resumes unfinished memory and observation windows without acknowledging a killed run',()=>{
    const dir=mkdtempSync(join(tmpdir(),'input-restart-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
    const f=setup(3,{memoryEvery:3,contextMessages:5},join(dir,'db.sqlite'));
    for(let i=0;i<45;i++)f.say(`永続入力 ${i}`);f.start();
    for(let i=0;i<4;i++)finish(f,claim(f));
    const killed=claim(f),before=cursor(f),all=inputIds(f);f.close();
    const db=new Store(f.config.dbPath);cleanup.push(()=>db.close());const service=new SessionService(db,f.config,f.now);service.recover();
    const epoch=service.registerWorker('worker-0').epoch,next=service.claim('worker-0',epoch)!;
    expect(next.id).not.toBe(killed.id);
    expect(next.context.delivery!.fromInput).toBe(next.kind==='memory'?before.memory_input:before.observed_input);
    expect(next.context.delivery!.entries[0].inputId).toBe(all.find(id=>id>next.context.delivery!.fromInput));
    expect(db.get('SELECT * FROM agent_input_receipts WHERE run_id=?',killed.id)).toBeUndefined();
    expect(()=>service.completeRun('worker-0',killed.workerEpoch,killed.id,killed.token,{decision:'ABSTAIN',reason:'遅延'})).toThrow();
  });

  it('R2-LOOP-006: pause and browser reads do not advance cursors or invoke the model',()=>{
    const f=setup(3,{contextMessages:5,memoryEvery:3});for(let i=0;i<20;i++)f.say(`入力 ${i}`);f.start();finish(f,claim(f));
    f.service.lifecycle(f.id,'pause',randomUUID());const before=cursor(f),calls=f.service.session(f.id).call_count;
    for(let i=0;i<10;i++){f.service.snapshot(f.id);f.service.diagnostics(f.id);f.service.tick();expect(f.claim()).toBeNull();}
    expect(cursor(f)).toEqual(before);expect(f.service.session(f.id).call_count).toBe(calls);
    f.service.lifecycle(f.id,'resume',randomUUID());expect(claim(f).context.delivery!.fromInput).toBe(before.observed_input);
  });

  it('R5-MEMORY-006: below-threshold input is eventually flushed, with no empty-job polling loop',()=>{
    const f=setup(3,{memoryEvery:100,memoryFlushMs:1000});f.say('少量でも残す入力');f.start();drain(f);
    expect(cursor(f).memory_input).toBe(0);f.advance(1000);drain(f);
    expect(cursor(f).memory_input).toBe(inputIds(f).at(-1));
    const calls=f.service.session(f.id).call_count;drain(f);expect(f.service.session(f.id).call_count).toBe(calls);
  });

  it('R2-LOOP-007: source notifications have independent order and explicitly label an excerpt',()=>{
    const f=setup(3,{memoryEvery:3});f.say('会話');
    const source=f.service.injectSource(f.id,{title:'資料',text:'資料本文'.repeat(700)},randomUUID());f.start();const r=claim(f);
    const supplied=r.context.delivery!.entries.find(e=>e.id===source.id)!;
    expect(supplied.kind).toBe('source');expect(supplied.excerpt).toBe(true);
    expect(r.context.sources[0].text).toHaveLength(1600);
    expect(r.context.observation!.sources[0].id).toBe(source.id);finish(f,r);
    expect(cursor(f).observed_input).toBe(inputIds(f).at(-1));
  });

  it('R2-LOOP-008: an oversized mandatory first input is diagnosed and never silently skipped',()=>{
    const f=setup(3,{contextChars:4000});f.say('x'.repeat(3900));f.start();
    expect(f.claim()).toBeNull();expect(cursor(f).observed_input).toBe(0);
    expect(f.service.agents(f.id)[0].last_error).toBe('CONTEXT_LIMIT');
    expect(f.service.session(f.id).call_count).toBe(0);expect(f.store.all('SELECT * FROM agent_input_receipts')).toHaveLength(0);
  });

  it('R5-RECALL-001: an old relevant memory is selected with its original, not replaced by twelve unrelated newer notes',()=>{
    const f=setup(3,{memoryEvery:1000});const original=f.say('宇宙望遠鏡の観測予定を覚えておく');const [a,b]=f.service.agents(f.id);
    const oldId=randomUUID();
    f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',oldId,a.id,'宇宙望遠鏡の観測予定',JSON.stringify([original.id]),f.now(),1);
    for(let i=0;i<30;i++)f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',randomUUID(),a.id,`無関係な献立 ${i}`,JSON.stringify([original.id]),f.now(),i+2);
    f.store.run('UPDATE agent_instances SET memory_seq=31 WHERE id=?',a.id);
    for(let i=0;i<210;i++)f.say(`別の会話 ${i}`);f.start();drain(f);
    f.say('宇宙望遠鏡の観測予定について再開しよう');const r=claim(f);
    expect(r.kind).toBe('decide');expect(r.context.memories[0].id).toBe(oldId);
    expect(r.context.retrieved!.some(item=>item.messages.some(m=>m.id===original.id))).toBe(true);
    expect(r.context.recall!.selected[0].provenance).toBe('legacy-unversioned');
    const other=claim(f,b.slot);expect(other.context.memories.some(m=>m.id===oldId)).toBe(false);
    f.service.changeMessage(f.id,original.id,null,randomUUID());
    expect(new LocalMemoryRetriever(f.store).search({agentId:a.id,sessionId:f.id,text:'宇宙望遠鏡',evidenceIds:[],limit:12})).toHaveLength(0);
  });

  it('R4-STATE-001: a candidate cannot commit against a subsequently invalidated private-state version',()=>{
    const f=setup();f.say();f.start();const first=claim(f);
    f.finish(first,{action:{decision:'SPEAK',intent:{act:'comment',intent:'本人の疑問を話す',replyTo:null,addressedTo:[]}},statePatch:statePatch(first,'本人の疑問')});
    f.finish(claim(f),{decision:'DRAFT',text:'未投稿の候補'});
    f.store.run('UPDATE agent_private_states SET version=version+1 WHERE agent_id=?',first.context.self.id);
    expect(f.service.commitNext(f.id)).toBeNull();expect(claim(f).kind).toBe('review');
    expect(f.service.session(f.id).bot_count).toBe(0);
  });
});
