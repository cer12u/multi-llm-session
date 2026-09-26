import { expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store,type CandidateRow } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient,WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { modelRequest,MockModel } from '../packages/models/index.js';
import { projectModelContext } from '../packages/models/model-protocol.js';
import type { Context } from '../packages/contracts/index.js';

it('R4-REVIEW-005: a reconstructed partial candidate survives Core reopen without losing text, coverage or original interest age',()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-recovery-')),f=fixture(3,{contextMessages:5,contextChars:12000,memoryEvery:1000},join(dir,'session.sqlite'));
  let db:Store|undefined;
  try {
    f.say('最初の集合時刻15時');f.start();f.speak(f.claim()!);const draft=f.claim()!;
    f.say('訂正：集合は16時');for(let i=0;i<20;i++)f.say('別の入力 '+i);
    f.finish(draft,{decision:'DRAFT',text:'集合は15時です。'});
    const first=f.claim()!;expect(first.context.coverage!.complete).toBe(false);
    f.finish(first,{decision:'REWRITE',text:'集合は16時です。',intent:first.context.candidate!.intent});
    const saved=f.store.get<CandidateRow>('SELECT * FROM candidates WHERE id=?',first.context.candidate!.id)!;f.close();
    db=new Store(f.config.dbPath);const service=new SessionService(db,f.config,f.now,()=>0);service.recover();
    const epoch=service.registerWorker('worker-0').epoch;
    let rounds=0,complete=false;
    for(;rounds<30;rounds++){
      const run=service.claim('worker-0',epoch)!;expect(run.kind).toBe('review');
      expect(run.context.candidate!.text).toBe(saved.text);
      if(rounds===0)expect(run.context.coverage!.fromRevision).toBe(saved.reviewed_revision);
      complete=run.context.coverage!.complete;
      const call=service.reserveCall('worker-0',epoch,run.id,run.token,randomUUID(),'primary');
      service.finishCall('worker-0',run.id,run.token,call.id,{inputTokens:null,outputTokens:null},null);
      service.completeRun('worker-0',epoch,run.id,run.token,complete?{decision:'KEEP'}:{decision:'REWRITE',text:saved.text,intent:run.context.candidate!.intent});
      expect(db.get<CandidateRow>('SELECT * FROM candidates WHERE id=?',saved.id)!.first_interested_at).toBe(saved.first_interested_at);
      if(complete){expect(service.commitNext(f.id)?.text).toBe(saved.text);break;}
      expect(service.commitNext(f.id)).toBeNull();
    }
    expect(complete).toBe(true);expect(service.session(f.id).bot_count).toBe(1);expect(service.commitNext(f.id)).toBeNull();
    expect(db.db.pragma('foreign_key_check')).toEqual([]);
  } finally {db?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R4-REVIEW-006: a real HTTP Worker carries the first correction across chunks while Core accepts input during the pending model call',async()=>{
  const f=fixture(3,{contextMessages:5,contextChars:12000,memoryEvery:1000}),app=buildServer(f.service,{timers:false});
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const captured:Context[]=[];let inFlight:Promise<boolean>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
  try {
    f.say('最初の集合は15時');f.start();f.speak(f.claim()!);const draft=f.claim()!;
    const correction=f.say('訂正：集合は16時');for(let i=0;i<25;i++)f.say('独立した別入力 '+i);
    f.finish(draft,{decision:'DRAFT',text:'集合は15時です。'});
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No synthetic Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const worker=new WorkerRuntime(new CoreClient(base,f.config.workerTokens['worker-0']),{},run=>({complete:async(kind,context)=>{
      expect(kind).toBe('review');captured.push(structuredClone(context));
      const body=modelRequest(run.profile,kind,context,{maxChars:run.contextChars});
      const messages=body.messages as {role:string;content:string}[];
      expect(messages.find(m=>m.role==='system')!.content).toContain('REWRITE the entire working candidate');
      expect(JSON.parse(messages.find(m=>m.role==='user')!.content)).toEqual(projectModelContext(context).context);
      expect(f.store.db.inTransaction).toBe(false);
      if(captured.length===1){expect(context.delta.some(m=>m.id===correction.id)).toBe(true);entered();await gate;}
      else expect(context.candidate!.text).toBe('集合は16時です。');
      return {text:JSON.stringify(context.coverage!.complete?{decision:'KEEP'}:{decision:'REWRITE',text:'集合は16時です。',intent:context.candidate!.intent}),usage:{inputTokens:null,outputTokens:null}};
    }}));
    await worker.register();inFlight=worker.once();
    await Promise.race([started,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('SYNTHETIC_MODEL_NOT_ENTERED')),5000);})]);clearTimeout(deadline);
    // This completes before releasing the model promise: no SQLite transaction/lock is held while inference waits.
    const response=await fetch(base+`/v1/sessions/${f.id}/messages`,{method:'POST',headers:{authorization:'Bearer '+f.config.adminToken,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({text:'推論中にも確定できる人間の割込み'}),signal:AbortSignal.timeout(3000)});
    expect(response.status).toBe(200);await response.json();expect(f.store.db.inTransaction).toBe(false);
    release();await inFlight;inFlight=undefined;
    expect(f.store.get<CandidateRow>("SELECT * FROM candidates WHERE state='NEEDS_REVIEW'")!.text).toBe('集合は16時です。');
    for(let i=0;i<30&&f.service.session(f.id).bot_count===0;i++){
      await worker.once();
      // End this review-only fixture at publication. A further claim legitimately observes the new own message.
      f.service.commitNext(f.id);
    }
    expect(f.service.session(f.id).bot_count).toBe(1);expect(captured.length).toBeGreaterThan(2);
    expect(captured.slice(1).some(ctx=>!ctx.delta.some(m=>m.id===correction.id)&&ctx.candidate!.text==='集合は16時です。')).toBe(true);
    expect(f.service.snapshot(f.id).messages.filter(m=>m.authorId!==null).map(m=>m.text)).toEqual(['集合は16時です。']);
    expect(f.service.agents(f.id)[0].error_count).toBe(0);
  } finally {clearTimeout(deadline);release();await inFlight?.catch(()=>{});await app.close();f.close();}
},20000);

it('R4-REVIEW-007: mock input catching-up cannot emit bare KEEP when delta is empty but delivery remains incomplete',async()=>{
  const f=fixture();
  try {
    f.say();f.start();f.speak(f.claim()!);const run=f.claim()!,context=run.context;
    context.delta=[];context.coverage={fromRevision:0,throughRevision:0,targetRevision:1,complete:false};
    context.candidate!.text='【模擬応答】そのまま引き継ぐ候補';
    const result=await new MockModel().complete('review',context,{signal:new AbortController().signal,maxChars:24000});
    expect(JSON.parse(result.text)).toEqual({decision:'REWRITE',text:context.candidate!.text,intent:context.candidate!.intent});
  } finally {f.close();}
});
