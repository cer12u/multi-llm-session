import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {lookupSelectionSettings} from '../packages/models/context-budget.js';
import type {ClaimedRun} from '../packages/contracts/index.js';

function recordedCall(f:ReturnType<typeof fixture>,run:ClaimedRun,stage:'primary'|'lookup'='primary'){
  const call=f.service.reserveCall('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),stage);
  f.service.finishCall('worker-0',run.id,run.token,call.id,{inputTokens:null,outputTokens:null},null);
}

it('R5-BUDGET-023: two explicit lookups fit beside a saturated observation prefix without dropping its IDs or advancing its cursor',()=>{
  const f=fixture(3,{contextChars:12000});
  try{
    const first=f.say('旧取り決めの原文：午後四時');
    for(let i=0;i<120;i++)f.say('日々の会話 '.repeat(8)+i);
    const last=f.say('次の取り決めの原文：木曜日');f.start();const run=f.claim()!;
    expect(run).not.toBeNull();expect(run.context.delivery!.complete).toBe(false);
    expect(JSON.stringify(run.context).length).toBeLessThan(lookupSelectionSettings(run.profile,f.config.defaults).contextChars);
    recordedCall(f,run);
    const one=f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),[{kind:'message',query:first.id,cursor:null}]);
    expect(one.delivery).toEqual(run.context.delivery);expect(one.messages).toEqual(run.context.messages);
    expect(one.retrieved!.at(-1)!.messages[0].text).toBe(first.text);
    recordedCall(f,run,'lookup');
    const two=f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,randomUUID(),[{kind:'message',query:last.id,cursor:null}]);
    expect(two.delivery).toEqual(run.context.delivery);expect(two.messages).toEqual(run.context.messages);
    expect(two.retrieved!.at(-1)!.messages[0].text).toBe(last.text);
    expect(two.observation!.messages.some(ref=>ref.id===last.id&&ref.version===last.revision)).toBe(true);
    expect(f.store.get<{observed_input:number}>('SELECT observed_input FROM agent_input_cursors WHERE agent_id=?',run.context.self.id)!.observed_input).toBe(0);
    expect(f.store.get<{retrieval_count:number}>('SELECT retrieval_count FROM runs WHERE id=?',run.id)!.retrieval_count).toBe(2);
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',run.id)).toHaveLength(0);
    expect(two.inputBudget!.maxTokens).toBe(f.config.defaults.contextTokens);
  }finally{f.close();}
});

it('R5-BUDGET-024: an oversized explicit lookup rolls back context and receipt instead of trimming the mandatory window',()=>{
  const f=fixture(3,{contextChars:8000});
  try{
    for(let i=0;i<90;i++)f.say('未処理の原文 '.repeat(8)+i);
    const large=f.say('過去資料 '+ '長'.repeat(3900));f.start();const run=f.claim()!;
    expect(run).not.toBeNull();recordedCall(f,run);
    const before=f.store.get('SELECT context_json,retrieval_count FROM runs WHERE id=?',run.id);
    const key=randomUUID();
    expect(()=>f.service.retrieve('worker-0',run.workerEpoch,run.id,run.token,key,[{kind:'message',query:large.id,cursor:null}])).toThrow('CONTEXT_LIMIT');
    expect(f.store.get('SELECT context_json,retrieval_count FROM runs WHERE id=?',run.id)).toEqual(before);
    expect(f.store.get('SELECT key FROM command_receipts WHERE scope=? AND key=?',`worker:worker-0:${run.id}:lookup`,key)).toBeUndefined();
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE run_id=?',run.id)).toHaveLength(0);
  }finally{f.close();}
});
