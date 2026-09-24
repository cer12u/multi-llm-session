import {randomUUID} from 'node:crypto';
import {CharacterSchema,ModelProfileSchema,SettingsSchema,ensure,type Character,type ModelProfile,type PublicMessage,type Settings} from '../contracts/index.js';
import type {EpisodeRecord,MembershipRecord,MembershipReport,MembershipUpdate,MemberSelection} from '../contracts/session-membership.js';
import {hash} from '../domain/index.js';
import {validateProfileUrl} from '../config/credentials.js';
import {providerScope} from '../provider-state/index.js';
import {characterOf,profileOf,settingsOf,type AgentRow,type MessageRow,type Store} from '../storage-sqlite/index.js';
import type {SessionService} from './index.js';

type Member=AgentRow&{retired_at:number|null};
type Resolved={selection:MemberSelection;character:Character;profile:ModelProfile;previous:Member|undefined;id:string};
const snapshot=(a:AgentRow)=>({id:a.id,slot:a.slot,character:characterOf(a),profile:profileOf(a),enabled:!!a.enabled});
function transaction(service:SessionService){ensure(service.store.db.inTransaction,500,'MEMBERSHIP_TRANSACTION_REQUIRED');}

export function episodes(store:Store,id:string):EpisodeRecord[]{
  ensure(store.get('SELECT id FROM sessions WHERE id=?',id),404,'SESSION_NOT_FOUND');
  return store.all<{number:number;started_at:number;last_message_at:number|null;first_sequence:number;last_sequence:number;closed_at:number|null;end_sequence:number|null;origin:string}>(
    'SELECT * FROM session_episodes WHERE session_id=? ORDER BY number',id).map(e=>({number:e.number,startedAt:e.started_at,lastMessageAt:e.last_message_at,
      firstSequence:e.first_sequence,lastSequence:e.last_sequence,closedAt:e.closed_at,endSequence:e.end_sequence,origin:e.origin}));
}
export function closeEpisode(store:Store,id:string,now:number):void{
  ensure(store.db.inTransaction,500,'MEMBERSHIP_TRANSACTION_REQUIRED');
  store.run('UPDATE session_episodes SET closed_at=?,end_sequence=last_sequence WHERE session_id=? AND closed_at IS NULL',now,id);
}
export function publishedAuthor(store:Store,message:MessageRow):Pick<PublicMessage,'authorName'|'characterId'|'characterVersion'>{
  if(message.author_id===null)return {authorName:'あなた',characterId:null,characterVersion:null};
  const saved=store.get<{author_id:string;author_name:string;character_id:string;character_version:number}>('SELECT * FROM message_author_snapshots WHERE message_id=?',message.id);
  ensure(saved&&saved.author_id===message.author_id,500,'MESSAGE_AUTHOR_SNAPSHOT_REQUIRED');
  return {authorName:saved.author_name,characterId:saved.character_id,characterVersion:saved.character_version};
}
export function membershipReport(service:SessionService,id:string):MembershipReport{
  const s=service.session(id),all=service.store.all<Member>('SELECT * FROM agent_instances WHERE session_id=? ORDER BY rowid',id);
  const record=(a:Member):MembershipRecord=>({agent:service.publicAgent(a),character:{id:characterOf(a).id,version:characterOf(a).version},
    profile:{id:profileOf(a).id,version:profileOf(a).version},retiredAt:a.retired_at});
  const current=all.filter(a=>a.retired_at===null),enabled=current.filter(a=>a.enabled),online=enabled.filter(a=>service.publicAgent(a).workerOnline);
  return {sessionId:id,epoch:s.epoch,lifecycle:s.lifecycle,current:current.map(record),archived:all.filter(a=>a.retired_at!==null).map(record),
    counts:{current:current.length,enabled:enabled.length,online:online.length,disabled:current.length-enabled.length,offline:enabled.length-online.length,errors:enabled.filter(a=>a.error_count>0||a.last_error!==null).length},
    slots:Object.keys(service.config.workerTokens),
    characters:service.store.all<{definition:string}>('SELECT definition FROM characters ORDER BY id,version DESC').map(row=>{const c=CharacterSchema.parse(JSON.parse(row.definition));return {id:c.id,version:c.version,name:c.name};}),
    profiles:service.store.all<{definition:string}>('SELECT definition FROM model_profiles ORDER BY id,version DESC').map(row=>{const p=ModelProfileSchema.parse(JSON.parse(row.definition));return {id:p.id,version:p.version,provider:p.provider,model:p.model};}),
    episodes:episodes(service.store,id)};
}
function resolve(service:SessionService,selection:MemberSelection,previous?:Member):Resolved{
  ensure(service.config.workerTokens[selection.slot],422,'UNKNOWN_WORKER_SLOT');
  if(previous){
    ensure(previous.retired_at===null,409,'AGENT_RETIRED');
    ensure(previous.slot===selection.slot,422,'EXISTING_AGENT_SLOT_IMMUTABLE');
    ensure(characterOf(previous).id===selection.character.id,422,'NEW_CHARACTER_REQUIRES_NEW_INSTANCE');
  }
  const c=service.store.get<{definition:string;hash:string}>('SELECT definition,hash FROM characters WHERE id=? AND version=?',selection.character.id,selection.character.version);
  const p=service.store.get<{definition:string;hash:string}>('SELECT definition,hash FROM model_profiles WHERE id=? AND version=?',selection.profile.id,selection.profile.version);
  ensure(c,422,'CHARACTER_VERSION_NOT_FOUND');ensure(p,422,'PROFILE_VERSION_NOT_FOUND');
  const character=CharacterSchema.parse(JSON.parse(c.definition)),profile=ModelProfileSchema.parse(JSON.parse(p.definition));
  ensure(hash(character)===c.hash&&hash(profile)===p.hash,409,'MEMBER_DEFINITION_CORRUPT');
  validateProfileUrl(profile);ensure(profile.provider==='mock'||service.config.allowLive,403,'LIVE_DISABLED');
  return {selection,character,profile,previous,id:previous?.id??randomUUID()};
}
function compatible(service:SessionService,sessionId:string,profiles:ModelProfile[]):void{
  const scopes=new Map<string,string>();
  const others=service.store.all<AgentRow>("SELECT a.* FROM agent_instances a JOIN sessions s ON s.id=a.session_id WHERE a.session_id<>? AND a.retired_at IS NULL AND s.lifecycle!='ENDED'",sessionId).map(profileOf);
  for(const p of [...profiles,...others]){
    const scope=providerScope(p),policy=JSON.stringify([p.maxConcurrent,p.failureThreshold,p.circuitCooldownMs]);
    ensure(!scopes.has(scope)||scopes.get(scope)===policy,422,'ACTIVE_PROVIDER_POLICY_CONFLICT');scopes.set(scope,policy);
  }
}
function journal(service:SessionService,id:string,agent:string,kind:'JOIN'|'RETIRE'|'APPLY',epoch:number,before:unknown,after:unknown):void{
  service.store.run('INSERT INTO session_member_changes(session_id,agent_id,kind,epoch,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)',
    id,agent,kind,epoch,before===null?null:JSON.stringify(before),JSON.stringify(after),service.now());
}
/** Called only by the SessionService command transaction; this helper never invokes a Worker or model. */
export function applyMembership(service:SessionService,id:string,input:MembershipUpdate,nextSelfAt:(settings:Settings)=>number):{changed:boolean;added:string[];retired:string[];updated:string[]}{
  transaction(service);const s=service.session(id);
  ensure(s.lifecycle!=='ENDED',409,'SESSION_ENDED');ensure(s.lifecycle==='DRAFT'||s.lifecycle==='PAUSED',409,'PAUSE_REQUIRED');
  ensure(s.epoch===input.expectedEpoch,409,'MEMBERSHIP_CHANGED_RELOAD');
  const current=service.store.all<Member>('SELECT * FROM agent_instances WHERE session_id=? AND retired_at IS NULL ORDER BY rowid',id);
  const retained=new Set(input.participants.flatMap(p=>p.agentId?[p.agentId]:[]));
  const plan=input.participants.map(p=>{const old=p.agentId?current.find(a=>a.id===p.agentId):undefined;
    ensure(!p.agentId||old,422,'MEMBER_NOT_CURRENT');return resolve(service,p,old);});
  compatible(service,id,plan.map(p=>p.profile));
  const removed=current.filter(a=>!retained.has(a.id));
  const changed=plan.filter(p=>!p.previous||p.previous.character_json!==JSON.stringify(p.character)||p.previous.profile_json!==JSON.stringify(p.profile)||!!p.previous.enabled!==p.selection.enabled);
  const result={changed:removed.length+changed.length>0,added:changed.filter(p=>!p.previous).map(p=>p.id),retired:removed.map(a=>a.id),updated:changed.filter(p=>p.previous).map(p=>p.id)};
  if(!result.changed)return result;
  const epoch=s.epoch+1;service.store.run('UPDATE sessions SET epoch=?,revision=revision+1 WHERE id=?',epoch,id);
  for(const old of removed){
    service.store.run("UPDATE agent_instances SET enabled=0,retired_at=?,state='retired' WHERE id=?",service.now(),old.id);
    // A retired owner can no longer replay a cached private LOOKUP response through its reused Worker slot.
    // Only response caches are revoked; exact bound run contexts, state journals and memories remain private audit records.
    service.store.run("DELETE FROM command_receipts WHERE scope IN (SELECT 'worker:'||slot||':'||id||':lookup' FROM runs WHERE agent_id=?)",old.id);
    journal(service,id,old.id,'RETIRE',epoch,snapshot(old),{...snapshot(old),enabled:false,retiredAt:service.now()});
  }
  for(const p of changed){
    const state=p.selection.enabled?(s.lifecycle==='PAUSED'?'paused':'listening'):'disabled';
    if(!p.previous)service.store.run('INSERT INTO agent_instances(id,session_id,slot,character_json,profile_json,enabled,state,next_self_at) VALUES(?,?,?,?,?,?,?,?)',
      p.id,id,p.selection.slot,JSON.stringify(p.character),JSON.stringify(p.profile),p.selection.enabled?1:0,state,nextSelfAt(settingsOf(s)));
    else{
      const profileChanged=hash(profileOf(p.previous))!==hash(p.profile);
      service.store.run('UPDATE agent_instances SET character_json=?,profile_json=?,enabled=?,state=?,error_count=?,retry_at=?,last_error=? WHERE id=?',
        JSON.stringify(p.character),JSON.stringify(p.profile),p.selection.enabled?1:0,state,profileChanged?0:p.previous.error_count,
        profileChanged?null:p.previous.retry_at,profileChanged?null:p.previous.last_error,p.id);
    }
    journal(service,id,p.id,p.previous?'APPLY':'JOIN',epoch,p.previous?snapshot(p.previous):null,snapshot(service.agent(p.id)));
  }
  return result;
}
/** A new session with new owner IDs and exact frozen definitions. No original, memory, cursor, agenda, or run is copied. */
export function cloneDefinitions(service:SessionService,sourceId:string,title:string,nextSelfAt:(settings:Settings)=>number):{id:string;copy:'definitions-only'}{
  transaction(service);const source=service.session(sourceId),settings=SettingsSchema.parse(settingsOf(source));
  const originals=service.store.all<Member>('SELECT * FROM agent_instances WHERE session_id=? AND retired_at IS NULL ORDER BY rowid',sourceId);
  ensure(originals.length>=3&&originals.length<=16,422,'CLONE_PARTICIPANT_COUNT');
  const selections=originals.map(a=>({agentId:null,slot:a.slot,character:{id:characterOf(a).id,version:characterOf(a).version},profile:{id:profileOf(a).id,version:profileOf(a).version},enabled:!!a.enabled}));
  const plan=selections.map(p=>resolve(service,p));const id=randomUUID();compatible(service,id,plan.map(p=>p.profile));
  service.store.run("INSERT INTO sessions(id,title,created_at,last_activity_at,settings_json,lifecycle) VALUES(?,?,?,?,?,'DRAFT')",id,title,service.now(),service.now(),JSON.stringify(settings));
  for(const p of plan){
    service.store.run('INSERT INTO agent_instances(id,session_id,slot,character_json,profile_json,enabled,next_self_at) VALUES(?,?,?,?,?,?,?)',p.id,id,p.selection.slot,JSON.stringify(p.character),JSON.stringify(p.profile),p.selection.enabled?1:0,nextSelfAt(settings));
    journal(service,id,p.id,'JOIN',0,null,snapshot(service.agent(p.id)));
  }
  return {id,copy:'definitions-only'};
}
