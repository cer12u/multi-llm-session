import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './helpers.js';
import {saveOwnerExperience,selection,replace} from './fixtures/membership.js';
import {buildServer} from '../apps/core/server.js';
import {CoreClient,WorkerRuntime} from '../apps/agent-worker/runtime.js';
import {operatorCommand} from '../apps/cli/operator-client.js';
import type {Context} from '../packages/contracts/index.js';

it('R7-MEMBERS-008: real HTTP pause/replacement fences in-flight inference; the same Worker receives a new empty owner, never retired memories',async()=>{
  const f=fixture(3,{memoryEvery:3,memoryFlushMs:86400000}),app=buildServer(f.service,{timers:false}),dir=mkdtempSync(join(tmpdir(),'membership-cli-'));
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(done=>{release=done;}),started=new Promise<void>(done=>{entered=done;});
  let pending:Promise<boolean>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;const captured:Context[]=[];
  try{
    const {owner}=saveOwnerExperience(f);
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing synthetic Core port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const worker=new WorkerRuntime(new CoreClient(base,f.config.workerTokens['worker-0']),{},()=>({complete:async(kind,context)=>{
      captured.push(structuredClone(context));expect(f.store.db.inTransaction).toBe(false);
      if(captured.length===1){entered();await gate;}
      return {text:JSON.stringify(kind==='memory'?{notes:[]}:{decision:'ABSTAIN',reason:'independent synthetic owner'}),usage:{inputTokens:11,outputTokens:3}};
    }}));
    await worker.register();f.say('応答を保留する合成入力');pending=worker.once();
    await Promise.race([started,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('MODEL_NOT_ENTERED')),5000);})]);clearTimeout(deadline);
    const headers={authorization:'Bearer '+f.config.adminToken,'content-type':'application/json'};
    const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});expect(response.status).toBe(200);return response.json();};
    await post(`/v1/sessions/${f.id}/pause`,{});
    const input=selection(f);input.participants[0]=replace(input.participants[0],{id:f.config.characters[1].id,version:1});
    const report=await post(`/v1/sessions/${f.id}/membership`,input);
    const newId=report.current.find((row:{agent:{slot:string}})=>row.agent.slot==='worker-0').agent.id;
    expect(newId).not.toBe(owner);expect(f.store.db.inTransaction).toBe(false);
    expect(f.store.all("SELECT * FROM llm_calls WHERE status='ABANDONED'").length).toBeGreaterThan(0);
    for(const path of ['memory','memory-page','archive?q=集合']){
      const response=await fetch(`${base}/v1/worker/agents/${owner}/${path}`,{headers:{authorization:'Bearer '+f.config.workerTokens['worker-0']}});
      expect(response.status).toBe(403);expect(await response.text()).not.toContain('OWNER_PRIVATE_');
    }
    release();await pending;pending=undefined;
    expect(f.service.session(f.id).bot_count).toBe(0);expect(f.service.agent(newId).error_count).toBe(0);
    await post(`/v1/sessions/${f.id}/resume`,{});expect(await worker.once()).toBe(true);
    expect(captured.at(-1)!.self.id).toBe(newId);expect(captured.at(-1)!.self.privateState!.entries).toEqual([]);
    expect(JSON.stringify(captured.at(-1))).not.toContain('OWNER_PRIVATE_');expect(f.service.agent(owner).state).toBe('retired');
    await post(`/v1/sessions/${f.id}/pause`,{});
    const env={CORE_URL:base,ADMIN_TOKEN:f.config.adminToken};
    for(const args of [['members',f.id],['episodes',f.id]]){const result=await operatorCommand(args,env);expect(result.ok).toBe(true);expect(result.body).not.toContain('OWNER_PRIVATE_');}
    const file=join(dir,'apply.json');writeFileSync(file,JSON.stringify(selection(f)));
    const before=f.service.session(f.id).call_count;expect((await operatorCommand(['members-apply',f.id,file],env)).ok).toBe(true);
    const clone=join(dir,'clone.json');writeFileSync(clone,JSON.stringify({title:'CLI定義複製',copy:'definitions-only'}));
    const result=await operatorCommand(['clone',f.id,clone],env);expect(result.ok).toBe(true);
    expect(f.service.snapshot(JSON.parse(result.body).id).messages).toEqual([]);expect(f.service.session(f.id).call_count).toBe(before);
  }finally{clearTimeout(deadline);release();await pending?.catch(()=>{});await app.close();f.close();rmSync(dir,{recursive:true,force:true});}
},20000);

it('R7-MEMBERS-009: membership and clone share the real operator/Host/Origin/CSRF boundary; episode indexes expose no private state',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false}),host=new URL(f.config.publicOrigin).host;
  try{
    const membership=`/v1/sessions/${f.id}/membership`,clone=`/v1/sessions/${f.id}/clone`;
    expect((await app.inject({method:'GET',url:membership,headers:{host}})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:membership,headers:{host,authorization:'Bearer '+f.config.viewerToken}})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url:membership,headers:{host:'invalid.test',authorization:'Bearer '+f.config.adminToken}})).statusCode).toBe(403);
    const login=await app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin:f.config.publicOrigin},payload:{token:f.config.adminToken}});
    expect(login.statusCode).toBe(200);const cookie='mls_session='+login.cookies[0].value;
    const valid={host,origin:f.config.publicOrigin,cookie,'x-csrf-token':login.json().csrf,'idempotency-key':randomUUID()};
    for(const [url,payload] of [[membership,selection(f)],[clone,{title:'new session',copy:'definitions-only'}]] as const){
      for(const headers of [{host,cookie},{...valid,origin:'https://invalid.test'},{...valid,'x-csrf-token':'wrong'},{host,authorization:'Bearer '+f.config.viewerToken}]){
        expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(403);
      }
    }
    expect((await app.inject({method:'POST',url:membership,headers:valid,payload:selection(f)})).statusCode).toBe(200);
    const episodes=await app.inject({method:'GET',url:`/v1/sessions/${f.id}/episodes`,headers:{host,authorization:'Bearer '+f.config.viewerToken}});
    expect(episodes.statusCode).toBe(200);expect(episodes.body).not.toContain('persona');expect(episodes.body).not.toContain('profile');
    expect(f.service.listSessions()).toHaveLength(1);expect(f.service.session(f.id).call_count).toBe(0);
    await app.inject({method:'POST',url:'/v1/auth/logout',headers:valid,payload:{}});
    expect((await app.inject({method:'GET',url:membership,headers:valid})).statusCode).toBe(401);
  }finally{await app.close();f.close();}
});
