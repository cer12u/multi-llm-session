import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';
import {ModelProfileSchema} from '../packages/contracts/index.js';
import {operations} from '../packages/session-service/operations.js';
import {providerScope} from '../packages/provider-state/index.js';
import {hash} from '../packages/domain/index.js';
import {operatorCommand} from '../apps/cli/operator-client.js';

it('R8-PROFILE-002: registered catalog/version routes retain frozen profiles, report references only and reject incompatible capabilities',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  const headers={host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.adminToken};
  vi.stubEnv('SYNTHETIC_PROFILE_KEY','synthetic-secret-never-returned');
  try{
    const profile=ModelProfileSchema.parse({id:'configured',provider:'openai',model:'first',baseUrl:'https://synthetic.invalid/v1',apiKeyEnv:'SYNTHETIC_PROFILE_KEY',capabilities:{jsonModes:['json'],outputTokenParameter:'max_completion_tokens',temperatureSupported:false,usage:'unknown'},jsonMode:'json'});
    const saved=await app.inject({method:'POST',url:'/v1/model-profiles',headers,payload:profile});expect(saved.statusCode).toBe(200);
    f.config.allowLive=true;
    const id=f.service.createSession({...f.input,participants:f.input.participants.map(p=>({...p,profileId:profile.id}))},randomUUID()).id;
    expect((await app.inject({method:'POST',url:'/v1/model-profiles',headers,payload:{...profile,version:2,model:'second'}})).statusCode).toBe(200);
    const catalog=await app.inject({method:'GET',url:'/v1/provider-catalog',headers});expect(catalog.statusCode).toBe(200);
    expect(catalog.body).not.toContain('synthetic-secret-never-returned');
    expect(catalog.json().find((r:{profile:{id:string}})=>r.profile.id===profile.id)).toMatchObject({profile:{version:2},credentialConfiguredOnCore:true});
    const versions=await app.inject({method:'GET',url:'/v1/model-profiles/configured/versions',headers});
    expect(versions.json().map((r:{profile:{version:number}})=>r.profile.version)).toEqual([2,1]);
    const state=await app.inject({method:'GET',url:`/v1/sessions/${id}/operations`,headers});expect(state.statusCode).toBe(200);
    expect(state.json().agents[0]).toMatchObject({reason:'NOT_STARTED',latestVersion:2,frozen:{hash:hash(profile),profile:{version:1,model:'first'}}});
    expect(state.body).not.toContain('synthetic-secret-never-returned');expect(state.body).not.toContain(f.config.characters[0].persona);
    for(const bad of [
      {...profile,version:3,jsonMode:'schema'},
      {...profile,version:3,capabilities:{...profile.capabilities,outputTokenParameter:'num_predict'}},
      {...profile,version:3,baseUrl:'https://user:password@synthetic.invalid/v1'},
      {...profile,version:3,baseUrl:'https://synthetic.invalid/v1?key=private'},
      {...profile,version:3,apiKey:'forbidden-secret-field'},
    ])expect((await app.inject({method:'POST',url:'/v1/model-profiles',headers,payload:bad})).statusCode).toBe(422);
    expect((await app.inject({method:'POST',url:'/v1/model-profiles',headers,payload:{...profile,model:'illegal-overwrite'}})).statusCode).toBe(409);
    expect(f.service.session(id).call_count).toBe(0);
    const plain=ModelProfileSchema.parse({id:'legacy',provider:'mock',model:'old'});expect(plain).not.toHaveProperty('capabilities');
    f.service.putModelProfile(plain);expect(f.store.get<{hash:string}>('SELECT hash FROM model_profiles WHERE id=?',plain.id)!.hash).toBe(hash(plain));
  }finally{vi.unstubAllEnvs();await app.close();f.close();}
});

it('R8-RECOVERY-002: operations distinguish voluntary silence, observation, deferral and lifecycle without invoking a model',()=>{
  const f=fixture();
  try{
    expect(operations(f.service,f.id).agents[0].reason).toBe('NOT_STARTED');f.say();f.start();
    const initial=f.claim()!;expect(operations(f.service,f.id).agents[0].reason).toBe('THINKING');
    f.finish(initial,{decision:'ABSTAIN',reason:'voluntary silence'});
    expect(operations(f.service,f.id).agents[0].reason).toBe('QUIET');
    f.say('a question');const waiting=f.claim()!,target=f.service.agents(f.id)[1].id;
    f.finish(waiting,{decision:'DEFER',reason:'await reply',defer:{kind:'answer_from',agentId:target,afterMs:10000}});
    expect(operations(f.service,f.id).agents[0]).toMatchObject({reason:'WAITING_REPLY',waitingFor:target,nextOpportunityAt:f.now()+10000});
    f.say('listen without publishing');const observe=f.claim()!;expect(observe.kind).toBe('observe');
    expect(operations(f.service,f.id).agents[0].reason).toBe('OBSERVING');f.finish(observe,{decision:'ABSTAIN',reason:'continue listening'});
    const calls=f.service.session(f.id).call_count;for(let i=0;i<20;i++)operations(f.service,f.id);expect(f.service.session(f.id).call_count).toBe(calls);
    f.service.lifecycle(f.id,'pause',randomUUID());expect(operations(f.service,f.id).agents[0].reason).toBe('SESSION_PAUSED');
    f.service.setAgentEnabled(f.id,initial.context.self.id,false,randomUUID());expect(operations(f.service,f.id).agents[0].reason).toBe('AGENT_DISABLED');
    f.service.lifecycle(f.id,'end',randomUUID());expect(operations(f.service,f.id).agents.every(a=>a.reason==='SESSION_ENDED')).toBe(true);
  }finally{f.close();}
});

it('R8-RECOVERY-003: exact-version HTTP retry targets the pinned scope, retains other outages and cannot revive an ended or budget-paused session',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});const headers={host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.adminToken};
  try{
    f.config.allowLive=true;const first=ModelProfileSchema.parse({id:'versioned',provider:'openai',model:'one',baseUrl:'https://one.invalid/v1',authRequired:false});
    f.service.putModelProfile(first);const id=f.service.createSession({...f.input,participants:f.input.participants.map(p=>({...p,profileId:first.id}))},randomUUID()).id;
    const second={...first,version:2,baseUrl:'https://two.invalid/v1'};f.service.putModelProfile(second);
    f.service.providers.finish(first,'old-auth','AUTH_ERROR');f.service.providers.finish(second,'latest-auth','AUTH_ERROR');
    const key=randomUUID(),url='/v1/model-profiles/versioned/versions/1/retry';
    const request={method:'POST' as const,url,headers:{...headers,'idempotency-key':key},payload:{}};
    expect((await app.inject(request)).statusCode).toBe(200);const wake=f.service.agents(id)[0].wake_seq;
    expect((await app.inject(request)).statusCode).toBe(200);expect(f.service.agents(id)[0].wake_seq).toBe(wake);
    expect(f.service.providers.status(first).state).toBe('PROBE_DUE');expect(f.service.providers.status(second).state).toBe('BLOCKED');
    expect(providerScope(first)).not.toBe(providerScope(second));
    f.service.lifecycle(id,'start',randomUUID());f.store.run("UPDATE sessions SET lifecycle='PAUSED',activity='BUDGET_PAUSED',stop_reason='MAX_CALLS' WHERE id=?",id);
    const count=f.service.session(id).call_count;
    expect((await app.inject({...request,headers:{...headers,'idempotency-key':randomUUID()}})).statusCode).toBe(200);
    expect(f.service.session(id)).toMatchObject({lifecycle:'PAUSED',activity:'BUDGET_PAUSED',call_count:count});
    f.service.lifecycle(id,'end',randomUUID());const ended=f.service.agents(id);
    await app.inject({...request,headers:{...headers,'idempotency-key':randomUUID()}});expect(f.service.agents(id)).toEqual(ended);
    expect((await app.inject({method:'POST',url:`/v1/sessions/${id}/agents/${ended[0].id}/retry`,headers:{...headers,'idempotency-key':randomUUID()},payload:{}})).statusCode).toBe(409);
  }finally{await app.close();f.close();}
});

it('R8-PROFILE-003: new operator endpoints preserve authentication, Host, Origin, CSRF and viewer boundaries',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false}),host=new URL(f.config.publicOrigin).host;
  try{
    const read=['/v1/provider-catalog','/v1/model-profiles/mock/versions',`/v1/sessions/${f.id}/operations`];
    for(const url of read){
      expect((await app.inject({method:'GET',url,headers:{host}})).statusCode).toBe(401);
      expect((await app.inject({method:'GET',url,headers:{host,authorization:'Bearer '+f.config.viewerToken}})).statusCode).toBe(403);
      expect((await app.inject({method:'GET',url,headers:{host:'invalid.test',authorization:'Bearer '+f.config.adminToken}})).statusCode).toBe(403);
    }
    const response=await app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin:f.config.publicOrigin},payload:{token:f.config.adminToken}});
    const cookie='mls_session='+response.cookies[0].value,csrf=response.json().csrf;
    const url='/v1/model-profiles/mock/versions/1/retry',valid={host,origin:f.config.publicOrigin,cookie,'x-csrf-token':csrf,'idempotency-key':randomUUID()};
    for(const headers of [{host,cookie},{...valid,'x-csrf-token':'wrong'},{...valid,origin:'https://invalid.test'},{host,authorization:'Bearer '+f.config.viewerToken}])expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers:valid,payload:{}})).statusCode).toBe(200);
    await app.inject({method:'POST',url:'/v1/auth/logout',headers:valid,payload:{}});
    expect((await app.inject({method:'GET',url:read[0],headers:valid})).statusCode).toBe(401);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});

it('R8-CLI-001: CLI profiles/versions/operations use the actual HTTP routes and never start model inference',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No test port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;
    const env={CORE_URL:base,ADMIN_TOKEN:f.config.adminToken};
    for(const args of [['profiles'],['profile-versions','mock'],['operations',f.id]]){
      const result=await operatorCommand(args,env);expect(result.ok).toBe(true);expect(()=>JSON.parse(result.body)).not.toThrow();expect(result.body).not.toContain(f.config.adminToken);
    }
    const result=await operatorCommand(['retry-provider','mock','1'],{...env,IDEMPOTENCY_KEY:'synthetic-cli-retry-key'});expect(result.ok).toBe(true);
    expect(f.service.session(f.id).lifecycle).toBe('DRAFT');expect(f.service.session(f.id).call_count).toBe(0);
    await expect(operatorCommand(['retry-provider','mock','-1'],env)).rejects.toThrow();
  }finally{await app.close();f.close();}
});
