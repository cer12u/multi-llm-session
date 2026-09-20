import { randomUUID } from 'node:crypto';
import { defaultCharacters, type Config } from '../packages/config/index.js';
import { SettingsSchema, ModelProfileSchema, type ClaimedRun, type Settings } from '../packages/contracts/index.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';

export function fixture(count=3,settings:Partial<Settings>={},dbPath=':memory:'){
  let time=1000000;const now=()=>time;
  const workerTokens=Object.fromEntries(Array.from({length:count},(_,i)=>[`worker-${i}`,`test-worker-${i}-token-000000000000000000000`]));
  const config:Config={dbPath,host:'127.0.0.1',port:0,publicOrigin:'http://127.0.0.1:3000',
    adminToken:'test-admin-token-00000000000000000000000',viewerToken:'test-viewer-token-0000000000000000000000',workerTokens,
    characters:structuredClone(defaultCharacters),profiles:[ModelProfileSchema.parse({id:'mock',provider:'mock',model:'deterministic-demo-v1'})],
    defaults:SettingsSchema.parse({debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0,postGapMs:0,arbitrationMs:0,agentCooldownMs:0,replyGraceMs:0,
      idleMs:1000,selfWakeMinMs:60000,selfWakeMaxMs:60000,episodeGapMs:2000,maxCalls:1000,maxMessages:100,maxDurationMs:120000,memoryEvery:100,...settings}),
    allowLive:false,maxRunning:1,maxConcurrentProvider:3,restartPolicy:'resume',feeds:[]};
  const store=new Store(dbPath),service=new SessionService(store,config,now,()=>0);
  const input={title:'検証セッション',participants:Object.keys(workerTokens).map((slot,i)=>({slot,characterId:defaultCharacters[i%3].id,profileId:'mock'})),settings:config.defaults};
  const id=service.createSession(input,randomUUID()).id;
  const epochs=Object.fromEntries(Object.keys(workerTokens).map(slot=>[slot,service.registerWorker(slot).epoch]));
  const start=()=>service.lifecycle(id,'start',randomUUID());
  const claim=(slot='worker-0')=>service.claim(slot,epochs[slot]);
  const say=(text='最初の話題',addressedTo:string[]=[])=>service.humanMessage(id,{text,addressedTo},randomUUID());
  const finish=(run:ClaimedRun,output:unknown)=>{
    const agent=service.agent(run.context.self.id),slot=agent.slot;
    const call=service.reserveCall(slot,run.workerEpoch,run.id,run.token,randomUUID(),'primary');
    service.finishCall(slot,run.id,run.token,call.id,{inputTokens:null,outputTokens:null},null);
    return service.completeRun(slot,run.workerEpoch,run.id,run.token,output);
  };
  const speak=(run:ClaimedRun)=>finish(run,{decision:'SPEAK',intent:{act:'comment',intent:'自分の観点から話す',replyTo:run.context.messages.at(-1)?.id??null,addressedTo:[]}});
  return {store,service,config,id,input,epochs,start,claim,say,finish,speak,now,advance:(ms:number)=>{time+=ms;},close:()=>store.close()};
}
