import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient, WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { HttpModel } from '../packages/models/index.js';
import { ModelProfileSchema } from '../packages/contracts/index.js';

function state(text: string, evidence: string[]=['m0']) {
  return {upsert:[{id:'owner-question',kind:'question',text,evidence,resume:null}],remove:[]};
}
const profile=ModelProfileSchema.parse({id:'synthetic',provider:'openai',model:'synthetic',baseUrl:'https://synthetic.invalid/v1',authRequired:false});

it.each([3,5,8])('R2-LOOP-HTTP-001: %i independent workers consume complete ranges and pass only their own continuing state to subsequent model requests',async count=>{
  const f=fixture(count,{contextMessages:5,memoryEvery:3,memoryShareEvery:3});
  const app=buildServer(f.service,{timers:false});
  try{
    for(let i=0;i<21;i++)f.say(`共同で聞く合成入力 ${i}`);
    const expected=Array.from({length:21},(_,i)=>`共同で聞く合成入力 ${i}`);
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();
    if(!address||typeof address==='string')throw new Error('No test port');
    const captured:any[][]=Array.from({length:count},()=>[]);
    const workers=captured.map((inputs,index)=>new WorkerRuntime(
      new CoreClient(`http://127.0.0.1:${address.port}`,f.config.workerTokens[`worker-${index}`]),{},run=>new HttpModel(profile,undefined,async(_url,init)=>{
        const body=JSON.parse(String(init!.body)) as {messages:{role:string;content:string}[]};
        const context=JSON.parse(body.messages.find(m=>m.role==='user')!.content);inputs.push(context);
        const action=run.kind==='memory'?{notes:[]}:{decision:'ABSTAIN',reason:'入力配送を検査する合成応答'};
        const result={type:'result',action,state:context.self.state.length?null:state(`private-worker-${index}-held-question`)};
        return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
      })));
    await Promise.all(workers.map(w=>w.register()));f.start();
    let quiescent=false;
    for(let cycle=0;cycle<30;cycle++){
      const did=await Promise.all(workers.map(w=>w.once()));
      expect(f.service.agents(f.id).every(a=>a.error_count===0)).toBe(true);
      if(did.every(x=>!x)){quiescent=true;break;}
    }
    expect(quiescent).toBe(true);
    for(let index=0;index<count;index++){
      const contexts=captured[index];expect(contexts.length).toBeGreaterThan(2);
      for(const purpose of ['observation','memory']){
        const entries=contexts.filter(c=>c.delivery?.purpose===purpose).flatMap(c=>c.delivery.entries.map((e:any)=>c.messages.find((m:any)=>m.ref===e.ref)?.text).filter(Boolean));
        expect(entries).toEqual(expected);
      }
      expect(contexts[0].self.state).toHaveLength(0);
      expect(contexts[1].self.state[0].text).toBe(`private-worker-${index}-held-question`);
      for(let other=0;other<count;other++)if(other!==index)expect(JSON.stringify(contexts)).not.toContain(`private-worker-${other}-held-question`);
    }
    expect(f.service.session(f.id).bot_count).toBe(0);
    expect(JSON.stringify(f.service.snapshot(f.id))).not.toContain('held-question');
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('held-question');
  }finally{await app.close();f.close();}
},60000);

it('R2-LOOP-HTTP-002: input changed during inference is cancelled and retried as new input, not a provider outage or repeated unmetered run',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    const source=f.say('変更前の説明');let calls=0;const contexts:any[]=[],runIds:string[]=[];
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No port');
    const worker=new WorkerRuntime(new CoreClient(`http://127.0.0.1:${address.port}`,f.config.workerTokens['worker-0']),{},run=>{
      runIds.push(run.id);
      return new HttpModel(profile,undefined,async(_url,init)=>{
        const body=JSON.parse(String(init!.body));const context=JSON.parse(body.messages.find((m:{role:string})=>m.role==='user').content);
        contexts.push(context);calls++;
        if(calls===1)f.service.changeMessage(f.id,source.id,'変更後の説明',randomUUID());
        const result={type:'result',action:{decision:'ABSTAIN',reason:'本人の理解を更新'},state:state('根拠に結びつく理解')};
        return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
      });
    });
    await worker.register();f.start();await worker.once();
    expect(f.service.agents(f.id)[0].error_count).toBe(0);
    expect(f.store.all('SELECT * FROM agent_input_receipts')).toHaveLength(0);
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',runIds[0])!.state).toBe('CANCELLED');
    await worker.once();expect(runIds[1]).not.toBe(runIds[0]);expect(calls).toBe(2);
    expect(contexts[1].messages.some((m:any)=>m.text==='変更後の説明')).toBe(true);
    expect(f.service.session(f.id).call_count).toBe(2);expect(f.store.all('SELECT * FROM agent_input_receipts')).toHaveLength(1);
    expect(f.service.agents(f.id)[0].error_count).toBe(0);
  }finally{await app.close();f.close();}
},20000);

it('R2-LOOP-HTTP-003: invented request-local evidence handles fail the model contract and respect retry accounting',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    f.say('本人の入力');let calls=0;
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No port');
    const worker=new WorkerRuntime(new CoreClient(`http://127.0.0.1:${address.port}`,f.config.workerTokens['worker-0']),{},()=>new HttpModel(profile,undefined,async()=>{
      calls++;const result={type:'result',action:{decision:'ABSTAIN',reason:'試験'},state:state('本人の疑問',['m999'])};
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
    }));
    await worker.register();f.start();await worker.once();
    expect(f.service.agents(f.id)[0].last_error).toBe('FORMAT_ERROR');
    expect(f.store.all("SELECT * FROM runs WHERE state='ACTIVE'")).toHaveLength(0);
    expect(await worker.once()).toBe(false);expect(calls).toBe(2);
    f.advance(10000);await worker.once();expect(calls).toBe(4);expect(f.service.session(f.id).call_count).toBe(4);
    expect(f.service.agents(f.id)[0].error_count).toBeGreaterThan(0);
  }finally{await app.close();f.close();}
},20000);
