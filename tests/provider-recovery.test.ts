import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { ModelProfileSchema } from '../packages/contracts/index.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { ProviderState, providerScope } from '../packages/provider-state/index.js';
import { credential } from '../packages/config/credentials.js';
import { HttpModel, retryAfter } from '../packages/models/index.js';
const done:(()=>void)[]=[];afterEach(()=>{for(const f of done.splice(0).reverse())f();});
const profile=(id:string,key:string,extra={})=>ModelProfileSchema.parse({id,provider:'openai',model:'synthetic',baseUrl:'https://example.invalid/v1',apiKeyEnv:key,...extra});

it('persists a circuit across DB reopen and permits only one half-open probe after the cooldown',()=>{
  const dir=mkdtempSync(join(tmpdir(),'provider-circuit-'));done.push(()=>rmSync(dir,{recursive:true,force:true}));
  let now=100000;const path=join(dir,'db.sqlite'),p=profile('a','KEY_A');
  const db=new Store(path),gate=new ProviderState(db,()=>now);
  for(let i=0;i<3;i++)gate.finish(p,'call-'+i,'API_ERROR');expect(gate.mayClaim(p,3,2)).toBe(false);db.close();
  const reopened=new Store(path);done.push(()=>reopened.close());const recovered=new ProviderState(reopened,()=>now);
  expect(recovered.status(p).state).toBe('OPEN');now+=60000;expect(recovered.mayClaim(p,3,2)).toBe(true);
  recovered.reserve(p,'probe',now+10000,3);expect(()=>recovered.reserve(p,'second-probe',now+10000,3)).toThrow('PROVIDER_COOLDOWN');
  recovered.finish(p,'old-call',null);expect(recovered.status(p).state).toBe('HALF_OPEN');
  recovered.finish(p,'probe',null);expect(recovered.status(p).state).toBe('CLOSED');
});
it('isolates credential scopes, honors explicit groups, and leaves auth failures blocked until requested',()=>{
  const db=new Store(':memory:');done.push(()=>db.close());let now=1000;const gate=new ProviderState(db,()=>now),a=profile('a','KEY_A'),b=profile('b','KEY_B');
  expect(providerScope(a)).not.toBe(providerScope(b));expect(providerScope({...a,limitGroup:'shared'})).toBe(providerScope({...b,limitGroup:'shared'}));
  gate.finish(a,'bad','AUTH_ERROR');now+=900000;expect(gate.mayClaim(a,0,2)).toBe(false);expect(gate.mayClaim(b,0,2)).toBe(true);
  gate.requestProbe(a);expect(gate.mayClaim(a,0,2)).toBe(true);
});
it('parses Retry-After seconds and HTTP dates and transports it without error body leakage',async()=>{
  const now=Date.parse('2026-09-20T00:00:00Z');expect(retryAfter('120',now)).toBe(120000);expect(retryAfter('Sun, 20 Sep 2026 00:02:00 GMT',now)).toBe(120000);expect(retryAfter('nonsense',now)).toBe(0);
  const f=fixture();done.push(f.close);f.start();const c=f.claim()!.context;
  const mockFetch=(async()=>new Response('private provider error',{status:429,headers:{'Retry-After':'120'}})) as typeof fetch;
  await expect(new HttpModel(profile('a','KEY_A'),'fake-key',mockFetch).complete('decide',c,{signal:new AbortController().signal,maxChars:24000})).rejects.toMatchObject({code:'RATE_LIMIT',retryAfterMs:120000});
  const gate=new ProviderState(f.store,f.now);gate.finish(profile('a','KEY_A'),'fake','RATE_LIMIT',120000);
  expect(gate.status(profile('a','KEY_A')).retryAt).toBe(f.now()+120000);
});
it('stores profile versions and freezes each agent to its selected provider snapshot',()=>{
  const f=fixture();done.push(f.close);f.config.allowLive=true;const a=profile('a','KEY_A'),b=profile('b','KEY_B'),c=ModelProfileSchema.parse({...profile('c','KEY_C'),provider:'ollama',baseUrl:'https://elsewhere.invalid/api'});
  for(const p of [a,b,c])f.service.putModelProfile(p);
  const create=()=>f.service.createSession({...f.input,participants:f.input.participants.map((x,i)=>({...x,profileId:[a,b,c][i].id}))},randomUUID()).id;
  const before=create();f.service.putModelProfile({...a,version:2,model:'updated'});
  expect(JSON.parse(f.service.agents(before)[0].profile_json).model).toBe('synthetic');expect(JSON.parse(f.service.agents(create())[0].profile_json).model).toBe('updated');
  expect(()=>f.service.putModelProfile({...a,model:'illegal-same-version'})).toThrow('PROFILE_VERSION_IMMUTABLE');
});
it('supports secret file bindings without accepting two ambiguous credential sources',()=>{
  const dir=mkdtempSync(join(tmpdir(),'credential-file-'));done.push(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'key');writeFileSync(file,'synthetic-key\n');
  const p=profile('a','KEY_A');expect(credential(p,{KEY_A_FILE:file})).toBe('synthetic-key');expect(()=>credential(p,{KEY_A_FILE:file,KEY_A:'another'})).toThrow('AMBIGUOUS_MODEL_CREDENTIAL');
});
