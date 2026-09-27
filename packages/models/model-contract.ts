import { z } from 'zod';
import {
  WireOutputSchemas, type Context, type RunKind, type PublicMessage, type MemoryNote,
} from '../contracts/index.js';
import type { SourceChunk } from '../contracts/source.js';

const EntryId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const AgentRef=z.string().regex(/^(?:self|a\d+)$/);
const MessageRef=z.string().regex(/^m\d+$/);
const SourceRef=z.string().regex(/^s\d+$/);
const MemoryRef=z.string().regex(/^r\d+$/);
const EvidenceRef=z.string().regex(/^(?:m|s)\d+$/);
const Act=z.enum(['answer','question','comment','agreement','joke','correction','topic']);
const Decision=z.enum(['SPEAK','ABSTAIN','DEFER','DRAFT','DROP','KEEP','REWRITE']);
const DeferKind=z.enum(['time','new_message','answer_from']);
const ResumeKind=z.enum(['new_message','answer_from','time','related_topic']);

const NullableShort=z.string().max(500).nullable();
const ModelAction=z.object({
  decision:Decision,
  reason:z.string().max(160).nullable(),
  text:z.string().trim().min(1).max(8000).nullable(),
  act:Act.nullable(),
  intent:z.string().trim().min(1).max(500).nullable(),
  reply:MessageRef.nullable(),
  to:z.array(AgentRef).max(16),
  defer:DeferKind.nullable(),
  afterMs:z.number().int().min(100).max(300000).nullable(),
  waitFor:AgentRef.nullable(),
}).strict();

const ModelResume=z.object({
  kind:ResumeKind,agent:AgentRef.nullable(),afterMs:z.number().int().min(100).max(86400000).nullable(),
  topic:z.string().trim().min(1).max(120).nullable(),
}).strict();
const ModelQuestion=z.object({
  message:MessageRef,status:z.enum(['open','partial','awaiting_confirmation','resolved','deferred']),
  addressing:z.enum(['explicit','inferred','unknown']),agents:z.array(AgentRef).max(16),
  replies:z.array(MessageRef).max(7),topics:z.array(z.string().trim().min(1).max(80)).min(1).max(4),
}).strict();
const ModelStateEntry=z.object({
  id:EntryId,kind:z.enum(['understanding','interest','question','intention']),text:z.string().trim().min(1).max(500),
  evidence:z.array(EvidenceRef).max(8),memories:z.array(MemoryRef).max(8),
  resume:ModelResume.nullable(),question:ModelQuestion.nullable(),
  participation:z.enum(['SATISFIED','CONTENT_LOOP']).nullable(),
}).strict();
const ModelState=z.object({upsert:z.array(ModelStateEntry).max(8),remove:z.array(EntryId).max(16)}).strict();

const ModelLookup=z.object({
  kind:z.enum(['messages','memories','message','source']),
  query:z.string().trim().min(1).max(200).nullable(),
  ref:z.string().regex(/^(?:m|s)\d+$/).nullable(),
  cursor:z.string().max(2048).nullable(),
}).strict();

const Time=z.number().int().nonnegative().nullable();
const ModelMemoryChange=z.object({
  operation:z.enum(['add','merge','correct','conflict']),
  text:z.string().trim().min(1).max(1000),
  sources:z.array(MessageRef).min(1).max(8),
  subject:z.union([z.literal('human'),AgentRef]),
  topic:z.string().trim().min(1).max(120),
  key:z.string().trim().min(1).max(160),
  value:z.string().trim().min(1).max(240),
  epistemic:z.enum(['self_report','hearsay','inference','uncertain']),
  validFrom:Time,validTo:Time,aliases:z.array(z.string().trim().min(1).max(80)).max(8),
  targets:z.array(MemoryRef).max(8),parents:z.array(MemoryRef).max(8),
}).strict();
const ModelMemory=z.object({
  notes:z.array(z.object({text:z.string().trim().min(1).max(1000),sources:z.array(MessageRef).min(1).max(8)}).strict()).max(4),
  changes:z.array(ModelMemoryChange).max(4),
}).strict();

const normal=z.object({lookup:z.array(ModelLookup).max(3),action:ModelAction.nullable(),state:ModelState.nullable()}).strict();
const memory=z.object({action:ModelMemory,state:ModelState.nullable()}).strict();
export const ModelWireOutputSchemas={observe:normal,decide:normal,draft:normal,review:normal,memory};

type AliasIndex={
  agentById:Map<string,string>;agentByRef:Map<string,string>;
  messageById:Map<string,string>;messageByRef:Map<string,PublicMessage>;
  sourceById:Map<string,string>;sourceByRef:Map<string,Context['sources'][number]|SourceChunk>;
  memoryById:Map<string,string>;memoryByRef:Map<string,MemoryNote>;
};
function unique<T extends {id:string}>(values:T[]):T[]{return [...new Map(values.map(value=>[value.id,value])).values()];}
function aliases(context:Context):AliasIndex{
  const agentById=new Map<string,string>([[context.self.id,'self']]),agentByRef=new Map<string,string>([['self',context.self.id]]);
  let ai=0;
  for(const p of context.participants)if(p.id!==context.self.id&&!agentById.has(p.id)){const ref='a'+ai++;agentById.set(p.id,ref);agentByRef.set(ref,p.id);}
  const messages=unique([...context.messages,...context.delta,...(context.retrieved??[]).flatMap(r=>r.messages)]);
  const messageById=new Map<string,string>(),messageByRef=new Map<string,PublicMessage>();
  messages.forEach((m,i)=>{const ref='m'+i;messageById.set(m.id,ref);messageByRef.set(ref,m);});
  const sources=unique([...context.sources,...(context.retrieved??[]).flatMap(r=>r.sources??[])]);
  const sourceById=new Map<string,string>(),sourceByRef=new Map<string,Context['sources'][number]|SourceChunk>();
  sources.forEach((s,i)=>{const ref='s'+i;sourceById.set(s.id,ref);sourceByRef.set(ref,s);});
  const memories=unique([...context.memories,...(context.retrieved??[]).flatMap(r=>r.memories)]);
  const memoryById=new Map<string,string>(),memoryByRef=new Map<string,MemoryNote>();
  memories.forEach((m,i)=>{const ref='r'+i;memoryById.set(m.id,ref);memoryByRef.set(ref,m);});
  return {agentById,agentByRef,messageById,messageByRef,sourceById,sourceByRef,memoryById,memoryByRef};
}
const compact=<T>(values:(T|undefined)[]):T[]=>values.filter((v):v is T=>v!==undefined);
function projectIntent(intent:any,index:AliasIndex){
  return {act:intent.act,intent:intent.intent,reply:intent.replyTo?index.messageById.get(intent.replyTo)??null:null,
    to:compact(intent.addressedTo.map((id:string)=>index.agentById.get(id)))};
}
function projectMessage(m:PublicMessage,index:AliasIndex){
  return {ref:index.messageById.get(m.id),author:m.authorId===null?'human':index.agentById.get(m.authorId)??'other',
    name:m.authorName,text:m.text,act:m.act,reply:m.replyTo?index.messageById.get(m.replyTo)??null:null,
    to:compact(m.addressedTo.map(id=>index.agentById.get(id))),deleted:m.deleted};
}
function projectSource(s:Context['sources'][number]|SourceChunk,index:AliasIndex){
  return {ref:index.sourceById.get(s.id),title:s.title,text:s.text,url:s.url,publishedAt:s.publishedAt,
    offset:'offset'in s?s.offset:undefined,totalChars:'totalChars'in s?s.totalChars:undefined,nextCursor:'nextCursor'in s?s.nextCursor:undefined};
}
function projectMemory(m:MemoryNote,index:AliasIndex){
  const meaning=m.provenance?.meaning;
  return {ref:index.memoryById.get(m.id),text:m.text,sources:compact(m.sourceMessageIds.map(id=>index.messageById.get(id))),
    status:m.provenance?.status??'ACTIVE',meaning:meaning?{subject:meaning.subjectId===null?'human':index.agentById.get(meaning.subjectId)??'other',
      topic:meaning.topic,key:meaning.key,value:meaning.value,epistemic:meaning.epistemic,validFrom:meaning.validFrom,validTo:meaning.validTo}:null};
}
function projectResume(r:any,context:Context,index:AliasIndex){
  return {kind:r.kind,agent:r.agentId?index.agentById.get(r.agentId)??null:null,
    afterMs:r.kind==='time'?Math.max(100,(r.notBefore??context.agenda?.now??0)-(context.agenda?.now??0)):null,
    topic:r.kind==='related_topic'?r.topic:null};
}
function projectState(context:Context,index:AliasIndex){
  return (context.self.privateState?.entries??[]).map(e=>({id:e.id,kind:e.kind,text:e.text,
    evidence:compact(e.evidence.map(ref=>ref.kind==='message'?index.messageById.get(ref.id):index.sourceById.get(ref.id))),
    memories:compact((e.derivedFrom??[]).map(id=>index.memoryById.get(id))),
    resume:e.resume?projectResume(e.resume,context,index):null,
    question:e.question?{message:index.messageById.get(e.question.messageId)??null,status:e.question.status,addressing:e.question.addressing,
      agents:compact(e.question.addressedTo.map(id=>index.agentById.get(id))),replies:compact(e.question.replyIds.map(id=>index.messageById.get(id))),topics:e.question.topics}:null,
    participation:e.participation?.code??null}));
}

/** Request-local semantic projection. Persistent UUIDs and transaction bindings never enter the live model request. */
export function projectModelContext(context:Context):unknown{
  const index=aliases(context),message=(m:PublicMessage)=>projectMessage(m,index);
  return {
    self:{ref:'self',state:projectState(context,index)},
    participants:context.participants.map(p=>({ref:index.agentById.get(p.id),name:p.name,status:p.status})),
    trigger:context.trigger,historyTruncated:context.historyTruncated,
    messages:context.messages.map(message),delta:context.delta.map(message),
    sources:context.sources.map(s=>projectSource(s,index)),memories:context.memories.map(m=>projectMemory(m,index)),
    questions:context.questions.map(q=>({message:index.messageById.get(q.messageId)??null,text:q.text,
      from:q.from===null?'human':index.agentById.get(q.from)??'other',to:compact((q.addressedTo??[]).map(id=>index.agentById.get(id))),
      inferredTo:compact((q.inferredAddressees??[]).map(id=>index.agentById.get(id)),),addressing:q.addressing,status:q.status,topics:q.topics??[]})),
    candidate:context.candidate?{intent:projectIntent(context.candidate.intent,index),text:context.candidate.text}:null,
    delivery:context.delivery?{purpose:context.delivery.purpose,complete:context.delivery.complete,
      entries:context.delivery.entries.map(e=>({ref:e.kind==='message'?index.messageById.get(e.id):index.sourceById.get(e.id),kind:e.kind,superseded:e.superseded,excerpt:e.excerpt}))}:null,
    progress:context.progress?{observationPending:context.progress.observationPending,memoryPending:context.progress.memoryPending}:null,
    coverage:context.coverage?{complete:context.coverage.complete}:null,
    agenda:context.agenda?{now:context.agenda.now,timeWakeEnabled:context.agenda.timeWakeEnabled,
      pending:context.agenda.pending.map(p=>({entryId:p.entryId,kind:p.kind,status:p.status,effectiveAt:p.effectiveAt})),
      triggered:context.agenda.triggered.map(p=>({entryId:p.entryId,kind:p.kind,status:p.status,effectiveAt:p.effectiveAt}))}:null,
    conversation:context.conversation?{signals:context.conversation.signals.map(s=>({kind:s.kind,evidence:compact(s.evidence.map(e=>index.messageById.get(e.id)))})),
      recentPurposes:context.conversation.recentPurposes.map(p=>({message:index.messageById.get(p.messageId)??null,act:p.act,purpose:p.purpose}))}:null,
    retrieved:(context.retrieved??[]).map(r=>({messages:r.messages.map(message),memories:r.memories.map(m=>projectMemory(m,index)),
      sources:(r.sources??[]).map(s=>projectSource(s,index)),nextCursor:r.nextCursor})),
  };
}

function required<T>(value:T|undefined,label:string):T{if(value===undefined)throw new Error('UNKNOWN_MODEL_REF:'+label);return value;}
const bindAgent=(ref:string,i:AliasIndex)=>required(i.agentByRef.get(ref),ref);
const bindMessage=(ref:string,i:AliasIndex)=>required(i.messageByRef.get(ref),ref);
const bindMemory=(ref:string,i:AliasIndex)=>required(i.memoryByRef.get(ref),ref);
const bindSource=(ref:string,i:AliasIndex)=>required(i.sourceByRef.get(ref),ref);
function bindEvidence(ref:string,index:AliasIndex){
  if(ref.startsWith('m')){const m=bindMessage(ref,index);return {kind:'message' as const,id:m.id,version:m.revision};}
  const s=bindSource(ref,index);return {kind:'source' as const,id:s.id,version:s.version??s.fetchedAt};
}
function bindIntent(a:any,index:AliasIndex){return {act:a.act,intent:a.intent,replyTo:a.reply?bindMessage(a.reply,index).id:null,addressedTo:a.to.map((r:string)=>bindAgent(r,index))};}
function bindDefer(a:any,index:AliasIndex){
  if(a.defer==='answer_from'){if(!a.waitFor)throw new Error('DEFER_AGENT_REQUIRED');return {kind:'answer_from',afterMs:100,agentId:bindAgent(a.waitFor,index)};}
  if(a.defer==='time'){if(a.afterMs===null)throw new Error('DEFER_TIME_REQUIRED');return {kind:'time',afterMs:a.afterMs,agentId:null};}
  if(a.defer==='new_message')return {kind:'new_message',afterMs:100,agentId:null};
  throw new Error('DEFER_KIND_REQUIRED');
}
function bindAction(kind:RunKind,a:any,index:AliasIndex){
  const reject=(condition:boolean)=>{if(condition)throw new Error('MODEL_ACTION_FIELDS_INVALID');};
  if(kind==='observe'){reject(a.decision!=='ABSTAIN'||!a.reason);return {decision:'ABSTAIN',reason:a.reason};}
  if(kind==='decide'){
    if(a.decision==='SPEAK'){reject(!a.act||!a.intent||a.reason!==null||a.defer!==null);return {decision:'SPEAK',intent:bindIntent(a,index)};}
    if(a.decision==='DEFER'){reject(!a.reason);return {decision:'DEFER',reason:a.reason,defer:bindDefer(a,index)};}
    reject(a.decision!=='ABSTAIN'||!a.reason);return {decision:'ABSTAIN',reason:a.reason};
  }
  if(kind==='draft'){
    if(a.decision==='DRAFT'){reject(!a.text);return {decision:'DRAFT',text:a.text};}
    reject(a.decision!=='DROP'||!a.reason);return {decision:'DROP',reason:a.reason};
  }
  if(kind==='review'){
    if(a.decision==='KEEP')return {decision:'KEEP'};
    if(a.decision==='REWRITE'){reject(!a.text||!a.act||!a.intent);return {decision:'REWRITE',text:a.text,intent:bindIntent(a,index)};}
    if(a.decision==='DEFER'){reject(!a.reason);return {decision:'DEFER',reason:a.reason,defer:bindDefer(a,index)};}
    reject(a.decision!=='DROP'||!a.reason);return {decision:'DROP',reason:a.reason};
  }
  throw new Error('MEMORY_ACTION_SEPARATE');
}
function bindResume(r:any,context:Context,index:AliasIndex){
  if(r.kind==='answer_from'){if(!r.agent)throw new Error('RESUME_AGENT_REQUIRED');return {kind:r.kind,agentId:bindAgent(r.agent,index),notBefore:null,topic:null};}
  if(r.kind==='time'){if(r.afterMs===null||!context.agenda)throw new Error('RESUME_TIME_REQUIRED');return {kind:r.kind,agentId:null,notBefore:context.agenda.now+r.afterMs,topic:null};}
  if(r.kind==='related_topic'){if(!r.topic)throw new Error('RESUME_TOPIC_REQUIRED');return {kind:r.kind,agentId:null,notBefore:null,topic:r.topic};}
  return {kind:'new_message',agentId:null,notBefore:null,topic:null};
}
function bindState(state:any,context:Context,index:AliasIndex){
  if(state===null)return null;
  const current=context.self.privateState,observation=context.observation;if(!current||!observation)throw new Error('MODEL_STATE_WITHOUT_BINDING');
  return {agentId:context.self.id,sessionId:current.sessionId,expectedVersion:current.version,observationId:observation.id,
    upsert:state.upsert.map((e:any)=>({id:e.id,kind:e.kind,text:e.text,evidence:e.evidence.map((r:string)=>bindEvidence(r,index)),
      derivedFrom:e.memories.map((r:string)=>bindMemory(r,index).id),
      question:e.question?{messageId:bindMessage(e.question.message,index).id,status:e.question.status,addressing:e.question.addressing,
        addressedTo:e.question.agents.map((r:string)=>bindAgent(r,index)),replyIds:e.question.replies.map((r:string)=>bindMessage(r,index).id),topics:e.question.topics}:undefined,
      participation:e.participation?{code:e.participation,throughInput:required(context.delivery?.throughInput,'delivery')}:undefined,
      resume:e.resume?bindResume(e.resume,context,index):null})),remove:state.remove};
}
function bindMemoryAction(a:any,index:AliasIndex){
  if(a.notes.length+a.changes.length>4)throw new Error('MEMORY_CHANGE_LIMIT');
  return {notes:a.notes.map((n:any)=>({text:n.text,sourceMessageIds:n.sources.map((r:string)=>bindMessage(r,index).id)})),
    changes:a.changes.map((c:any)=>{
      if(c.validFrom!==null&&c.validTo!==null&&c.validTo<=c.validFrom)throw new Error('MEMORY_INTERVAL_INVALID');
      if(c.operation!=='add'&&!c.targets.length)throw new Error('MEMORY_TARGET_REQUIRED');
      return {operation:c.operation,text:c.text,sourceMessageIds:c.sources.map((r:string)=>bindMessage(r,index).id),
        meaning:{subjectId:c.subject==='human'?null:bindAgent(c.subject,index),topic:c.topic,key:c.key,value:c.value,epistemic:c.epistemic,
          validFrom:c.validFrom,validTo:c.validTo,aliases:c.aliases},
        targets:c.targets.map((r:string)=>bindMemory(r,index).id),parents:c.parents.map((r:string)=>bindMemory(r,index).id)};})};
}
function bindLookup(request:any,index:AliasIndex){
  if(request.kind==='message'){if(!request.ref?.startsWith('m'))throw new Error('LOOKUP_MESSAGE_REF_REQUIRED');return {kind:'message',query:bindMessage(request.ref,index).id,cursor:null};}
  if(request.kind==='source'){if(!request.ref?.startsWith('s'))throw new Error('LOOKUP_SOURCE_REF_REQUIRED');return {kind:'source',query:bindSource(request.ref,index).id,cursor:request.cursor};}
  if(!request.query)throw new Error('LOOKUP_QUERY_REQUIRED');
  return {kind:request.kind,query:request.query,cursor:request.cursor};
}

export function parseModelOutput(kind:RunKind,value:string,wrapped=false):unknown{
  const text=value.trim().replace(/^\`\`\`(?:json)?\s*\n?/i,'').replace(/\n?\`\`\`$/,'');
  if(text.length>65536)throw new Error('MODEL_OUTPUT_TOO_LARGE');
  const data=JSON.parse(text) as {result?:unknown};
  return ModelWireOutputSchemas[kind].parse(wrapped?data.result:data);
}
export function bindModelOutput(kind:RunKind,parsed:unknown,context:Context):unknown{
  const index=aliases(context),value=parsed as any;
  if(kind!=='memory'&&value.lookup.length){
    if(value.action!==null||value.state!==null)throw new Error('LOOKUP_MUST_BE_EXCLUSIVE');
    return WireOutputSchemas[kind].parse({decision:'LOOKUP',requests:value.lookup.map((r:any)=>bindLookup(r,index))});
  }
  if(kind!=='memory'&&value.action===null)throw new Error('MODEL_ACTION_REQUIRED');
  const action=kind==='memory'?bindMemoryAction(value.action,index):bindAction(kind,value.action,index);
  return WireOutputSchemas[kind].parse({action,statePatch:bindState(value.state,context,index)});
}
