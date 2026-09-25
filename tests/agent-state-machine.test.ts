import {expect,it} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {commands,execute,invariants,minimize,ScenarioFailure,verifyReplay,type Command} from './fixtures/agent-state-machine.js';

const seeds=[19421,78437,91283];
for(const count of [3,5,8])for(const seed of seeds)it(`R10-STATE-001: ${count} independent owners, seed ${seed}, actual SQLite commands and recorded replay`,async()=>{
  const input=commands(seed,count);mkdirSync('artifacts/state-machine',{recursive:true});
  const path=`artifacts/state-machine/${count}-${seed}.json`;
  let result:ReturnType<typeof execute>|undefined;
  try{
    result=execute(count,input);await verifyReplay(result.f);
    writeFileSync(path,JSON.stringify({mode:'synthetic-command-model',seed,owners:count,commands:input,result:result.report,passed:true}));
    expect(result.report.completedRuns).toBeGreaterThan(0);expect(result.report.recoveryCommands).toBeGreaterThan(0);
  }catch(error){
    const failed=error instanceof ScenarioFailure?input.slice(0,error.index+1):input,code=error instanceof Error?error.message:'UNKNOWN_FAILURE';
    const minimal=error instanceof ScenarioFailure?minimize(count,failed,code):failed;
    writeFileSync(path,JSON.stringify({mode:'synthetic-command-model',seed,owners:count,commands:input,failingPrefix:failed,minimized: minimal,minimization:error instanceof ScenarioFailure?'single-deletion-1-minimal':'not-minimized',code,passed:false}));
    throw error;
  }finally{result?.f.close();}
},60000);

it('R10-STATE-002: the oracle rejects intentional corruption instead of only affirming its own scripted outputs',()=>{
  const input:Command[]=[{op:'message',slot:0,choice:0},{op:'work',slot:0,choice:0},{op:'work',slot:0,choice:0}];
  const result=execute(3,input),f=result.f;
  try{
    const other=f.service.createSession(f.input,'state-machine-negative-session').id;
    const message=f.say('same session original'),foreign=f.service.humanMessage(other,{text:'different session original'},'state-machine-negative-message');
    f.store.run('UPDATE messages SET reply_to=? WHERE id=?',foreign.id,message.id);
    expect(()=>invariants(f)).toThrow('REPLY_SCOPE');
    f.store.run('UPDATE messages SET reply_to=NULL WHERE id=?',message.id);
    expect(()=>invariants(f)).not.toThrow();
    f.store.run('UPDATE sessions SET call_count=window_call_start+10001 WHERE id=?',f.id);
    expect(()=>invariants(f)).toThrow('WINDOW_CALL_BOUND');
  }finally{f.close();}
});
