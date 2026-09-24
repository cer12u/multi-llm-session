import { expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient, WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { ScriptedModel, modelRequest } from '../packages/models/index.js';
import type { Context, QuestionAssessment } from '../packages/contracts/index.js';

/** Scripts specify only this test's replies; the production scheduler has no prescribed turn order. */
it('R6-QUESTION-007: three real HTTP Workers retain their separate interpretations and transport the owner state into the next request', async () => {
  const f=fixture(), app=buildServer(f.service,{timers:false});
  const [a,b,c]=f.service.agents(f.id), captured:Context[][]=[[],[],[]];
  let questionId='',answerId='';
  function assessment(context:Context,status:QuestionAssessment['status']) {
    const ids=[questionId,...answerId?[answerId]:[]];
    const originals=[...context.messages,...context.delta,...(context.retrieved??[]).flatMap(r=>r.messages)];
    const evidence=ids.map(id=>{const original=originals.find(m=>m.id===id);expect(original).toBeDefined();return {kind:'message',id,version:original!.revision};});
    return {agentId:c.id,sessionId:f.id,expectedVersion:context.self.privateState!.version,observationId:context.observation!.id,
      upsert:[{id:'c-understanding',kind:'question',text:'PRIVATE_C_QUESTION_ASSESSMENT',resume:null,evidence,
        question:{messageId:questionId,status,addressing:'explicit',addressedTo:[b.id],replyIds:answerId?[answerId]:[],topics:['予定','時刻']}}],remove:[]};
  }
  const scripts=[
    new ScriptedModel([
      JSON.stringify({decision:'SPEAK',intent:{act:'question',intent:'ask B',replyTo:null,addressedTo:[b.id]}}),
      JSON.stringify({decision:'DRAFT',text:'集合時刻と場所を教えてください。'}),
      (ctx:Context)=>{expect(ctx.questions.find(q=>q.messageId===questionId)?.status).toBe('unassessed');return JSON.stringify({decision:'ABSTAIN',reason:'A retains independent interpretation'});},
    ]),
    new ScriptedModel([
      (ctx:Context)=>{expect(ctx.messages.some(m=>m.id===questionId)).toBe(true);return JSON.stringify({decision:'SPEAK',intent:{act:'answer',intent:'provide only the place',replyTo:questionId,addressedTo:[]}});},
      JSON.stringify({decision:'DRAFT',text:'場所は駅前です。時刻はまだ確認中です。'}),
    ]),
    new ScriptedModel([
      (ctx:Context)=>{expect(ctx.messages.find(m=>m.id===questionId)?.addressedTo).toEqual([b.id]);return JSON.stringify({action:{decision:'ABSTAIN',reason:'listen to B first'},statePatch:assessment(ctx,'open')});},
      (ctx:Context)=>{expect(ctx.questions.find(q=>q.messageId===questionId)?.status).toBe('open');return JSON.stringify({action:{decision:'SPEAK',intent:{act:'comment',intent:'join after hearing B',replyTo:answerId,addressedTo:[]}},statePatch:assessment(ctx,'partial')});},
      (ctx:Context)=>{expect(ctx.self.privateState!.entries[0].question?.status).toBe('partial');return JSON.stringify({decision:'DRAFT',text:'場所は分かりました。時刻が決まったら私も参加します。'});},
    ]),
  ];
  try {
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing synthetic Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const workers=[a,b,c].map((agent,i)=>new WorkerRuntime(new CoreClient(base,f.config.workerTokens[agent.slot]),{},()=>({
      complete:async(kind,context)=>{captured[i].push(structuredClone(context));return scripts[i].complete(kind,context);},
    })));
    await Promise.all(workers.map(worker=>worker.register()));f.start();
    expect(await workers[0].once()).toBe(true);expect(await workers[0].once()).toBe(true);
    questionId=f.service.commitNext(f.id)!.id;
    expect(await workers[2].once()).toBe(true);
    expect(await workers[1].once()).toBe(true);expect(await workers[1].once()).toBe(true);
    answerId=f.service.commitNext(f.id)!.id;
    expect(await workers[2].once()).toBe(true);expect(await workers[2].once()).toBe(true);
    expect(f.service.commitNext(f.id)?.authorId).toBe(c.id);
    expect(await workers[0].once()).toBe(true);
    expect(captured.map(values=>values.length)).toEqual([3,2,3]);
    for(const i of [0,1])expect(JSON.stringify(captured[i])).not.toContain('PRIVATE_C_QUESTION_ASSESSMENT');
    const last=captured[2].at(-1)!;
    const body=modelRequest(f.config.profiles[0],'draft',last,{maxChars:f.config.defaults.contextChars});
    const messages=body.messages as {role:string;content:string}[];
    expect(messages.find(m=>m.role==='system')!.content).toContain('Questions are not globally resolved');
    expect(JSON.parse(messages.find(m=>m.role==='user')!.content)).toEqual(last);
    expect(f.service.snapshot(f.id).messages).toHaveLength(3);expect(f.service.session(f.id).call_count).toBe(8);
    expect(f.store.get<{answered_by:string|null}>('SELECT answered_by FROM pending_questions WHERE message_id=?',questionId)!.answered_by).toBeNull();
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('PRIVATE_C_QUESTION_ASSESSMENT');
  } finally { await app.close();f.close(); }
},20000);
