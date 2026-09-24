import { expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { profileOf } from '../packages/storage-sqlite/index.js';

it('R4-REVIEW-008: LOOKUP cannot rebind an old model request to a newly changed frozen profile',()=>{
  const f=fixture();
  try {
    const original=f.say('確認する原文');f.start();const run=f.claim()!,owner=f.service.agent(run.context.self.id);
    const call=f.service.reserveCall(owner.slot,run.workerEpoch,run.id,run.token,randomUUID(),'primary');
    f.service.finishCall(owner.slot,run.id,run.token,call.id,{inputTokens:1,outputTokens:1},null);
    const before=f.store.get<{context_json:string}>('SELECT context_json FROM runs WHERE id=?',run.id)!.context_json;
    // Fault injection deliberately bypasses the normal PAUSED/epoch-changing application mutation path.
    f.store.run('UPDATE agent_instances SET profile_json=? WHERE id=?',JSON.stringify({...profileOf(owner),version:2,model:'new-synthetic-model'}),owner.id);
    expect(()=>f.service.retrieve(owner.slot,run.workerEpoch,run.id,run.token,'stale-identity-lookup',[
      {kind:'message',query:original.id,cursor:null},
    ])).toThrow('STALE_AGENT_IDENTITY');
    expect(f.store.get<{context_json:string;retrieval_count:number}>('SELECT context_json,retrieval_count FROM runs WHERE id=?',run.id)).toEqual({context_json:before,retrieval_count:0});
    expect(f.store.all('SELECT * FROM command_receipts WHERE key=?','stale-identity-lookup')).toHaveLength(0);
    const replacement=f.claim()!;expect(replacement.id).not.toBe(run.id);expect(replacement.profile.model).toBe('new-synthetic-model');
    f.finish(replacement,{decision:'ABSTAIN',reason:'fresh identity may independently decide'});
  } finally {f.close();}
});
