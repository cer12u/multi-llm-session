import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { HttpModel } from '../packages/models/index.js';
import { ModelProfileSchema } from '../packages/contracts/index.js';

it('R8-PROFILE-001: output truncation is explicit and preserves reported usage instead of accepting a partial response', async () => {
  const f=fixture();
  try {
    f.start();const context=f.claim()!.context;
    const profile=ModelProfileSchema.parse({id:'synthetic',provider:'openai',model:'fixture',baseUrl:'https://synthetic.invalid/v1',authRequired:false});
    const fetcher:typeof fetch=async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"decision":"AB'}}],usage:{prompt_tokens:50,completion_tokens:128}}));
    await expect(new HttpModel(profile,undefined,fetcher).complete('decide',context,{signal:new AbortController().signal,maxChars:24000}))
      .rejects.toMatchObject({code:'OUTPUT_TRUNCATED',usage:{inputTokens:50,outputTokens:128}});
  }finally{f.close();}
});

it('R8-RECOVERY-001: manual Provider retry fences earlier runs; late results cannot re-block the recovered circuit',()=>{
  const f=fixture();
  try {
    const profile=ModelProfileSchema.parse({id:'synthetic',provider:'openai',model:'fixture',baseUrl:'https://synthetic.invalid/v1',apiKeyEnv:'SYNTHETIC_KEY',maxConcurrent:1});
    f.service.putModelProfile(profile);f.config.allowLive=true;
    const session=f.service.createSession({...f.input,participants:f.input.participants.map(p=>({...p,profileId:profile.id}))},randomUUID()).id;
    f.service.lifecycle(session,'start',randomUUID());const r=f.claim()!;
    const call=f.service.reserveCall('worker-0',r.workerEpoch,r.id,r.token,randomUUID(),'primary');
    f.service.retryProvider(profile.id,randomUUID());
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',r.id)!.state).toBe('CANCELLED');
    expect(f.store.get<{status:string}>('SELECT status FROM llm_calls WHERE id=?',call.id)!.status).toBe('ABANDONED');
    // A still-running remote call occupies its old slot even though the local attempt was cancelled.
    const next=f.claim()!;
    expect(()=>f.service.reserveCall('worker-0',next.workerEpoch,next.id,next.token,randomUUID(),'primary')).toThrow('PROVIDER_BUSY');
    f.service.finishCall('worker-0',r.id,r.token,call.id,{inputTokens:42,outputTokens:7},'AUTH_ERROR');
    expect(f.service.providers.status(profile).state).not.toBe('BLOCKED');
    expect(()=>f.service.completeRun('worker-0',r.workerEpoch,r.id,r.token,{decision:'ABSTAIN',reason:'obsolete'})).toThrow('STALE_RUN');
    const probe=f.service.reserveCall('worker-0',next.workerEpoch,next.id,next.token,randomUUID(),'primary');
    f.service.finishCall('worker-0',next.id,next.token,probe.id,{inputTokens:1,outputTokens:1},null);
    expect(f.service.providers.status(profile).state).toBe('CLOSED');
  }finally{f.close();}
});
