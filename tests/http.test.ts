import { afterEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient,WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { ScriptedModel } from '../packages/models/index.js';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function setup(){const f=fixture();const app=buildServer(f.service,{timers:false});cleanup.push(async()=>{await app.close();f.close();});return {...f,app};}
const host='127.0.0.1:3000';

describe('authenticated API and independent worker HTTP transport',()=>{
  it('requires login and blocks invalid Host / foreign Origin requests',async()=>{
    const f=setup();expect((await f.app.inject({url:'/v1/sessions',headers:{host}})).statusCode).toBe(401);
    expect((await f.app.inject({url:'/healthz',headers:{host:'attacker.example'}})).statusCode).toBe(403);
    expect((await f.app.inject({url:'/healthz',headers:{host,origin:'https://attacker.example'}})).statusCode).toBe(403);
  });
  it('keeps viewer and worker credentials out of operator routes',async()=>{
    const f=setup(),viewer={host,authorization:'Bearer '+f.config.viewerToken};
    expect((await f.app.inject({url:`/v1/sessions/${f.id}/snapshot`,headers:viewer})).statusCode).toBe(200);
    expect((await f.app.inject({url:`/v1/sessions/${f.id}/diagnostics`,headers:viewer})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url:'/v1/sessions',headers:{...viewer,'idempotency-key':randomUUID()},payload:f.input})).statusCode).toBe(403);
    expect((await f.app.inject({url:'/v1/sessions',headers:{host,authorization:'Bearer '+f.config.workerTokens['worker-0']}})).statusCode).toBe(401);
    const view=(await f.app.inject({url:'/v1/characters',headers:viewer})).json();expect(view[0]).not.toHaveProperty('persona');
  });
  it('requires Origin and CSRF for cookie-authenticated writes',async()=>{
    const f=setup();const login=await f.app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin:f.config.publicOrigin},payload:{token:f.config.adminToken}});
    expect(login.statusCode).toBe(200);const cookie=String(login.headers['set-cookie']).split(';')[0],csrf=login.json().csrf;
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');expect(String(login.headers['set-cookie'])).toContain('SameSite=Strict');
    const request={method:'POST' as const,url:`/v1/sessions/${f.id}/messages`,payload:{text:'ブラウザー入力'}};
    expect((await f.app.inject({...request,headers:{host,cookie,'idempotency-key':randomUUID()}})).statusCode).toBe(403);
    expect((await f.app.inject({...request,headers:{host,cookie,origin:f.config.publicOrigin,'idempotency-key':randomUUID()}})).statusCode).toBe(403);
    const headers={host,cookie,origin:f.config.publicOrigin,'x-csrf-token':csrf,'idempotency-key':randomUUID()};
    const one=await f.app.inject({...request,headers}),two=await f.app.inject({...request,headers});expect(one.statusCode).toBe(200);expect(two.json().id).toBe(one.json().id);
  });
  it('rejects a worker reading another instance memory even with a valid instance ID',async()=>{
    const f=setup(),other=f.service.agents(f.id)[1];
    const response=await f.app.inject({url:`/v1/worker/agents/${other.id}/memory`,headers:{host,authorization:'Bearer '+f.config.workerTokens['worker-0']}});
    expect(response.statusCode).toBe(403);
  });
  it('runs decision, draft and publication through the actual HTTP worker interface',async()=>{
    const f=setup();await f.app.listen({host:'127.0.0.1',port:0});const port=(f.app.server.address() as {port:number}).port;f.config.publicOrigin=`http://127.0.0.1:${port}`;
    const runtime=new WorkerRuntime(new CoreClient(f.config.publicOrigin,f.config.workerTokens['worker-0']),{});
    await runtime.register();f.say();f.start();expect(await runtime.once()).toBe(true);expect(await runtime.once()).toBe(true);
    f.service.commitNext(f.id);expect(f.service.snapshot(f.id).messages.some(m=>m.text.includes('模擬応答'))).toBe(true);
  });
  it('repairs malformed model JSON once, counting both calls',async()=>{
    const f=setup();await f.app.listen({host:'127.0.0.1',port:0});f.config.publicOrigin=`http://127.0.0.1:${(f.app.server.address() as {port:number}).port}`;
    const model=new ScriptedModel(['bad JSON','{"decision":"ABSTAIN","reason":"listen"}']);
    const runtime=new WorkerRuntime(new CoreClient(f.config.publicOrigin,f.config.workerTokens['worker-0']),{},()=>model);
    await runtime.register();f.start();await runtime.once();expect(f.service.session(f.id).call_count).toBe(2);expect(f.service.agents(f.id)[0].error_count).toBe(0);
  });
  it('persists FORMAT_ERROR instead of silently treating invalid output as abstention',async()=>{
    const f=setup();await f.app.listen({host:'127.0.0.1',port:0});f.config.publicOrigin=`http://127.0.0.1:${(f.app.server.address() as {port:number}).port}`;
    const runtime=new WorkerRuntime(new CoreClient(f.config.publicOrigin,f.config.workerTokens['worker-0']),{},()=>new ScriptedModel(['bad JSON','still bad']));
    await runtime.register();f.start();await runtime.once();expect(f.service.session(f.id).activity).toBe('DEGRADED');
    expect(f.store.get<{n:number}>("SELECT COUNT(*) n FROM traces WHERE code='FORMAT_ERROR'")!.n).toBe(1);
  });
  it('replays persisted SSE events after the snapshot/connection gap',async()=>{
    const f=setup();await f.app.listen({host:'127.0.0.1',port:0});f.config.publicOrigin=`http://127.0.0.1:${(f.app.server.address() as {port:number}).port}`;
    const cursor=f.service.snapshot(f.id).cursor,m=f.say('購読前に確定したメッセージ');const controller=new AbortController();
    try{
      const response=await fetch(`${f.config.publicOrigin}/v1/sessions/${f.id}/events?cursor=${encodeURIComponent(cursor)}`,{headers:{authorization:'Bearer '+f.config.viewerToken},signal:controller.signal});
      expect(response.status).toBe(200);const reader=response.body!.getReader();let data='';
      for(let i=0;i<5&&!data.includes(m.id);i++){const result=await reader.read();if(result.done)break;data+=new TextDecoder().decode(result.value);}
      expect(data).toContain(m.id);expect(data).toContain('購読前に確定したメッセージ');
    }finally{controller.abort();}
  });
});
