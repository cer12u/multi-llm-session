import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import type { ClaimedRun } from '../packages/contracts/index.js';

const cleanup:(()=>void)[]=[],evidence:{phase:string;kind:string;signal:string;rows:number}[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function setup(){const dir=mkdtempSync(join(tmpdir(),'real-core-crash-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const f=fixture(3,{},join(dir,'session.sqlite'));cleanup.push(()=>{if(f.store.db.open)f.close();});return f;}
async function crash(path:string,phase:string,requestPath:string,body:unknown,headers:Record<string,string>):Promise<void>{
  const child:ChildProcess=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/storage-crash-child.ts'),path,phase],{stdio:['ignore','pipe','pipe','ipc']});
  cleanup.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let stderr='';child.stdout?.resume();child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-1000);});
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolveExit=>child.once('exit',(code,signal)=>resolveExit({code,signal})));
  const base=await new Promise<string>((resolveReady,reject)=>{
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash fixture startup timed out'));},8000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Crash fixture exited before ready: '+stderr));});
    child.once('message',input=>{
      const value=input as {ready?:boolean;base?:string};clearTimeout(timeout);
      if(value.ready&&value.base?.startsWith('http://127.0.0.1:'))resolveReady(value.base);else reject(new Error('Invalid fixture readiness'));
    });
  });
  let response:Response|undefined,timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},8000);
  try{
    try{response=await fetch(base+requestPath,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(6000)});}catch{}
    const result=await exit;
    expect(timedOut,stderr).toBe(false);expect(result.signal).toBe('SIGKILL');expect(response,stderr).toBeUndefined();
    expect(readFileSync(path+'.crash-'+phase,'utf8')).toBe(phase);
  }finally{clearTimeout(timeout);await response?.body?.cancel();}
}
function record(phase:string,kind:string,rows:number){evidence.push({phase,kind,signal:'SIGKILL',rows});mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/storage-crash-summary.json',JSON.stringify({mode:'synthetic-real-subprocess',cases:evidence},null,2));}

it.each(['before-transaction','after-message-write','after-commit'])('R10-STORAGE-007: %s does not lose or duplicate a human command after its HTTP response is lost',async phase=>{
  const f=setup(),key=randomUUID(),body={text:'強制停止をまたぐ一回の投稿'};f.close();
  await crash(f.config.dbPath,phase,`/v1/sessions/${f.id}/messages`,body,{authorization:'Bearer '+f.config.adminToken,'idempotency-key':key});
  const db=new Store(f.config.dbPath);cleanup.push(()=>db.close());const service=new SessionService(db,f.config,f.now);service.recover();
  const before=db.get<{n:number}>('SELECT COUNT(*) n FROM messages WHERE session_id=?',f.id)!.n;
  expect(before).toBe(phase==='after-commit'?1:0);
  const first=service.humanMessage(f.id,body,key),repeat=service.humanMessage(f.id,body,key);
  expect(repeat.id).toBe(first.id);expect(first.sequence).toBe(1);
  expect(service.snapshot(f.id).messages).toHaveLength(1);
  expect(db.all('SELECT * FROM command_receipts WHERE scope=? AND key=?',`operator:${f.id}:message`,key)).toHaveLength(1);
  expect(db.db.pragma('foreign_key_check')).toEqual([]);record(phase,'human-command',1);
},20000);

function stateOutput(r:ClaimedRun){const state=r.context.self.privateState!;return {action:{decision:'ABSTAIN',reason:'状態を保存して聞く'},statePatch:{agentId:state.agentId,sessionId:state.sessionId,expectedVersion:state.version,observationId:r.context.observation!.id,
  upsert:[{id:'recover-question',kind:'question',text:'復旧後も本人だけが保持する疑問',evidence:[],resume:{kind:'time',agentId:null,topic:null,notBefore:1060000}}],remove:[]}};}
it.each(['after-state-write','after-commit'])('R10-STORAGE-008: %s restores atomic state/action/cursor/agenda and accepts one completed result only once',async phase=>{
  const f=setup();f.say('観測する根拠');f.start();const r=f.claim()!;
  const call=f.service.reserveCall('worker-0',r.workerEpoch,r.id,r.token,randomUUID(),'primary');
  f.service.finishCall('worker-0',r.id,r.token,call.id,{inputTokens:null,outputTokens:null},null);
  const output=stateOutput(r);f.close();
  await crash(f.config.dbPath,phase,`/v1/worker/runs/${r.id}/result`,{epoch:r.workerEpoch,token:r.token,output},{authorization:'Bearer '+f.config.workerTokens['worker-0']});
  const db=new Store(f.config.dbPath);cleanup.push(()=>db.close());const service=new SessionService(db,f.config,f.now,()=>0);service.recover();
  expect(db.get<{version:number}>('SELECT version FROM agent_private_states WHERE agent_id=?',r.context.self.id)!.version).toBe(phase==='after-commit'?1:0);
  if(phase==='after-commit'){
    expect(service.completeRun('worker-0',r.workerEpoch,r.id,r.token,output)).toEqual({ok:true});
    expect(db.all('SELECT * FROM agent_state_updates WHERE run_id=?',r.id)).toHaveLength(1);
    expect(db.all('SELECT * FROM agent_input_receipts WHERE run_id=?',r.id)).toHaveLength(1);
  }else{
    expect(db.all('SELECT * FROM agent_state_updates WHERE run_id=?',r.id)).toHaveLength(0);
    expect(db.all('SELECT * FROM agent_input_receipts WHERE run_id=?',r.id)).toHaveLength(0);
    expect(()=>service.completeRun('worker-0',r.workerEpoch,r.id,r.token,output)).toThrow();
    const epoch=service.registerWorker('worker-0').epoch,next=service.claim('worker-0',epoch)!;
    expect(next.context.delivery!.fromInput).toBe(0);
    const retried=service.reserveCall('worker-0',epoch,next.id,next.token,randomUUID(),'primary');
    service.finishCall('worker-0',next.id,next.token,retried.id,{inputTokens:null,outputTokens:null},null);
    const result=stateOutput(next);service.completeRun('worker-0',epoch,next.id,next.token,result);service.completeRun('worker-0',epoch,next.id,next.token,result);
  }
  expect(db.get<{version:number}>('SELECT version FROM agent_private_states WHERE agent_id=?',r.context.self.id)!.version).toBe(1);
  expect(db.all('SELECT * FROM agent_state_updates WHERE agent_id=?',r.context.self.id)).toHaveLength(1);
  expect(db.all('SELECT * FROM agent_agenda WHERE agent_id=?',r.context.self.id)).toHaveLength(1);
  expect(db.all('SELECT * FROM agent_input_receipts WHERE agent_id=?',r.context.self.id)).toHaveLength(1);
  expect(service.session(f.id).bot_count).toBe(0);expect(service.snapshot(f.id).messages).toHaveLength(1);
  expect(JSON.stringify(service.snapshot(f.id))).not.toContain('復旧後も本人だけ');record(phase,'private-result',1);
},20000);

it.each(['after-message-write','after-commit'])('R10-STORAGE-012: %s cannot publish the same Agent candidate twice after Core recovery',async phase=>{
  const f=setup();f.say('発言の根拠');f.start();f.speak(f.claim()!);const draft=f.claim()!;
  f.finish(draft,{decision:'DRAFT',text:'一度だけ確定するAgentの発言'});
  const candidate=f.store.get<{id:string;state:string}>('SELECT id,state FROM candidates')!;expect(candidate.state).toBe('READY');f.close();
  await crash(f.config.dbPath,phase,'/v1/worker/claim',{epoch:f.epochs['worker-0']},{authorization:'Bearer '+f.config.workerTokens['worker-0']});
  const db=new Store(f.config.dbPath);cleanup.push(()=>db.close());const service=new SessionService(db,f.config,f.now,()=>0);
  const rows=()=>db.all<{id:string;sequence:number}>('SELECT id,sequence FROM messages WHERE candidate_id=?',candidate.id);
  expect(rows()).toHaveLength(phase==='after-commit'?1:0);const committedId=rows()[0]?.id;service.recover();
  if(phase==='after-message-write'){
    const epoch=service.registerWorker('worker-0').epoch,review=service.claim('worker-0',epoch)!;
    expect(review.kind).toBe('review');const call=service.reserveCall('worker-0',epoch,review.id,review.token,randomUUID(),'primary');
    service.finishCall('worker-0',review.id,review.token,call.id,{inputTokens:null,outputTokens:null},null);
    service.completeRun('worker-0',epoch,review.id,review.token,{decision:'KEEP'});expect(service.commitNext(f.id)?.text).toBe('一度だけ確定するAgentの発言');
  }
  expect(service.commitNext(f.id)).toBeNull();service.tick();
  expect(rows()).toHaveLength(1);expect(rows()[0].sequence).toBe(2);if(committedId)expect(rows()[0].id).toBe(committedId);
  expect(service.session(f.id).bot_count).toBe(1);expect(service.snapshot(f.id).messages).toHaveLength(2);
  expect(db.get<{state:string}>('SELECT state FROM candidates WHERE id=?',candidate.id)!.state).toBe('COMMITTED');
  expect(service.eventsAfter(f.id,f.id+':0').filter(e=>e.kind==='message.created'&&e.message?.id===rows()[0].id)).toHaveLength(1);
  record(phase,'agent-candidate',1);
},20000);
