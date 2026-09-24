import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {ModelProfileSchema} from '../packages/contracts/index.js';
import {HttpModel,modelRequest,estimatedRequestTokens} from '../packages/models/index.js';
import {boundedContext} from '../packages/models/context-budget.js';

it('R5-BUDGET-020: the captured HTTP body matches acknowledged context and includes schema, framing and reserved output in its conservative budget',async()=>{
  const f=fixture();
  try{
    const original=f.say('日本語の原文と絵文字🌸、引用符"、改行\nを黙って落とさない');
    const p=ModelProfileSchema.parse({id:'budget-http',provider:'openai',model:'synthetic',baseUrl:'https://synthetic.invalid/v1',authRequired:false,contextWindowTokens:65536,jsonMode:'none'});
    f.config.allowLive=true;f.service.putModelProfile(p);
    const id=f.service.createSession({...f.input,participants:f.input.participants.map(a=>({...a,profileId:p.id}))},randomUUID()).id;
    const source=f.service.humanMessage(id,{text:original.text},randomUUID());f.service.lifecycle(id,'start',randomUUID());
    const run=f.claim()!;expect(run.context.inputBudget).toMatchObject({method:'utf8-upper-bound',tokenizer:'unknown',maxTokens:65536,reservedOutputTokens:p.maxOutputTokens});
    let body:Record<string,unknown>|undefined;
    const model=new HttpModel(p,undefined,async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:'{"decision":"ABSTAIN","reason":"fixture"}'}}]}));});
    await model.complete(run.kind,run.context,{signal:new AbortController().signal,maxChars:run.contextChars});
    expect(body).toEqual(modelRequest(p,run.kind,run.context,{maxChars:run.contextChars}));
    const supplied=JSON.parse((body!.messages as {role:string;content:string}[]).find(m=>m.role==='user')!.content);
    expect(supplied).toEqual(run.context);expect(supplied.messages.some((m:{id:string;revision:number;text:string})=>m.id===source.id&&m.revision===source.revision&&m.text===source.text)).toBe(true);
    expect(estimatedRequestTokens(body!)+p.maxOutputTokens).toBeLessThanOrEqual(run.context.inputBudget!.maxTokens);
    const worst=modelRequest(p,run.kind,run.context,{maxChars:run.contextChars,repair:'\u0000'.repeat(2000)});
    expect(estimatedRequestTokens(worst)+p.maxOutputTokens).toBeLessThanOrEqual(run.context.inputBudget!.maxTokens);
    expect(f.service.session(id).call_count).toBe(0); // The standalone adapter test uses only a synthetic fetcher.
  }finally{f.close();}
});

it('R5-BUDGET-021: an unfit mandatory input/schema is a bounded context failure, not acknowledged or retried indefinitely',()=>{
  const f=fixture(3,{contextTokens:2048});
  try{
    f.say('必須入力を飛ばさない');f.start();
    for(let i=0;i<4;i++)expect(f.claim()).toBeNull();
    const owner=f.service.agents(f.id)[0];expect(owner.last_error).toBe('CONTEXT_LIMIT');
    expect(owner.error_count).toBeGreaterThan(f.config.defaults.maxRetries);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE agent_id=?',owner.id)).toHaveLength(0);
    expect(f.store.get<{observed_input:number}>('SELECT observed_input FROM agent_input_cursors WHERE agent_id=?',owner.id)!.observed_input).toBe(0);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});

it('R5-BUDGET-022: mandatory review evidence and private state are retained or explicitly rejected rather than trimmed after acknowledgment',()=>{
  const f=fixture();
  try{
    f.say('元の入力');f.start();const run=f.claim()!;
    const context={...run.context,delta:Array.from({length:20},(_,i)=>({...run.context.messages[0],id:randomUUID(),text:'必須の再確認差分'.repeat(100)+i})),coverage:{fromRevision:0,throughRevision:20,targetRevision:20,complete:true}};
    const before=structuredClone(context);expect(()=>boundedContext(context,'review',run.profile,{...f.config.defaults,contextChars:4000})).toThrow('CONTEXT_LIMIT');
    expect(context).toEqual(before);expect(context.delta).toHaveLength(20);
  }finally{f.close();}
});
