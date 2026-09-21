import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient, WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { ScriptedModel } from '../packages/models/index.js';

it('R10-STORAGE-009: a real Worker death before result does not acknowledge input and preserves the abandoned call across lease recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'worker-storage-crash-')),marker=join(dir,'crash-marker'),f=fixture(3,{},join(dir,'db.sqlite'));
  const app=buildServer(f.service,{timers:false});let child:ReturnType<typeof spawn>|undefined;
  try{
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No port');
    const base=`http://127.0.0.1:${address.port}`;f.config.publicOrigin=base;f.say('未完了の観測対象');f.start();
    child=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/storage-crash-worker.ts'),base,marker],{env:{...process.env,SYNTHETIC_WORKER_TOKEN:f.config.workerTokens['worker-0']},stdio:['ignore','pipe','pipe']});
    child.stdout?.resume();let stderr='';child.stderr?.on('data',data=>{stderr=(stderr+String(data)).slice(-1000);});
    let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;child?.kill('SIGKILL');},8000);
    const exited=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolveExit,reject)=>{child!.once('error',reject);child!.once('exit',(code,signal)=>resolveExit({code,signal}));});clearTimeout(timeout);
    expect(timedOut,stderr).toBe(false);expect(exited.signal,stderr).toBe('SIGKILL');expect(readFileSync(marker,'utf8')).toBe('after-call-reservation-before-result');
    const agent=f.service.agents(f.id)[0],old=f.store.get<{id:string}>('SELECT id FROM runs WHERE agent_id=?',agent.id)!;
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE agent_id=?',agent.id)).toHaveLength(0);
    f.advance(f.config.defaults.leaseMs+1);f.service.tick();
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',old.id)!.state).toBe('CANCELLED');
    expect(f.store.get<{status:string;expires_at:number}>('SELECT status,expires_at FROM llm_calls WHERE run_id=?',old.id)).toMatchObject({status:'ABANDONED'});
    const next=new WorkerRuntime(new CoreClient(base,f.config.workerTokens['worker-0']),{},()=>new ScriptedModel(['{"decision":"ABSTAIN","reason":"未完了の入力を再処理"}']));
    await next.register();await next.once();
    expect(f.store.all('SELECT * FROM agent_input_receipts WHERE agent_id=?',agent.id)).toHaveLength(1);
    expect(f.store.all('SELECT * FROM agent_state_updates WHERE agent_id=?',agent.id)).toHaveLength(1);
    expect(f.service.session(f.id).call_count).toBe(2);expect(f.service.session(f.id).bot_count).toBe(0);
    expect(f.store.get<{status:string}>('SELECT status FROM llm_calls WHERE run_id=?',old.id)!.status).toBe('ABANDONED');
  }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await app.close();f.close();rmSync(dir,{recursive:true,force:true});}
},20000);
