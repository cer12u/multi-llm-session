import { z } from 'zod';
import {
  WireOutputSchemas, type Context, type RunKind, type PublicMessage, type MemoryNote, type SourceChunk,
} from '../contracts/index.js';

const EntryId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const AgentRef=z.string().regex(/^(?:self|a\d+)$/);
const MessageRef=z.string().regex(/^m\d+$/);
const SourceRef=z.string().regex(/^s\d+$/);
const MemoryRef=z.string().regex(/^r\d+$/);
const EvidenceRef=z.string().regex(/^(?:m|s)\d+$/);
const Act=z.enum(['answer','question','comment','agreement','joke','correction','topic']);

const ModelIntent=z.object({
  act:Act,intent:z.string().trim().min(1).max(500),replyTo:MessageRef.nullable(),addressedTo:z.array(AgentRef).max(16),
}).strict();
const ModelDefer=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('time'),afterMs:z.number().int().min(100).max(300000)}).strict(),
  z.object({kind:z.literal('new_message')}).strict(),
  z.object({kind:z.literal('answer_from'),agent:AgentRef}).strict(),
]);
const ModelDecision=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('SPEAK'),intent:ModelIntent}).strict(),
  z.object({decision:z.literal('DEFER'),reason:z.string().max(160),defer:ModelDefer}).strict(),
  z.object({decision:z.literal('ABSTAIN'),reason:z.string().max(160)}).strict(),
]);
const ModelDraft=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('DRAFT'),text:z.string().trim().min(1).max(8000)}).strict(),
  z.object({decision:z.literal('DROP'),reason:z.string().max(160)}).strict(),
]);
const ModelReview=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('KEEP')}).strict(),
  z.object({decision:z.literal('REWRITE'),text:z.string().trim().min(1).max(8000),intent:ModelIntent}).strict(),
  z.object({decision:z.literal('DEFER'),reason:z.string().max(160),defer:ModelDefer}).strict(),
  z.object({decision:z.literal('DROP'),reason:z.string().max(160)}).strict(),
]);
const ModelObserve=z.object({decision:z.literal('ABSTAIN'),reason:z.string().max(160)}).strict();

const ModelResume=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('new_message')}).strict(),
  z.object({kind:z.literal('answer_from'),agent:AgentRef}).strict(),
  z.object({kind:z.literal('time'),afterMs:z.number().int().min(100).max(86400000)}).strict(),
  z.object({kind:z.literal('related_topic'),topic:z.string().trim().min(1).max(120)}).strict(),
]);
const ModelQuestion=z.object({
  message:MessageRef,status:z.enum(['open','partial','awaiting_confirmation','resolved','deferred']),
  addressing:z.enum(['explicit','inferred','unknown']),addressedTo:z.array(AgentRef).max(16),
  replies:z.array(MessageRef).max(7),topics:z.array(z.string().trim().min(1).max(80)).min(1).max(4),
}).strict();
const ModelParticipation=z.object({code:z.enum(['SATISFIED','CONTENT_LOOP'])}).strict();
const ModelStateEntry=z.object({
  id:EntryId,kind:z.enum(['understanding','interest','question','intention']),text:z.string().trim().min(1).max(500),
  evidence:z.array(EvidenceRef).max(8),derivedFrom:z.array(MemoryRef).max(8),
  question:ModelQuestion.nullable(),participation:ModelParticipation.nullable(),resume:ModelResume.nullable(),
}).strict();
const ModelStateDelta=z.object({upsert:z.array(ModelStateEntry).max(8),remove:z.array(EntryId).max(16)}).strict();

const Time=z.number().int().nonnegative().nullable();
const ModelMemoryMeaning=z.object({
  subject:z.union([z.literal('human'),AgentRef]),topic:z.string().trim().min(1).max(120),
  key:z.string().trim().min(1).max(160),value:z.string().trim().min(1).max(240),
  epistemic:z.enum(['self_report','hearsay','inference','uncertain']),validFrom:Time,validTo:Time,
  aliases:z.array(z.string().trim().min(1).max(80)).max(8),
}).strict().refine(x=>x.validFrom===null||x.validTo===null||x.validTo>x.validFrom,'Validity interval must increase');
const ModelMemoryChange=z.object({
  operation:z.enum(['add','merge','correct','conflict']),text:z.string().trim().min(1).max(1000),
  sourceMessages:z.array(MessageRef).min(1).max(8),meaning:ModelMemoryMeaning,
  targets:z.array(MemoryRef).max(8),parents:z.array(MemoryRef).max(8),
}).strict().refine(x=>x.operation==='add'||x.targets.length>0,'This operation needs an observed target');
const ModelMemory=z.object({
  notes:z.array(z.object({text:z.string().trim().min(1).max(1000),sourceMessages:z.array(MessageRef).min(1).max(8)}).strict()).max(4),
  changes:z.array(ModelMemoryChange).max(4),
}).strict().refine(x=>x.notes.length+x.changes.length<=4,'At most four memory changes per result');

const stateful=<T extends z.ZodTypeAny>(action:T)=>z.object({action,state:ModelStateDelta.nullable()}).strict();
const SearchLookup=z.object({kind:z.enum(['messages','memories']),query:z.string().trim().min(1).max(200),cursor:z.string().max(2048).nullable()}).strict();
const MessageLookup=z.object({kind:z.literal('message'),message:MessageRef}).strict();
const SourceLookup=z.object({kind:z.literal('source'),source:SourceRef,cursor:z.string().max(2048).nullable()}).strict();
export const ModelLookupSchema=z.object({
  decision:z.literal('LOOKUP'),requests:z.array(z.union([SearchLookup,MessageLookup,SourceLookup])).min(1).max(3),
}).strict();
export const ModelWireOutputSchemas={
  observe:z.union([stateful(ModelObserve),ModelLookupSchema]),
  decide:z.union([stateful(ModelDecision),ModelLookupSchema]),
  draft:z.union([stateful(ModelDraft),ModelLookupSchema]),
  review:z.union([stateful(ModelReview),ModelLookupSchema]),
  memory:stateful(ModelMemory),
};

type AliasIndex={
  agentById:Map<string,string>;agentByRef:Map<string,string>;
  messageById:Map<string,string>;messageByRef:Map<string,PublicMessage>;
  sourceById:Map<string,string>;sourceByRef:Map<string,Context['sources'][number]|SourceChunk>;
  memoryById:Map<string,string>;memoryByRef:Map<string,MemoryNote>;
};

function unique<T extends {id:string}>(values:T[]):T[]{
  return [...new Map(values.map(value=>[value.id,value])).values()];
}
function aliases(context:Context):AliasIndex{
  const agentById=new Map<string,string>([[context.self.id,'self']]),agentByRef=new Map<string,string>([['self',context.self.id]]);
  let ai=0;
  for(const participant of context.participants)if(participant.id!==context.self.id&&!agentById.has(participant.id)){
    const ref='a'+ai++;agentById.set(participant.id,ref);agentByRef.set(ref,participant.id);
  }
  const messages=unique([...context.messages,...context.delta,...(context.retrieved??[]).flatMap(r=>r.messages)]);
  const messageById=new Map<string,string>(),messageByRef=new Map<string,PublicMessage>();
  messages.forEach((message,i)=>{const ref='m'+i;messageById.set(message.id,ref);messageByRef.set(ref,message);});
  const sources=unique([...context.sources,...(context.retrieved??[]).flatMap(r=>r.sources??[])]);
  const sourceById=new Map<string,string>(),sourceByRef=new Map<string,Context['sources'][number]|SourceChunk>();
  sources.forEach((source,i)=>{const ref='s'+i;sourceById.set(source.id,ref);sourceByRef.set(ref,source);});
  const memories=unique([...context.memories,...(context.retrieved??[]).flatMap(r=>r.memories)]);
  const memoryById=new Map<string,string>(),memoryByRef=new Map<string,MemoryNote>();
  memories.forEach((memory,i)=>{const ref='r'+i;memoryById.set(memory.id,ref);memoryByRef.set(ref,memory);});
  return {agentById,agentByRef,messageById,messageByRef,sourceById,sourceByRef,memoryById,memoryByRef};
}
const mapped=<T>(value:T|undefined|null):T|null=>value??null;

function projectIntent(intent:Context['candidate'] extends {intent:infer T}|null?T:never,index:AliasIndex){
  const i=intent as {act:string;intent:string;replyTo:string|null;addressedTo:string[]};
  return {act:i.act,intent:i.intent,replyTo:i.replyTo?mapped(index.messageById.get(i.replyTo)):null,
    addressedTo:i.addressedTo.map(id=>index.agentById.get(id)).filter((v):v is string=>!!v)};
}
function projectMessage(message:PublicMessage,index:AliasIndex){
  return {ref:index.messageById.get(message.id),author:message.authorId===null?'human':index.agentById.get(message.authorId)??'other',
    authorName:message.authorName,text:message.text,act:message.act,replyTo:message.replyTo?mapped(index.messageById.get(message.replyTo)):null,
    addressedTo:message.addressedTo.map(id=>index.agentById.get(id)).filter((v):v is string=>!!v),deleted:message.deleted,createdAt:message.createdAt};
}
function projectSource(source:Context['sources'][number]|SourceChunk,index:AliasIndex){
  return {ref:index.sourceById.get(source.id),title:source.title,text:source.text,url:source.url,publishedAt:source.publishedAt,
    offset:'offset'in source?source.offset:undefined,totalChars:'totalChars'in source?source.totalChars:undefined,
    nextCursor:'nextCursor'in source?source.nextCursor:undefined};
}
function projectMemory(memory:MemoryNote,index:AliasIndex){
  const meaning=memory.provenance?.meaning;
  return {ref:index.memoryById.get(memory.id),text:memory.text,
    sourceMessages:memory.sourceMessageIds.map(id=>index.messageById.get(id)).filter((v):v is string=>!!v),
    status:memory.provenance?.status??'ACTIVE',
    meaning:meaning?{subject:meaning.subjectId===null?'human':index.agentById.get(meaning.subjectId)??'other',topic:meaning.topic,key:meaning.key,
      value:meaning.value,epistemic:meaning.epistemic,validFrom:meaning.validFrom,validTo:meaning.validTo,aliases:meaning.aliases}:null};
}
function projectResume(resume:NonNullable<NonNullable<Context['self']['privateState']>['entries'][number]['resume']>,context:Context,index:AliasIndex){
  if(resume.kind==='answer_from')return {kind:resume.kind,agent:index.agentById.get(resume.agentId!)??'other'};
  if(resume.kind==='time')return {kind:resume.kind,afterMs:Math.max(100,(resume.notBefore??context.agenda?.now??0)-(context.agenda?.now??0))};
  if(resume.kind==='related_topic')return {kind:resume.kind,topic:resume.topic};
  return {kind:'new_message'};
}
function projectState(context:Context,index:AliasIndex){
  return (context.self.privateState?.entries??[]).map(entry=>({
    id:entry.id,kind:entry.kind,text:entry.text,
    evidence:entry.evidence.map(ref=>ref.kind==='message'?index.messageById.get(ref.id):index.sourceById.get(ref.id)).filter((v):v is string=>!!v),
    derivedFrom:(entry.derivedFrom??[]).map(id=>index.memoryById.get(id)).filter((v):v is string=>!!v),
    question:entry.question?{message:index.messageById.get(entry.question.messageId)??null,status:entry.question.status,addressing:entry.question.addressing,
      addressedTo:entry.question.addressedTo.map(id=>index.agentById.get(id)).filter((v):v is string=>!!v),
      replies:entry.question.replyIds.map(id=>index.messageById.get(id)).filter((v):v is string=>!!v),topics:entry.question.topics}:null,
    participation:entry.participation?{code:entry.participation.code}:null,
    resume:entry.resume?projectResume(entry.resume,context,index):null,
  }));
}

/** Model-visible context intentionally omits UUIDs, optimistic-lock versions, observation hashes and profile/session bindings.
 * Short references are scoped to one request and are resolved only by the Worker against the captured Context. */
export function projectModelContext(context:Context):unknown{
  const index=aliases(context);
  const message=(m:PublicMessage)=>projectMessage(m,index);
  return {
    self:{ref:'self',name:context.self.character.name,persona:context.self.character.persona,state:projectState(context,index)},
    participants:context.participants.map(p=>({ref:index.agentById.get(p.id),name:p.name,status:p.status,enabled:p.enabled})),
    trigger:context.trigger,historyTruncated:context.historyTruncated,
    messages:context.messages.map(message),delta:context.delta.map(message),
    sources:context.sources.map(s=>projectSource(s,index)),memories:context.memories.map(m=>projectMemory(m,index)),
    questions:context.questions.map(q=>({message:index.messageById.get(q.messageId)??null,text:q.text,from:q.from===null?'human':index.agentById.get(q.from)??'other',
      addressedTo:(q.addressedTo??[]).map(id=>index.agentById.get(id)).filter((v):v is string=>!!v),
      inferredAddressees:(q.inferredAddressees??[]).map(id=>index.agentById.get(id)).filter((v):v is string=>!!v),
      addressing:q.addressing,status:q.status,classification:q.classification,topics:q.topics??[],excerpt:q.excerpt??false})),
    candidate:context.candidate?{intent:projectIntent(context.candidate.intent,index),text:context.candidate.text}:null,
    delivery:context.delivery?{purpose:context.delivery.purpose,complete:context.delivery.complete,
      entries:context.delivery.entries.map(e=>({ref:e.kind==='message'?index.messageById.get(e.id):index.sourceById.get(e.id),kind:e.kind,superseded:e.superseded,excerpt:e.excerpt}))}:null,
    progress:context.progress?{observationPending:context.progress.observationPending,memoryPending:context.progress.memoryPending}:null,
    coverage:context.coverage?{complete:context.coverage.complete}:null,
    agenda:context.agenda?{now:context.agenda.now,minimumIntervalMs:context.agenda.minimumIntervalMs,timeWakeEnabled:context.agenda.timeWakeEnabled,
      pending:context.agenda.pending.map(p=>({entryId:p.entryId,kind:p.kind,status:p.status,effectiveAt:p.effectiveAt,reason:p.reason})),
      triggered:context.agenda.triggered.map(p=>({entryId:p.entryId,kind:p.kind,status:p.status,effectiveAt:p.effectiveAt,reason:p.reason}))}:null,
    conversation:context.conversation?{signals:context.conversation.signals.map(s=>({kind:s.kind,evidence:s.evidence.map(e=>index.messageById.get(e.id)).filter((v):v is string=>!!v)})),
      recentPurposes:context.conversation.recentPurposes.map(p=>({message:index.messageById.get(p.messageId)??null,act:p.act,purpose:p.purpose,excerpt:p.excerpt})),
      previousAssessment:context.conversation.previousAssessment}:null,
    recall:context.recall?{selected:context.recall.selected.map(s=>({memory:index.memoryById.get(s.id)??null,score:s.score,provenance:s.provenance})).filter(s=>s.memory),
      omittedCount:context.recall.omittedForBudget.length}:null,
    retrieved:(context.retrieved??[]).map(r=>({request:{kind:r.request.kind,query:r.request.kind==='message'?(index.messageById.get(r.request.query)??'unavailable'):r.request.kind==='source'?(index.sourceById.get(r.request.query)??r.request.query):r.request.query},
      messages:r.messages.map(message),memories:r.memories.map(m=>projectMemory(m,index)),sources:(r.sources??[]).map(s=>projectSource(s,index)),nextCursor:r.nextCursor})),
  };
}

function required<T>(value:T|undefined,label:string):T{if(value===undefined)throw new Error('UNKNOWN_MODEL_REF:'+label);return value;}
function bindAgent(ref:string,index:AliasIndex){return required(index.agentByRef.get(ref),ref);}
function bindMessage(ref:string,index:AliasIndex){return required(index.messageByRef.get(ref),ref);}
function bindMemory(ref:string,index:AliasIndex){return required(index.memoryByRef.get(ref),ref);}
function bindSource(ref:string,index:AliasIndex){return required(index.sourceByRef.get(ref),ref);}
function bindEvidence(ref:string,index:AliasIndex){
  if(ref.startsWith('m')){const m=bindMessage(ref,index);return {kind:'message' as const,id:m.id,version:m.revision};}
  const s=bindSource(ref,index);return {kind:'source' as const,id:s.id,version:s.version??s.fetchedAt};
}
function bindIntent(intent:any,index:AliasIndex){
  return {act:intent.act,intent:intent.intent,replyTo:intent.replyTo?bindMessage(intent.replyTo,index).id:null,
    addressedTo:intent.addressedTo.map((ref:string)=>bindAgent(ref,index))};
}
function bindDefer(defer:any,index:AliasIndex){
  if(defer.kind==='answer_from')return {kind:defer.kind,afterMs:100,agentId:bindAgent(defer.agent,index)};
  return {kind:defer.kind,afterMs:defer.kind==='time'?defer.afterMs:100,agentId:null};
}
function bindResume(resume:any,context:Context,index:AliasIndex){
  if(resume.kind==='answer_from')return {kind:resume.kind,agentId:bindAgent(resume.agent,index),notBefore:null,topic:null};
  if(resume.kind==='time'){
    if(!context.agenda)throw new Error('MODEL_TIME_WITHOUT_AGENDA');
    return {kind:resume.kind,agentId:null,notBefore:context.agenda.now+resume.afterMs,topic:null};
  }
  if(resume.kind==='related_topic')return {kind:resume.kind,agentId:null,notBefore:null,topic:resume.topic};
  return {kind:'new_message',agentId:null,notBefore:null,topic:null};
}
function bindState(state:any,context:Context,index:AliasIndex){
  if(state===null)return null;
  const current=context.self.privateState,observation=context.observation;
  if(!current||!observation)throw new Error('MODEL_STATE_WITHOUT_BINDING');
  return {agentId:context.self.id,sessionId:current.sessionId,expectedVersion:current.version,observationId:observation.id,
    upsert:state.upsert.map((entry:any)=>({
      id:entry.id,kind:entry.kind,text:entry.text,evidence:entry.evidence.map((ref:string)=>bindEvidence(ref,index)),
      derivedFrom:entry.derivedFrom.map((ref:string)=>bindMemory(ref,index).id),
      question:entry.question?{messageId:bindMessage(entry.question.message,index).id,status:entry.question.status,addressing:entry.question.addressing,
        addressedTo:entry.question.addressedTo.map((ref:string)=>bindAgent(ref,index)),replyIds:entry.question.replies.map((ref:string)=>bindMessage(ref,index).id),topics:entry.question.topics}:undefined,
      participation:entry.participation?{code:entry.participation.code,throughInput:required(context.delivery?.throughInput,'delivery')}:undefined,
      resume:entry.resume?bindResume(entry.resume,context,index):null,
    })),remove:state.remove};
}
function bindAction(kind:RunKind,action:any,index:AliasIndex){
  if(kind==='decide'){
    if(action.decision==='SPEAK')return {...action,intent:bindIntent(action.intent,index)};
    if(action.decision==='DEFER')return {...action,defer:bindDefer(action.defer,index)};
  }
  if(kind==='review'){
    if(action.decision==='REWRITE')return {...action,intent:bindIntent(action.intent,index)};
    if(action.decision==='DEFER')return {...action,defer:bindDefer(action.defer,index)};
  }
  return action;
}
function bindMemoryAction(action:any,index:AliasIndex){
  return {notes:action.notes.map((note:any)=>({text:note.text,sourceMessageIds:note.sourceMessages.map((ref:string)=>bindMessage(ref,index).id)})),
    changes:action.changes.map((change:any)=>({operation:change.operation,text:change.text,
      sourceMessageIds:change.sourceMessages.map((ref:string)=>bindMessage(ref,index).id),
      meaning:{subjectId:change.meaning.subject==='human'?null:bindAgent(change.meaning.subject,index),topic:change.meaning.topic,key:change.meaning.key,
        value:change.meaning.value,epistemic:change.meaning.epistemic,validFrom:change.meaning.validFrom,validTo:change.meaning.validTo,aliases:change.meaning.aliases},
      targets:change.targets.map((ref:string)=>bindMemory(ref,index).id),parents:change.parents.map((ref:string)=>bindMemory(ref,index).id)}))};
}

export function parseModelOutput(kind:RunKind,value:string,wrapped=false):unknown{
  const text=value.trim().replace(/^\`\`\`(?:json)?\s*\n?/i,'').replace(/\n?\`\`\`$/,'');
  if(text.length>65536)throw new Error('MODEL_OUTPUT_TOO_LARGE');
  const data=JSON.parse(text) as {result?:unknown};
  return ModelWireOutputSchemas[kind].parse(wrapped?data.result:data);
}

/** Convert semantic model output into the exact internal transaction contract.
 * Every security/concurrency binding is taken from the captured Context, never trusted from the model. */
export function bindModelOutput(kind:RunKind,parsed:unknown,context:Context):unknown{
  const index=aliases(context),value=parsed as any;
  if(value?.decision==='LOOKUP'){
    const requests=value.requests.map((request:any)=>{
      if(request.kind==='message')return {kind:'message',query:bindMessage(request.message,index).id,cursor:null};
      if(request.kind==='source')return {kind:'source',query:bindSource(request.source,index).id,cursor:request.cursor};
      return request;
    });
    return WireOutputSchemas[kind].parse({decision:'LOOKUP',requests});
  }
  const action=kind==='memory'?bindMemoryAction(value.action,index):bindAction(kind,value.action,index);
  return WireOutputSchemas[kind].parse({action,statePatch:bindState(value.state,context,index)});
}
