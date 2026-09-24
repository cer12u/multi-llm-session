import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { backupDatabase, restoreDatabase } from '../packages/storage-sqlite/maintenance.js';
import type { ClaimedRun, Context, Intent, PrivateStateEntry, QuestionAssessment } from '../packages/contracts/index.js';

type Fixture = ReturnType<typeof fixture>;
function claim(f: Fixture, slot = 'worker-2') {
  const run = f.claim(slot); expect(run).not.toBeNull(); return run!;
}
function source(run: ClaimedRun, id: string) {
  const found = [...run.context.messages, ...run.context.delta, ...(run.context.retrieved ?? []).flatMap(r => r.messages)].find(m => m.id === id);
  expect(found, 'assessment requires the actual original, not just a question hint').toBeDefined(); return found!;
}
function entry(run: ClaimedRun, id: string, question: QuestionAssessment): PrivateStateEntry {
  return { id, kind: 'question', text: 'PRIVATE_QUESTION_' + id, question, resume: null,
    evidence: [question.messageId, ...question.replyIds].map(id => ({kind:'message',id,version:source(run,id).revision})) };
}
function patch(run: ClaimedRun, upsert: PrivateStateEntry[]) {
  return { agentId:run.context.self.id,sessionId:run.context.self.privateState!.sessionId,
    expectedVersion:run.context.self.privateState!.version,observationId:run.context.observation!.id,upsert,remove:[] };
}
function hold(f: Fixture, run: ClaimedRun, entries: PrivateStateEntry[]) {
  f.finish(run,{action:{decision:'ABSTAIN',reason:'synthetic owner interpretation'},statePatch:patch(run,entries)});
}
function post(f: Fixture, slot: string, text: string, intent: Intent) {
  const run=claim(f,slot);expect(run.kind).toBe('decide');
  f.finish(run,{decision:'SPEAK',intent});const draft=claim(f,slot);expect(draft.kind).toBe('draft');
  f.finish(draft,{decision:'DRAFT',text});const message=f.service.commitNext(f.id);expect(message).not.toBeNull();return message!;
}
function state(f: Fixture, slot = 'worker-2') {
  const agent=f.service.agents(f.id).find(a=>a.slot===slot)!;
  return JSON.parse(f.store.get<{entries_json:string}>('SELECT entries_json FROM agent_private_states WHERE agent_id=?',agent.id)!.entries_json) as PrivateStateEntry[];
}

it('R6-QUESTION-001: C hears A addressing B; acknowledgement, partial and confirmed answers remain C-owned and C can later participate',()=>{
  const f=fixture();
  try {
    f.start();const [,b,c]=f.service.agents(f.id);
    const q=post(f,'worker-0','集合する場所と時刻は？',{act:'question',intent:'場所と時刻を尋ねる',replyTo:null,addressedTo:[b.id]});
    const first=claim(f);expect(first.context.questions.find(x=>x.messageId===q.id)).toMatchObject({addressedTo:[b.id],status:'unassessed'});
    const question:QuestionAssessment={messageId:q.id,status:'open',addressing:'explicit',addressedTo:[b.id],replyIds:[],topics:['集合場所','集合時刻']};
    hold(f,first,[entry(first,'c-question',question)]);
    const ack=post(f,'worker-1','了解、場所は駅前です。時刻は確認します。',{act:'answer',intent:'場所のみ回答',replyTo:q.id,addressedTo:[]});
    const second=claim(f);expect(second.context.questions.find(x=>x.messageId===q.id)?.status).toBe('open');
    const partial={...question,status:'partial' as const,replyIds:[ack.id]};hold(f,second,[entry(second,'c-question',partial)]);
    expect(f.store.get<{answered_by:string|null}>('SELECT answered_by FROM pending_questions WHERE message_id=?',q.id)!.answered_by).toBeNull();
    expect(state(f)[0].question?.status).toBe('partial');expect(state(f,'worker-1')).toEqual([]);
    f.say('時刻も教えてください');
    const answer=post(f,'worker-1','集合は駅前に16時です。',{act:'answer',intent:'時刻も回答',replyTo:q.id,addressedTo:[]});
    const third=claim(f);expect(third.context.questions.find(x=>x.messageId===q.id)?.status).toBe('partial');
    const resolved={...question,status:'resolved' as const,replyIds:[answer.id]};
    f.finish(third,{action:{decision:'SPEAK',intent:{act:'comment',intent:'聞いた回答を受けて自分も参加',replyTo:answer.id,addressedTo:[]}},statePatch:patch(third,[entry(third,'c-question',resolved)])});
    const draft=claim(f);expect(draft.context.self.privateState!.entries[0].question?.status).toBe('resolved');
    f.finish(draft,{decision:'DRAFT',text:'その場所と時刻なら私も参加できます。'});
    expect(f.service.commitNext(f.id)?.authorId).toBe(c.id);
    const a=claim(f,'worker-0');expect(a.context.questions.find(x=>x.messageId===q.id)?.status).toBe('unassessed');
    expect(JSON.stringify(a.context)).not.toContain('PRIVATE_QUESTION_c-question');
    f.finish(a,{decision:'ABSTAIN',reason:'independent unassessed owner'});
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('PRIVATE_QUESTION_');
  } finally { f.close(); }
});

it('R6-QUESTION-002: address, name mention, unknown question and inferred multi-person targets are not conflated',()=>{
  const f=fixture();
  try {
    const [a,b]=f.service.agents(f.id);
    const mention=f.say('ナギが話していた出来事を思い出した');
    const directed=f.say('ありがとう',[b.id]);
    expect(mention.act).toBe('comment');expect(directed.act).toBe('comment');
    const vague=f.service.humanMessage(f.id,{text:'それはいつ？',act:'question'},randomUUID());f.start();
    const run=claim(f);expect(run.context.questions.some(q=>q.messageId===mention.id||q.messageId===directed.id)).toBe(false);
    expect(run.context.questions.find(q=>q.messageId===vague.id)).toMatchObject({addressedTo:[],addressing:'unknown',status:'unassessed'});
    const question:QuestionAssessment={messageId:vague.id,status:'open',addressing:'inferred',addressedTo:[a.id,b.id],replyIds:[],topics:['時刻']};
    hold(f,run,[entry(run,'inferred',question)]);f.say('別の出来事についても話す');
    const next=claim(f);expect(next.context.questions.find(q=>q.messageId===vague.id)).toMatchObject({addressedTo:[],inferredAddressees:[a.id,b.id],addressing:'inferred'});
    f.finish(next,{decision:'ABSTAIN',reason:'keep uncertainty'});
    const peer=claim(f,'worker-0');expect(peer.context.questions.find(q=>q.messageId===vague.id)).toMatchObject({addressing:'unknown',inferredAddressees:[]});
    f.finish(peer,{decision:'ABSTAIN',reason:'no shared private inference'});
  } finally { f.close(); }
});

it('R6-QUESTION-003: unobserved/foreign references, changed explicit addressees and duplicate assessments roll back the whole result',()=>{
  const f=fixture();
  try {
    const [a,b]=f.service.agents(f.id);
    const q=f.service.humanMessage(f.id,{text:'複数人への質問',act:'question',addressedTo:[a.id,b.id]},randomUUID());
    const reply=f.say('一部の回答');
    const other=f.service.createSession(f.input,randomUUID()).id;
    const foreign=f.service.humanMessage(other,{text:'別セッションの文'},randomUUID());f.start();const run=claim(f);
    const question:QuestionAssessment={messageId:q.id,status:'open',addressing:'explicit',addressedTo:[a.id,b.id],replyIds:[],topics:['未解決']};
    const valid=entry(run,'checked',question);
    const invalid:PrivateStateEntry[][]=[
      [{...valid,question:{...question,addressedTo:[b.id]}}],
      [{...valid,question:{...question,addressing:'inferred'}}],
      [{...valid,question:{...question,status:'resolved'}}],
      [{...valid,question:{...question,status:'partial',replyIds:[reply.id]}}],
      [{...valid,question:{...question,replyIds:[foreign.id]},evidence:[...valid.evidence,{kind:'message',id:foreign.id,version:foreign.revision}]}],
      [{...valid,question:{...question,messageId:randomUUID()}}],
      [valid,{...valid,id:'duplicate'}],
    ];
    const recorded=f.service.reserveCall('worker-2',run.workerEpoch,run.id,run.token,randomUUID(),'primary');
    f.service.finishCall('worker-2',run.id,run.token,recorded.id,{inputTokens:null,outputTokens:null},null);
    for (const entries of invalid) {
      expect(()=>f.service.completeRun('worker-2',run.workerEpoch,run.id,run.token,{action:{decision:'SPEAK',intent:{act:'comment',intent:'must roll back',replyTo:null,addressedTo:[]}},statePatch:patch(run,entries)})).toThrow();
      expect(state(f)).toEqual([]);expect(f.store.all('SELECT * FROM candidates')).toHaveLength(0);
      expect(f.store.all('SELECT * FROM agent_input_receipts WHERE agent_id=?',run.context.self.id)).toHaveLength(0);
      expect(f.store.all('SELECT * FROM agent_state_updates WHERE agent_id=?',run.context.self.id)).toHaveLength(0);
    }
    f.service.completeRun('worker-2',run.workerEpoch,run.id,run.token,{action:{decision:'ABSTAIN',reason:'valid owner assessment'},statePatch:patch(run,[valid])});
    expect(state(f)[0].question).toEqual(question);
  } finally { f.close(); }
});

it('R6-QUESTION-004: two overlapping topics and owner answer states survive online backup/restore; deleting answer evidence reopens the source question',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'question-recovery-')),f=fixture(3,{},join(dir,'live.sqlite'));let db:Store|undefined;
  try {
    const q1=f.service.humanMessage(f.id,{text:'旅行はいつ？',act:'question'},randomUUID());
    const q2=f.service.humanMessage(f.id,{text:'旅行先の天気は？',act:'question'},randomUUID());
    f.start();const first=claim(f);
    const base={status:'open' as const,addressing:'unknown' as const,addressedTo:[],replyIds:[]};
    hold(f,first,[entry(first,'time',{...base,messageId:q1.id,topics:['旅行','時刻']}),entry(first,'weather',{...base,messageId:q2.id,topics:['旅行','天気']})]);
    const answer=f.service.humanMessage(f.id,{text:'天気予報は晴れです。確認してみます。',replyTo:q2.id,act:'answer'},randomUUID());
    const second=claim(f);hold(f,second,[entry(second,'weather',{...base,messageId:q2.id,status:'awaiting_confirmation',replyIds:[answer.id],topics:['旅行','天気']})]);
    expect(state(f).find(e=>e.id==='time')?.question?.status).toBe('open');
    f.service.lifecycle(f.id,'pause',randomUUID());const expected=state(f);
    const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored.sqlite');await backupDatabase(f.config.dbPath,backup);await restoreDatabase(backup,restored);
    db=new Store(restored);const service=new SessionService(db,{...f.config,dbPath:restored},f.now,()=>0);service.recover();
    const owner=service.agents(f.id)[2];expect(JSON.parse(db.get<{entries_json:string}>('SELECT entries_json FROM agent_private_states WHERE agent_id=?',owner.id)!.entries_json)).toEqual(expected);
    service.changeMessage(f.id,answer.id,null,randomUUID());
    const remaining=JSON.parse(db.get<{entries_json:string}>('SELECT entries_json FROM agent_private_states WHERE agent_id=?',owner.id)!.entries_json) as PrivateStateEntry[];
    expect(remaining.map(e=>e.id)).toEqual(['time']);expect(db.all("SELECT * FROM agent_state_updates WHERE kind='SOURCE_INVALIDATED'").length).toBeGreaterThan(0);
    service.lifecycle(f.id,'resume',randomUUID());const epoch=service.registerWorker(owner.slot).epoch,next=service.claim(owner.slot,epoch)!;
    expect(next.context.questions.find(q=>q.messageId===q2.id)?.status).toBe('unassessed');
    expect(JSON.stringify(next.context)).not.toContain(answer.text);expect(service.session(f.id).lifecycle).toBe('RUNNING');
  } finally { db?.close();f.close();rmSync(dir,{recursive:true,force:true}); }
},20000);

it('R6-QUESTION-005: a silent/faulted addressee does not hold another participant beyond finite defer/grace',()=>{
  const f=fixture(3,{replyGraceMs:200});
  try {
    const [,b,c]=f.service.agents(f.id);
    const q=f.service.humanMessage(f.id,{text:'都合はどう？',act:'question',addressedTo:[b.id]},randomUUID());f.start();
    const waiting=claim(f);f.finish(waiting,{decision:'DEFER',reason:'give the addressee an opportunity',defer:{kind:'answer_from',agentId:b.id,afterMs:100}});
    const failed=claim(f,'worker-1');f.service.failRun('worker-1',failed.workerEpoch,failed.id,failed.token,'AUTH_ERROR');
    f.advance(101);const run=claim(f);expect(run.kind).toBe('decide');
    f.finish(run,{decision:'SPEAK',intent:{act:'comment',intent:'I have an independent contribution',replyTo:q.id,addressedTo:[]}});
    const draft=claim(f);f.finish(draft,{decision:'DRAFT',text:'私は午後なら都合がつきます。'});
    expect(f.service.commitNext(f.id)).toBeNull();f.advance(100);
    expect(f.service.commitNext(f.id)?.authorId).toBe(c.id);expect(f.service.agent(b.id).error_count).toBe(1);
    expect(f.store.get<{answered_by:string|null}>('SELECT answered_by FROM pending_questions WHERE message_id=?',q.id)!.answered_by).toBeNull();
  } finally { f.close(); }
});

it('R6-QUESTION-006: an old owner-interpreted question stays indexed past the recent question window without exposing it as observed evidence',()=>{
  const f=fixture(3,{contextMessages:5});
  try {
    const original=f.say('それはいつ？');f.start();const first=claim(f);
    hold(f,first,[entry(first,'old',{messageId:original.id,status:'open',addressing:'unknown',addressedTo:[],replyIds:[],topics:['過去の話題']})]);
    for(let i=0;i<16;i++)f.service.humanMessage(f.id,{text:'別の質問 '+i,act:'question'},randomUUID());
    for(let i=0;i<20;i++){
      const run=f.claim('worker-2');if(!run)break;f.finish(run,run.kind==='memory'?{notes:[]}:{decision:'ABSTAIN',reason:'chronological catch-up'});
    }
    f.say('以前の話題へ戻る');const next=claim(f);
    expect(next.context.questions.some(q=>q.messageId===original.id)).toBe(true);
    expect(next.context.self.privateState!.entries.some(e=>e.question?.messageId===original.id)).toBe(true);
    expect(next.context.observation!.messages.some(ref=>ref.id===original.id)).toBe(false);
    const old=state(f)[0];expect(()=>hold(f,next,[{...old,text:'unobserved update is not allowed'}])).toThrow('UNOBSERVED_STATE_EVIDENCE');
    const withOriginal=f.service.retrieve('worker-2',next.workerEpoch,next.id,next.token,'old-question-lookup', [{kind:'message',query:original.id,cursor:null}]);
    const refreshed={...next,context:withOriginal} as ClaimedRun;
    const fetched=f.service.reserveCall('worker-2',next.workerEpoch,next.id,next.token,randomUUID(),'lookup');
    f.service.finishCall('worker-2',next.id,next.token,fetched.id,{inputTokens:null,outputTokens:null},null);
    f.service.completeRun('worker-2',next.workerEpoch,next.id,next.token,{action:{decision:'ABSTAIN',reason:'fetched original'},statePatch:patch(refreshed,[{...old,text:'old original was actually fetched'}])});
    expect(state(f)[0].text).toBe('old original was actually fetched');
  } finally { f.close(); }
});
