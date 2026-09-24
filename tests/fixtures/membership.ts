import {expect} from 'vitest';
import type {MemberSelection,MembershipUpdate} from '../../packages/contracts/session-membership.js';
import type {StatePatch} from '../../packages/contracts/index.js';
import {fixture} from '../helpers.js';
export type SessionFixture=ReturnType<typeof fixture>;
export function selection(f:SessionFixture,id=f.id):MembershipUpdate{
  const report=f.service.membership(id);
  return {expectedEpoch:report.epoch,participants:report.current.map(row=>({agentId:row.agent.id,slot:row.agent.slot,character:row.character,profile:row.profile,enabled:row.agent.enabled}))};
}
export function saveOwnerExperience(f:SessionFixture){
  const original=f.say('集合時刻は確認が必要です。');f.say('二つ目の原文');f.say('三つ目の原文');f.start();
  const run=f.claim()!;expect(run.kind).toBe('decide');const owner=run.context.self.id;
  const patch:StatePatch={agentId:owner,sessionId:f.id,expectedVersion:run.context.self.privateState!.version,observationId:run.context.observation!.id,
    upsert:[{id:'pending-question',kind:'question',text:'OWNER_PRIVATE_UNRESOLVED_KEEP',evidence:[{kind:'message',id:original.id,version:original.revision}],
      question:{messageId:original.id,status:'open',addressing:'unknown',addressedTo:[],replyIds:[],topics:['集合']},
      resume:{kind:'related_topic',topic:'集合',agentId:null,notBefore:null}}],remove:[]};
  f.finish(run,{action:{decision:'ABSTAIN',reason:'retain an unresolved question'},statePatch:patch});
  const memory=f.claim()!;expect(memory.kind).toBe('memory');
  f.finish(memory,{notes:[{text:'OWNER_PRIVATE_MEMORY_KEEP',sourceMessageIds:[original.id]}]});
  return {owner,original};
}
export function replace(row:MemberSelection,character:{id:string;version:number}):MemberSelection{return {...row,agentId:null,character};}
