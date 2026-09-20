import { afterEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store, type CandidateRow } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import type { ClaimedRun } from '../packages/contracts/index.js';

const cleanups:(()=>void)[]=[];afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();});
function setup(...args:Parameters<typeof fixture>){const f=fixture(...args);cleanups.push(f.close);return f;}
function required(run:ClaimedRun|null):ClaimedRun{expect(run).not.toBeNull();return run!;}

describe('persistent session invariants',()=>{
  it('creates DRAFT without making model calls and snapshots character versions',()=>{
    const f=setup();expect(f.service.snapshot(f.id).session.lifecycle).toBe('DRAFT');expect(f.claim()).toBeNull();
    const c=f.config.characters[0];f.service.putCharacter({...c,version:2,persona:'Updated character'});
    expect(f.service.characters().find(x=>x.id===c.id)?.version).toBe(2);
    expect(f.service.snapshot(f.id).agents[0].characterVersion).toBe(1);
    expect(()=>f.service.putCharacter({...c,persona:'Replaced same version'})).toThrow('CHARACTER_VERSION_IMMUTABLE');
  });
  it('deduplicates commands across response loss and rejects key reuse with a different body',()=>{
    const f=setup(),key=randomUUID();const one=f.service.humanMessage(f.id,{text:'同じ入力'},key);
    const wake=f.service.agent(f.service.agents(f.id)[0].id).wake_seq;
    expect(f.service.humanMessage(f.id,{text:'同じ入力'},key)).toEqual(one);
    expect(f.service.snapshot(f.id).messages).toHaveLength(1);expect(f.service.agents(f.id)[0].wake_seq).toBe(wake);
    expect(()=>f.service.humanMessage(f.id,{text:'異なる入力'},key)).toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('permits only one active run per worker and replays a lost claim response',()=>{
    const f=setup();f.start();const run=required(f.claim());expect(f.claim()?.id).toBe(run.id);
    expect(f.store.get<{n:number}>("SELECT COUNT(*) n FROM runs WHERE state='ACTIVE'")?.n).toBe(1);
  });
  it('resolves three simultaneous candidates and requires later agents to review actual deltas',()=>{
    const f=setup();f.say();f.start();const slots=Object.keys(f.epochs);
    const decisions=slots.map(s=>required(f.claim(s)));decisions.forEach(f.speak);
    const drafts=slots.map(s=>required(f.claim(s)));drafts.forEach((r,i)=>f.finish(r,{decision:'DRAFT',text:`候補 ${i}`}));
    expect(f.store.all<CandidateRow>("SELECT * FROM candidates WHERE state='READY'")).toHaveLength(3);
    const first=f.service.commitNext(f.id);expect(first).not.toBeNull();expect(f.service.commitNext(f.id)).toBeNull();
    const waiting=slots.find(s=>f.service.agents(f.id).find(a=>a.slot===s)?.id!==first?.authorId)!;
    const review=required(f.claim(waiting));expect(review.kind).toBe('review');expect(review.context.delta.map(m=>m.id)).toContain(first!.id);
    f.finish(review,{decision:'REWRITE',text:'先行発言への補足',intent:review.context.candidate!.intent});
    const second=f.service.commitNext(f.id);expect(second?.text).toBe('先行発言への補足');
    expect(second!.revision).toBe(first!.revision+1);
  });
  it('does not publish a draft generated against history changed during inference',()=>{
    const f=setup();f.start();f.speak(required(f.claim()));const draft=required(f.claim());
    f.say('生成中の割り込み');f.finish(draft,{decision:'DRAFT',text:'古い文脈に対する発言'});
    expect(f.service.commitNext(f.id)).toBeNull();expect(required(f.claim()).kind).toBe('review');
  });
  it('drops an obsolete intention without emitting a public message',()=>{
    const f=setup();f.start();f.speak(required(f.claim()));f.finish(required(f.claim()),{decision:'DRAFT',text:'未投稿'});
    f.say('新しい情報');const review=required(f.claim());f.finish(review,{decision:'DROP',reason:'重複'});
    expect(f.service.snapshot(f.id).messages.filter(m=>m.authorId)).toHaveLength(0);
  });
  it('fences late inference results after pause and permits human input while paused',()=>{
    const f=setup();f.start();const run=required(f.claim());const call=f.service.reserveCall('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),'primary');
    f.service.lifecycle(f.id,'pause',randomUUID());
    f.service.finishCall('worker-0',run.id,run.token,call.id,{inputTokens:5,outputTokens:5},null);
    expect(()=>f.service.completeRun('worker-0',run.workerEpoch,run.id,run.token,{decision:'ABSTAIN',reason:'x'})).toThrow('STALE_RUN');
    f.say('停止中の補足');expect(f.claim()).toBeNull();f.service.lifecycle(f.id,'resume',randomUUID());expect(required(f.claim()).sessionEpoch).toBeGreaterThan(run.sessionEpoch);
  });
  it('returns an already completed result without executing it again after a pause',()=>{
    const f=setup();f.start();const run=required(f.claim()),output={decision:'ABSTAIN',reason:'聞く'};f.finish(run,output);
    f.service.lifecycle(f.id,'pause',randomUUID());expect(f.service.completeRun('worker-0',run.workerEpoch,run.id,run.token,output)).toEqual({ok:true});
  });
  it('recovers an expired lease and rejects its old result',()=>{
    const f=setup(3,{leaseMs:5000});f.start();const run=required(f.claim());f.advance(5001);f.service.tick();
    expect(required(f.claim()).id).not.toBe(run.id);
    expect(()=>f.service.completeRun('worker-0',run.workerEpoch,run.id,run.token,{decision:'ABSTAIN',reason:'old'})).toThrow('STALE_RUN');
  });
  it('fences a replaced worker without affecting other agent slots',()=>{
    const f=setup();f.start();const old=required(f.claim());const epoch=f.service.registerWorker('worker-0').epoch;
    expect(epoch).toBeGreaterThan(old.workerEpoch);expect(()=>f.claim()).toThrow('STALE_WORKER');
    expect(f.claim('worker-1')).not.toBeNull();
  });
  it('holds deferred intentions until the requested condition, without losing new messages',()=>{
    const f=setup();f.start();const run=required(f.claim());f.finish(run,{decision:'DEFER',reason:'返答待ち',defer:{kind:'new_message',afterMs:10000,agentId:null}});
    expect(f.claim()).toBeNull();const m=f.say('新着で再開');const next=required(f.claim());expect(next.context.messages.map(x=>x.id)).toContain(m.id);
  });
  it('keeps a timed deferral despite unrelated messages then wakes at its deadline',()=>{
    const f=setup();f.start();f.finish(required(f.claim()),{decision:'DEFER',reason:'待つ',defer:{kind:'time',afterMs:5000,agentId:null}});
    f.say();expect(f.claim()).toBeNull();f.advance(5000);expect(f.claim()).not.toBeNull();
  });
  it('enters QUIET and fires only one idle check per silence epoch',()=>{
    const f=setup();f.start();for(const slot of Object.keys(f.epochs))f.finish(required(f.claim(slot)),{decision:'ABSTAIN',reason:'聞く'});
    f.service.tick();expect(f.service.session(f.id).activity).toBe('QUIET');f.advance(1001);
    for(const slot of Object.keys(f.epochs)){const run=required(f.claim(slot));expect(run.context.trigger).toBe('IDLE');f.finish(run,{decision:'ABSTAIN',reason:'話題なし'});}
    f.advance(2000);f.service.tick();for(const slot of Object.keys(f.epochs))expect(f.claim(slot)).toBeNull();
  });
  it('distinguishes an API error from choosing silence',()=>{
    const f=setup();f.start();const run=required(f.claim());f.service.failRun('worker-0',run.workerEpoch,run.id,run.token,'API_ERROR');
    f.service.tick();expect(f.service.session(f.id).activity).toBe('DEGRADED');expect(f.service.agents(f.id)[0].error_count).toBe(1);
  });
  it('reserves a shared provider concurrency budget before calls are sent',()=>{
    const f=setup(5);f.start();const runs=Object.keys(f.epochs).map(slot=>required(f.claim(slot)));
    for(const run of runs.slice(0,3))f.service.reserveCall(f.service.agent(run.context.self.id).slot,run.workerEpoch,run.id,run.token,randomUUID(),'primary');
    const fourth=runs[3];expect(()=>f.service.reserveCall('worker-3',fourth.workerEpoch,fourth.id,fourth.token,randomUUID(),'primary')).toThrow('PROVIDER_BUSY');
  });
  it('counts repairs in the same hard call limit and persists budget pause',()=>{
    const f=setup(3,{maxCalls:1});f.start();const run=required(f.claim());
    const call=f.service.reserveCall('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),'primary');f.service.finishCall('worker-0',run.id,run.token,call.id,{inputTokens:null,outputTokens:null},null);
    expect(()=>f.service.reserveCall('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),'repair')).toThrow('BUDGET_STOPPED');
    expect(f.service.session(f.id).lifecycle).toBe('PAUSED');expect(f.service.session(f.id).activity).toBe('BUDGET_PAUSED');expect(f.service.session(f.id).call_count).toBe(1);
  });
  it('stops new publication at message and duration limits',()=>{
    const f=setup(3,{maxMessages:1,maxDurationMs:1000});f.start();f.speak(required(f.claim()));f.finish(required(f.claim()),{decision:'DRAFT',text:'一つだけ'});
    expect(f.service.commitNext(f.id)).not.toBeNull();expect(f.service.session(f.id).stop_reason).toBe('MAX_MESSAGES');expect(f.claim()).toBeNull();
    const other=setup(3,{maxDurationMs:1000});other.start();other.advance(1000);other.service.tick();expect(other.service.session(other.id).stop_reason).toBe('MAX_DURATION');
  });
  it('does not return private memories to a different agent',()=>{
    const f=setup(),message=f.say('出典のある発言'),[a,b]=f.service.agents(f.id);
    f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at) VALUES(?,?,?,?,?)',randomUUID(),a.id,'秘密のメモ',JSON.stringify([message.id]),f.now());
    expect(f.service.workerMemories(a.slot,a.id)).toHaveLength(1);expect(()=>f.service.workerMemories(b.slot,a.id)).toThrow('PRIVATE_STATE_FORBIDDEN');
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('秘密のメモ');
    f.service.changeMessage(f.id,message.id,null,randomUUID());expect(f.service.workerMemories(a.slot,a.id)).toHaveLength(0);
  });
  it('isolates same-character instances across sessions and forbids foreign replies',()=>{
    const f=setup(),first=f.say('別セッションの情報'),other=f.service.createSession(f.input,randomUUID()).id;
    expect(f.service.agents(other)[0].id).not.toBe(f.service.agents(f.id)[0].id);
    expect(()=>f.service.humanMessage(other,{text:'外部への返信',replyTo:first.id},randomUUID())).toThrow('INVALID_REPLY_REFERENCE');
    expect(f.service.snapshot(other).messages).toHaveLength(0);
  });
  it('replays events between snapshot and subscription without advancing agent cursors',()=>{
    const f=setup(),before=f.service.snapshot(f.id),m=f.say('接続の隙間');
    const wake=f.service.agents(f.id)[0].wake_seq;const first=f.service.eventsAfter(f.id,before.cursor);
    expect(first.some(e=>e.message?.id===m.id)).toBe(true);expect(f.service.eventsAfter(f.id,before.cursor)).toEqual(first);
    expect(f.service.agents(f.id)[0].wake_seq).toBe(wake);
    const other=f.service.createSession(f.input,randomUUID()).id;expect(()=>f.service.eventsAfter(other,before.cursor)).toThrow('RESYNC_REQUIRED');
  });
  it('never resurrects deleted content through historical event replay or quote retrieval',()=>{
    const f=setup(),cursor=f.service.snapshot(f.id).cursor,m=f.say('削除すべき原文');f.service.changeMessage(f.id,m.id,null,randomUUID());
    expect(JSON.stringify(f.service.eventsAfter(f.id,cursor))).not.toContain('削除すべき原文');expect(()=>f.service.archiveMessage(f.id,m.id)).toThrow('MESSAGE_DELETED');
  });
  it('searches Japanese trigrams and shorter terms with exact original text',()=>{
    const f=setup(),m=f.say('気圧センサで高度を測ります');expect(f.service.searchArchive(f.id,'気圧センサ')[0].id).toBe(m.id);expect(f.service.searchArchive(f.id,'高度')[0].text).toBe(m.text);
  });
  it('starts a new episode after a gap without replacing the session or members',()=>{
    const f=setup(),a=f.say('前の話');f.advance(2001);const b=f.say('再開');expect(b.episode).toBe(a.episode+1);expect(b.sessionId).toBe(a.sessionId);
  });
  it('deduplicates external sources but does not turn source input into a message',()=>{
    const f=setup(),key=randomUUID(),source={title:'資料',text:'資料の内容'};
    expect(f.service.injectSource(f.id,source,key)).toEqual(f.service.injectSource(f.id,source,key));expect(f.service.snapshot(f.id).messages).toHaveLength(0);
    expect(f.service.agents(f.id)[0].trigger).toBe('SOURCE_AVAILABLE');
  });
  it('persists committed messages and command receipts through an actual SQLite reopen',()=>{
    const root=mkdtempSync(join(tmpdir(),'mls-test-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
    const f=fixture(3,{},join(root,'test.sqlite')),key=randomUUID();const m=f.service.humanMessage(f.id,{text:'永続化された本文'},key);f.start();f.close();
    const store=new Store(f.config.dbPath);cleanups.push(()=>store.close());const service=new SessionService(store,f.config,f.now,()=>0);service.recover();
    expect(service.snapshot(f.id).messages[0].id).toBe(m.id);expect(service.humanMessage(f.id,{text:'永続化された本文'},key).id).toBe(m.id);
    expect(service.session(f.id).lifecycle).toBe('RUNNING');expect(service.snapshot(f.id).messages).toHaveLength(1);
  });
  it('keeps ENDED sessions read-only',()=>{
    const f=setup();f.service.lifecycle(f.id,'end',randomUUID());expect(()=>f.say()).toThrow('SESSION_ENDED');expect(()=>f.start()).toThrow('INVALID_LIFECYCLE');
  });
});
