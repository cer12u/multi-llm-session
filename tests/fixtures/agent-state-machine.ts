import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers.js';
import {seededRandom} from '../../packages/domain/index.js';
import {WireOutputSchemas,type ClaimedRun} from '../../packages/contracts/index.js';
import {diagnosticExport,diagnosticSnapshot} from '../../packages/observability/index.js';
import {ReplayStream} from '../../packages/observability/replay.js';

export type Command={op:'message'|'edit'|'delete'|'work'|'pause'|'resume'|'replace'|'recover'|'source'|'advance'|'forgery'|'budget';slot:number;choice:number};
export const operations:Command['op'][]=['message','edit','delete','work','pause','resume','replace','recover','source','advance','forgery','budget'];
export function commands(seed:number,count:number,length=72):Command[]{
  const random=seededRandom(seed);
  const prefix:Command[]=operations.map(op=>({op,slot:Math.floor(random()*count),choice:Math.floor(random()*1000)}));
  while(prefix.length<length)prefix.push({op:operations[Math.floor(random()*operations.length)],slot:Math.floor(random()*count),choice:Math.floor(random()*1000)});
  return prefix;
}
function demand(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
type Fixture=ReturnType<typeof fixture>;
export function invariants(f:Fixture):void {
  const checks:[string,string][]=[
    ['ONE_ACTIVE_RUN',"SELECT slot FROM runs WHERE state='ACTIVE' GROUP BY slot HAVING COUNT(*)>1"],
    ['ONE_ACTIVE_CANDIDATE',"SELECT agent_id FROM candidates WHERE state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED') GROUP BY agent_id HAVING COUNT(*)>1"],
    ['ONE_PUBLICATION',"SELECT candidate_id FROM messages WHERE candidate_id IS NOT NULL GROUP BY candidate_id HAVING COUNT(*)>1"],
    ['CANDIDATE_OWNER',"SELECT c.id FROM candidates c JOIN agent_instances a ON a.id=c.agent_id WHERE c.session_id<>a.session_id"],
    ['PUBLICATION_OWNER',"SELECT m.id FROM messages m JOIN candidates c ON c.id=m.candidate_id WHERE m.author_id<>c.agent_id OR m.session_id<>c.session_id OR c.state<>'COMMITTED'"],
    ['REPLY_SCOPE',"SELECT m.id FROM messages m JOIN messages p ON p.id=m.reply_to WHERE m.session_id<>p.session_id"],
    ['NO_ACTIVE_WHILE_STOPPED',"SELECT r.id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.state='ACTIVE' AND s.lifecycle<>'RUNNING'"],
    ['WINDOW_CALL_BOUND',"SELECT id FROM sessions WHERE call_count-window_call_start>json_extract(settings_json,'$.maxCalls')"],
    ['WINDOW_MESSAGE_BOUND',"SELECT id FROM sessions WHERE bot_count-window_post_start>json_extract(settings_json,'$.maxMessages')"],
  ];
  for(const [name,query] of checks)demand(f.store.all(query).length===0,name);
  demand((f.store.db.pragma('foreign_key_check') as unknown[]).length===0,'FOREIGN_KEY_INTEGRITY');
  for(const row of f.store.all<{agent_id:string;context_json:string}>('SELECT agent_id,context_json FROM runs')){
    const context=JSON.parse(row.context_json) as ClaimedRun['context'];
    demand(context.self.id===row.agent_id&&context.self.privateState?.agentId===row.agent_id,'CONTEXT_OWNER');
    const text=JSON.stringify(context),owners=f.service.agents(f.id);
    owners.forEach((owner,index)=>{if(owner.id!==row.agent_id)demand(!text.includes('STATE_MACHINE_PRIVATE_'+index),'PEER_STATE_LEAK');});
  }
  const posted=f.service.snapshot(f.id).messages;
  demand(!JSON.stringify(posted).includes('STATE_MACHINE_PRIVATE_'),'PUBLIC_STATE_LEAK');
}
function action(run:ClaimedRun,choice:number):unknown {
  if(run.kind==='memory'){
    const source=run.context.messages.find(m=>!m.deleted);
    return {notes:source&&choice%2?[{text:'synthetic grounded memory',sourceMessageIds:[source.id]}]:[]};
  }
  if(run.kind==='observe')return {decision:'ABSTAIN',reason:'synthetic observation'};
  if(run.kind==='decide')return choice%3===0?{decision:'SPEAK',intent:{act:'comment',intent:'synthetic independent contribution',replyTo:null,addressedTo:[]}}:
    choice%3===1?{decision:'DEFER',reason:'synthetic finite wait',defer:{kind:'time',afterMs:100,agentId:null}}:{decision:'ABSTAIN',reason:'synthetic quiet'};
  if(run.kind==='draft')return {decision:'DRAFT',text:'synthetic contribution '+choice};
  return run.context.coverage?.complete?{decision:'KEEP'}:{decision:'REWRITE',text:run.context.candidate!.text!,intent:run.context.candidate!.intent};
}
export class ScenarioFailure extends Error {
  constructor(readonly index:number,readonly code:string){super(code);}
}
export function execute(count:number,input:Command[]){
  const f=fixture(count,{selfWakeEnabled:false,memoryEvery:3,memoryShareEvery:3,maxCalls:10000,maxMessages:1000,maxDurationMs:3600000,contextMessages:5});
  let completed=0,forgeries=0,restarts=0;const exercised=new Set<string>();
  try{
    f.say('single initial topic');f.start();
    const owners=f.service.agents(f.id);
    owners.forEach((owner,index)=>{
      const run=f.claim(owner.slot)!;demand(run.kind==='decide','INITIAL_DECISION');
      f.finish(run,{action:{decision:'ABSTAIN',reason:'retain independent private interest'},statePatch:{agentId:owner.id,sessionId:f.id,expectedVersion:run.context.self.privateState!.version,observationId:run.context.observation!.id,
        upsert:[{id:'private',kind:'interest',text:'STATE_MACHINE_PRIVATE_'+index,evidence:[],resume:null}],remove:[]}});
    });
    for(let index=0;index<input.length;index++){
      const command=input[index],slot='worker-'+(command.slot%count),lifecycle=f.service.session(f.id).lifecycle;
      try{
        switch(command.op){
          case 'message':f.say('synthetic topic '+index);break;
          case 'edit':case 'delete':{
            const rows=f.store.all<{id:string}>("SELECT id FROM messages WHERE session_id=? AND author_id IS NULL AND deleted=0 ORDER BY sequence",f.id);
            if(rows.length)f.service.changeMessage(f.id,rows[command.choice%rows.length].id,command.op==='delete'?null:'synthetic corrected '+index,randomUUID());break;
          }
          case 'source':f.service.injectSource(f.id,{title:'synthetic source '+index,text:'observed data only',audience:[owners[command.slot%count].id]},randomUUID());break;
          case 'pause':if(lifecycle==='RUNNING')f.service.lifecycle(f.id,'pause',randomUUID());break;
          case 'resume':if(lifecycle==='PAUSED')f.service.lifecycle(f.id,'resume',randomUUID());break;
          case 'replace':f.epochs[slot]=f.service.registerWorker(slot).epoch;break;
          case 'recover':f.service.recover();for(const name of Object.keys(f.epochs))f.epochs[name]=f.service.registerWorker(name).epoch;restarts++;break;
          case 'advance':f.advance(101+command.choice);f.service.tick();break;
          case 'budget':if(lifecycle==='PAUSED')f.service.renewBudget(f.id,randomUUID());break;
          case 'work':case 'forgery':{
            if(lifecycle!=='RUNNING')break;
            const run=f.claim(slot);if(!run)break;
            if(command.op==='forgery'){
              const call=f.service.reserveCall(slot,run.workerEpoch,run.id,run.token,randomUUID(),'primary');
              f.service.finishCall(slot,run.id,run.token,call.id,{inputTokens:null,outputTokens:null},null);
              const output={action:action(run,command.choice),statePatch:{agentId:owners[(command.slot+1)%count].id,sessionId:f.id,expectedVersion:run.context.self.privateState!.version,observationId:run.context.observation!.id,upsert:[],remove:[]}};
              demand(WireOutputSchemas[run.kind].safeParse(output).success,'NEGATIVE_FIXTURE_MUST_BE_SCHEMA_VALID');
              const before=JSON.stringify(f.store.all('SELECT * FROM agent_private_states ORDER BY agent_id'));
              let code='';try{f.service.completeRun(slot,run.workerEpoch,run.id,run.token,output);}catch(error){code=error instanceof Error?error.message:'unknown';}
              demand(code==='STATE_OWNER_MISMATCH','FORGED_OWNER_ACCEPTED');
              demand(JSON.stringify(f.store.all('SELECT * FROM agent_private_states ORDER BY agent_id'))===before,'FORGERY_MUTATED_STATE');
              f.service.completeRun(slot,run.workerEpoch,run.id,run.token,action(run,command.choice));forgeries++;
            }else f.finish(run,action(run,command.choice));
            completed++;break;
          }
        }
        exercised.add(command.op);invariants(f);
      }catch(error){throw new ScenarioFailure(index,error instanceof Error?error.message:'UNKNOWN_FAILURE');}
    }
    if(f.service.session(f.id).lifecycle==='RUNNING')f.service.lifecycle(f.id,'pause',randomUUID());
    invariants(f);
    return {f,report:{commands:input.length,completedRuns:completed,forgeriesRejected:forgeries,recoveryCommands:restarts,operations:[...exercised].sort(),calls:f.service.session(f.id).call_count,posts:f.service.session(f.id).bot_count}};
  }catch(error){f.close();throw error;}
}
/** Delta-debug an actual failing event prefix. Returned sequence is 1-minimal under deleting one command. */
export function minimize(count:number,input:Command[],code:string):Command[]{
  let reduced=[...input],index=0;
  while(index<reduced.length){
    const candidate=reduced.filter((_,position)=>position!==index);let same=false;
    try{const result=execute(count,candidate);result.f.close();}catch(error){same=error instanceof ScenarioFailure&&error.code===code;}
    if(same){reduced=candidate;index=0;}else index++;
  }
  return reduced;
}
export async function verifyReplay(f:Fixture){
  const expected=JSON.stringify(diagnosticSnapshot(f.store,f.id)),replay=new ReplayStream();
  for await(const line of diagnosticExport(f.service,f.id).lines())replay.push(line.trimEnd());
  demand(JSON.stringify(replay.finish().state)===expected,'RECORDED_REPLAY_DIVERGED');
}
