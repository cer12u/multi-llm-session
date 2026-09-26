import { z } from 'zod';
import {
  ActSchema, WireOutputSchemas,
  type Context, type Intent, type RunKind, type StatePatch,
} from '../contracts/index.js';

const EntryId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const Participant=z.string().regex(/^p\d+$/);
const AgentRef=z.union([z.literal('self'),Participant]);
const MessageRef=z.string().regex(/^m\d+$/);
const SourceRef=z.string().regex(/^s\d+$/);
const MemoryRef=z.string().regex(/^k\d+$/);
const EvidenceRef=z.union([MessageRef,SourceRef]);
const Time=z.number().int().nonnegative().nullable();

const ResumeSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('new_message')}).strict(),
  z.object({kind:z.literal('answer_from'),participant:Participant}).strict(),
  z.object({kind:z.literal('time'),notBefore:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('related_topic'),topic:z.string().trim().min(1).max(120)}).strict(),
]);
const QuestionSchema=z.object({
  message:MessageRef,status:z.enum(['open','partial','awaiting_confirmation','resolved','deferred']),
  addressing:z.enum(['explicit','inferred','unknown']),addressedTo:z.array(AgentRef).max(16),
  replies:z.array(MessageRef).max(7),topics:z.array(z.string().trim().min(1).max(80)).min(1).max(4),
}).strict();
const StateEntrySchema=z.object({
  id:EntryId,kind:z.enum(['understanding','interest','question','intention']),text:z.string().trim().min(1).max(500),
  evidence:z.array(EvidenceRef).max(8),derivedFrom:z.array(MemoryRef).max(8).optional(),
  question:QuestionSchema.optional(),participation:z.object({code:z.enum(['SATISFIED','CONTENT_LOOP'])}).strict().optional(),
  resume:ResumeSchema.nullable(),
}).strict();
const StateDeltaSchema=z.object({upsert:z.array(StateEntrySchema).max(8),remove:z.array(EntryId).max(16)}).strict();

const IntentSchema=z.object({
  act:ActSchema,intent:z.string().trim().min(1).max(500),replyTo:MessageRef.nullable(),addressedTo:z.array(Participant).max(16),
}).strict();
const DeferSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('time'),afterMs:z.number().int().min(100).max(300000)}).strict(),
  z.object({kind:z.literal('new_message'),afterMs:z.number().int().min(100).max(300000)}).strict(),
  z.object({kind:z.literal('answer_from'),afterMs:z.number().int().min(100).max(300000),participant:Participant}).strict(),
]);
const DecisionSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('SPEAK'),intent:IntentSchema}).strict(),
  z.object({decision:z.literal('DEFER'),reason:z.string().max(160),defer:DeferSchema}).strict(),
  z.object({decision:z.literal('ABSTAIN'),reason:z.string().max(160)}).strict(),
]);
const DraftSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('DRAFT'),text:z.string().trim().min(1).max(8000)}).strict(),
  z.object({decision:z.literal('DROP'),reason:z.string().max(160)}).strict(),
]);
const ReviewSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('KEEP')}).strict(),
  z.object({decision:z.literal('REWRITE'),text:z.string().trim().min(1).max(8000),intent:IntentSchema}).strict(),
  z.object({decision:z.literal('DEFER'),reason:z.string().max(160),defer:DeferSchema}).strict(),
  z.object({decision:z.literal('DROP'),reason:z.string().max(160)}).strict(),
]);
const ObserveSchema=z.object({decision:z.literal('ABSTAIN'),reason:z.string().max(160)}).strict();
const MeaningSchema=z.object({
  subject:z.union([z.literal('human'),AgentRef]),topic:z.string().trim().min(1).max(120),
  key:z.string().trim().min(1).max(160),value:z.string().trim().min(1).max(240),
  epistemic:z.enum(['self_report','hearsay','inference','uncertain']),validFrom:Time,validTo:Time,
  aliases:z.array(z.string().trim().min(1).max(80)).max(8),
}).strict().refine(x=>x.validFrom===null||x.validTo===null||x.validTo>x.validFrom,'Validity interval must increase');
const MemoryChangeSchema=z.object({
  operation:z.enum(['add','merge','correct','conflict']),text:z.string().trim().min(1).max(1000),
  sources:z.array(MessageRef).min(1).max(8),meaning:MeaningSchema,targets:z.array(MemoryRef).max(8),parents:z.array(MemoryRef).max(8),
}).strict().refine(x=>x.operation==='add'||x.targets.length>0,'This operation needs an observed target');
const MemorySchema=z.object({
  notes:z.array(z.object({text:z.string().trim().min(1).max(1000),sources:z.array(MessageRef).min(1).max(8)}).strict()).max(4),
  changes:z.array(MemoryChangeSchema).max(4).optional(),
}).strict().refine(x=>x.notes.length+(x.changes?.length??0)<=4,'At most four memory changes per result');

const ResultSchemas={
  observe:z.object({type:z.literal('result'),action:ObserveSchema,state:StateDeltaSchema.nullable()}).strict(),
  decide:z.object({type:z.literal('result'),action:DecisionSchema,state:StateDeltaSchema.nullable()}).strict(),
  draft:z.object({type:z.literal('result'),action:DraftSchema,state:StateDeltaSchema.nullable()}).strict(),
  review:z.object({type:z.literal('result'),action:ReviewSchema,state:StateDeltaSchema.nullable()}).strict(),
  memory:z.object({type:z.literal('result'),action:MemorySchema,state:StateDeltaSchema.nullable()}).strict(),
};
const LookupRequestSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('messages'),query:z.string().trim().min(1).max(200),cursor:z.string().max(2048).nullable()}).strict(),
  z.object({kind:z.literal('memories'),query:z.string().trim().min(1).max(200),cursor:z.string().max(2048).nullable()}).strict(),
  z.object({kind:z.literal('message'),ref:MessageRef}).strict(),
  z.object({kind:z.literal('source'),ref:SourceRef,cursor:z.string().max(2048).nullable()}).strict(),
]);
const LookupSchema=z.object({type:z.literal('lookup'),requests:z.array(LookupRequestSchema).min(1).max(3)}).strict();
export const ModelWireOutputSchemas={
  observe:z.union([ResultSchemas.observe,LookupSchema]),decide:z.union([ResultSchemas.decide,LookupSchema]),
  draft:z.union([ResultSchemas.draft,LookupSchema]),review:z.union([ResultSchemas.review,LookupSchema]),memory:ResultSchemas.memory,
};

export type ModelProjection={context:Record<string,unknown>;handles:ReturnType<typeof handlesFor>};
function uniq<T>(items:T[],key:(item:T)=>string):T[]{const seen=new Set<string>();return items.filter(item=>{const k=key(item);if(seen.has(k))return false;seen.add(k);return true;});}
function handlesFor(context:Context){
  const participant=new Map<string,string>(),participantBack=new Map<string,string>();let pi=0;
  participant.set(context.self.id,'self');participantBack.set('self',context.self.id);
  for(const p of context.participants)if(p.id!==context.self.id&&!participant.has(p.id)){const h='p'+pi++;participant.set(p.id,h);participantBack.set(h,p.id);}
  const messages=uniq([...context.messages,...context.delta,...(context.retrieved??[]).flatMap(r=>r.messages)],m=>m.id).sort((a,b)=>a.sequence-b.sequence);
  const message=new Map(messages.map((m,i)=>[m.id,'m'+i])),messageBack=new Map(messages.map((m,i)=>['m'+i,m.id]));
  const sources=uniq([...context.sources,...(context.retrieved??[]).flatMap(r=>r.sources??[])],s=>s.id);
  const source=new Map(sources.map((s,i)=>[s.id,'s'+i])),sourceBack=new Map(sources.map((s,i)=>['s'+i,s.id]));
  const memories=uniq([...context.memories,...(context.retrieved??[]).flatMap(r=>r.memories)],m=>m.id);
  const memory=new Map(memories.map((m,i)=>[m.id,'k'+i])),memoryBack=new Map(memories.map((m,i)=>['k'+i,m.id]));
  return {participant,participantBack,message,messageBack,source,sourceBack,memory,memoryBack,messages,sources,memories};
}
function need(map:Map<string,string>,key:string,code:string):string{const value=map.get(key);if(!value)throw new Error(code);return value;}
function participantRef(id:string|null,handles:ReturnType<typeof handlesFor>):string{return id===null?'human':handles.participant.get(id)??'former';}
function projectResume(value:any,handles:ReturnType<typeof handlesFor>){if(!value)return null;if(value.kind==='answer_from')return {kind:value.kind,participant:handles.participant.get(value.agentId)??'unavailable'};if(value.kind==='time')return {kind:value.kind,notBefore:value.notBefore};if(value.kind==='related_topic')return {kind:value.kind,topic:value.topic};return {kind:'new_message'};}
function projectIntent(value:Intent,handles:ReturnType<typeof handlesFor>){return {act:value.act,intent:value.intent,replyTo:value.replyTo?handles.message.get(value.replyTo)??null:null,addressedTo:value.addressedTo.map(id=>handles.participant.get(id)).filter((x):x is string=>!!x&&x!=='self')};}

export function projectModelContext(context:Context):ModelProjection{
  const h=handlesFor(context);
  const state=context.self.privateState?.entries.map(entry=>({id:entry.id,kind:entry.kind,text:entry.text,
    grounded:entry.evidence.length>0,evidenceAvailable:entry.evidence.map(ref=>ref.kind==='message'?h.message.get(ref.id):h.source.get(ref.id)).filter(Boolean),
    memoryContextAvailable:(entry.derivedFrom??[]).map(id=>h.memory.get(id)).filter(Boolean),
    question:entry.question?{status:entry.question.status,addressing:entry.question.addressing,topics:entry.question.topics}:undefined,
    participation:entry.participation?{code:entry.participation.code}:undefined,resume:projectResume(entry.resume,h)}))??[];
  const messages=h.messages.map(m=>({ref:h.message.get(m.id),from:participantRef(m.authorId,h),name:m.authorName,text:m.text,act:m.act,
    replyTo:m.replyTo?h.message.get(m.replyTo)??null:null,addressedTo:m.addressedTo.map(id=>h.participant.get(id)).filter(Boolean),deleted:m.deleted}));
  const sources=h.sources.map(s=>({ref:h.source.get(s.id),title:s.title,text:s.text,url:s.url,publishedAt:s.publishedAt,excerpt:s.offset!==undefined?{offset:s.offset,totalChars:s.totalChars,nextCursor:s.nextCursor}:undefined}));
  const memories=h.memories.map(m=>({ref:h.memory.get(m.id),text:m.text,sources:m.sourceMessageIds.map(id=>h.message.get(id)).filter(Boolean),
    provenance:m.provenance?{status:m.provenance.status,verified:false,meaning:m.provenance.meaning?{subject:participantRef(m.provenance.meaning.subjectId,h),topic:m.provenance.meaning.topic,key:m.provenance.meaning.key,value:m.provenance.meaning.value,epistemic:m.provenance.meaning.epistemic,validFrom:m.provenance.meaning.validFrom,validTo:m.provenance.meaning.validTo,aliases:m.provenance.meaning.aliases}:null,
      parents:m.provenance.parents.map(id=>h.memory.get(id)).filter(Boolean)}:undefined}));
  const projected:Record<string,unknown>={
    self:{ref:'self',name:context.self.character.name,persona:context.self.character.persona,state},
    participants:context.participants.filter(p=>p.id!==context.self.id).map(p=>({ref:h.participant.get(p.id),name:p.name,status:p.status,enabled:p.enabled})),
    messages,recent:context.messages.map(m=>h.message.get(m.id)).filter(Boolean),delta:context.delta.map(m=>h.message.get(m.id)).filter(Boolean),
    sources,memories,trigger:context.trigger,historyTruncated:context.historyTruncated,
    delivery:context.delivery?{purpose:context.delivery.purpose,complete:context.delivery.complete,entries:context.delivery.entries.map(e=>({ref:e.kind==='message'?h.message.get(e.id):h.source.get(e.id),kind:e.kind,superseded:e.superseded,excerpt:e.excerpt})).filter(e=>e.ref)}:undefined,
    progress:context.progress?{observationPending:context.progress.observationPending,memoryPending:context.progress.memoryPending}:undefined,
    selection:context.selection,coverage:context.coverage?{complete:context.coverage.complete}:undefined,
    agenda:context.agenda?{now:context.agenda.now,minimumIntervalMs:context.agenda.minimumIntervalMs,timeWakeEnabled:context.agenda.timeWakeEnabled,nextAutonomousAt:context.agenda.nextAutonomousAt,
      pending:context.agenda.pending.map(x=>({entryId:x.entryId,kind:x.kind,status:x.status,effectiveAt:x.effectiveAt,reason:x.reason})),triggered:context.agenda.triggered.map(x=>({entryId:x.entryId,kind:x.kind,status:x.status,effectiveAt:x.effectiveAt,reason:x.reason}))}:undefined,
    questions:context.questions.map(q=>({message:h.message.get(q.messageId)??null,text:q.text,from:q.from?participantRef(q.from,h):'human',addressedTo:(q.addressedTo??[]).map(id=>h.participant.get(id)).filter(Boolean),
      inferredAddressees:(q.inferredAddressees??[]).map(id=>h.participant.get(id)).filter(Boolean),addressing:q.addressing,status:q.status,classification:q.classification,topics:q.topics,excerpt:q.excerpt})),
    candidate:context.candidate?{intent:projectIntent(context.candidate.intent,h),text:context.candidate.text}:null,
    recall:context.recall?{algorithm:context.recall.algorithm,selected:context.recall.selected.map(x=>({ref:h.memory.get(x.id)??null,score:x.score,provenance:x.provenance})).filter(x=>x.ref),omitted:context.recall.omittedForBudget.length}:undefined,
    retrieved:(context.retrieved??[]).map(r=>({request:r.request.kind==='source'?{kind:'source',ref:h.source.get(r.request.query)??null,cursor:r.request.cursor}:r.request.kind==='message'?{kind:'message',ref:h.message.get(r.request.query)??null}:r.request,
      messages:r.messages.map(m=>h.message.get(m.id)).filter(Boolean),memories:r.memories.map(m=>h.memory.get(m.id)).filter(Boolean),sources:(r.sources??[]).map(s=>h.source.get(s.id)).filter(Boolean),nextCursor:r.nextCursor})),
    conversation:context.conversation?{advisoryOnly:true,signals:context.conversation.signals.map(s=>({kind:s.kind,evidence:s.evidence.map(e=>h.message.get(e.id)).filter(Boolean)})),
      recentPurposes:context.conversation.recentPurposes.map(p=>({message:h.message.get(p.messageId)??null,act:p.act,purpose:p.purpose,excerpt:p.excerpt})),previousAssessment:context.conversation.previousAssessment}:undefined,
  };
  const serialized=JSON.stringify(projected);
  for(const forbidden of [context.self.id,context.self.privateState?.sessionId,context.observation?.id,context.self.profileHash])if(forbidden&&serialized.includes(forbidden))throw new Error('SYSTEM_BINDING_LEAK');
  return {context:projected,handles:h};
}

function internalResume(value:any,h:ReturnType<typeof handlesFor>){
  if(!value)return null;
  if(value.kind==='answer_from')return {kind:'answer_from',agentId:need(h.participantBack,value.participant,'UNKNOWN_RESUME_HANDLE'),notBefore:null,topic:null};
  if(value.kind==='time')return {kind:'time',agentId:null,notBefore:value.notBefore,topic:null};
  if(value.kind==='related_topic')return {kind:'related_topic',agentId:null,notBefore:null,topic:value.topic};
  return {kind:'new_message',agentId:null,notBefore:null,topic:null};
}
function internalIntent(value:any,h:ReturnType<typeof handlesFor>):Intent{return {act:value.act,intent:value.intent,replyTo:value.replyTo?need(h.messageBack,value.replyTo,'UNKNOWN_MESSAGE_HANDLE'):null,addressedTo:value.addressedTo.map((x:string)=>need(h.participantBack,x,'UNKNOWN_PARTICIPANT_HANDLE'))};}
function internalDefer(value:any,h:ReturnType<typeof handlesFor>){return {kind:value.kind,afterMs:value.afterMs,agentId:value.kind==='answer_from'?need(h.participantBack,value.participant,'UNKNOWN_DEFER_HANDLE'):null};}
function internalAction(kind:RunKind,value:any,h:ReturnType<typeof handlesFor>){
  if(kind==='observe')return value;
  if(kind==='decide')return value.decision==='SPEAK'?{...value,intent:internalIntent(value.intent,h)}:value.decision==='DEFER'?{decision:'DEFER',reason:value.reason,defer:internalDefer(value.defer,h)}:value;
  if(kind==='review')return value.decision==='REWRITE'?{...value,intent:internalIntent(value.intent,h)}:value.decision==='DEFER'?{decision:'DEFER',reason:value.reason,defer:internalDefer(value.defer,h)}:value;
  if(kind==='draft')return value;
  return {notes:value.notes.map((n:any)=>({text:n.text,sourceMessageIds:n.sources.map((ref:string)=>need(h.messageBack,ref,'UNKNOWN_MEMORY_SOURCE_HANDLE'))})),
    ...(value.changes?{changes:value.changes.map((c:any)=>({operation:c.operation,text:c.text,sourceMessageIds:c.sources.map((ref:string)=>need(h.messageBack,ref,'UNKNOWN_MEMORY_SOURCE_HANDLE')),
      meaning:{subjectId:c.meaning.subject==='human'?null:c.meaning.subject==='self'?need(h.participantBack,'self','UNKNOWN_SELF'):need(h.participantBack,c.meaning.subject,'UNKNOWN_MEMORY_SUBJECT'),topic:c.meaning.topic,key:c.meaning.key,value:c.meaning.value,epistemic:c.meaning.epistemic,validFrom:c.meaning.validFrom,validTo:c.meaning.validTo,aliases:c.meaning.aliases},
      targets:c.targets.map((ref:string)=>need(h.memoryBack,ref,'UNKNOWN_MEMORY_TARGET')),parents:c.parents.map((ref:string)=>need(h.memoryBack,ref,'UNKNOWN_MEMORY_PARENT'))}))}:{}),};
}
function deliveryBoundary(context:Context):number {
  if(!context.delivery)throw new Error('PARTICIPATION_WITHOUT_DELIVERY');
  return context.delivery.throughInput;
}
function statePatch(value:any,context:Context,h:ReturnType<typeof handlesFor>):StatePatch|null{
  if(value===null)return null;const state=context.self.privateState,observation=context.observation;if(!state||!observation)throw new Error('UNBOUND_STATE_CONTEXT');
  const observed=new Map<string,any>();for(const ref of [...observation.messages,...observation.sources]){
    const handle=ref.kind==='message'?h.message.get(ref.id):h.source.get(ref.id);if(handle)observed.set(handle,ref);
  }
  const upsert=value.upsert.map((entry:any)=>({id:entry.id,kind:entry.kind,text:entry.text,
    evidence:entry.evidence.map((ref:string)=>{const exact=observed.get(ref);if(!exact)throw new Error('UNOBSERVED_EVIDENCE_HANDLE');return exact;}),
    ...(entry.derivedFrom?{derivedFrom:entry.derivedFrom.map((ref:string)=>need(h.memoryBack,ref,'UNKNOWN_MEMORY_HANDLE'))}:{}),
    ...(entry.question?{question:{messageId:need(h.messageBack,entry.question.message,'UNKNOWN_QUESTION_HANDLE'),status:entry.question.status,addressing:entry.question.addressing,
      addressedTo:entry.question.addressedTo.map((ref:string)=>need(h.participantBack,ref,'UNKNOWN_QUESTION_PARTICIPANT')),replyIds:entry.question.replies.map((ref:string)=>need(h.messageBack,ref,'UNKNOWN_QUESTION_REPLY')),topics:entry.question.topics}}:{}),
    ...(entry.participation?{participation:{code:entry.participation.code,throughInput:deliveryBoundary(context)}}:{}),
    resume:internalResume(entry.resume,h)}));
  return {agentId:state.agentId,sessionId:state.sessionId,expectedVersion:state.version,observationId:observation.id,upsert,remove:value.remove};
}

export function translateModelOutput(kind:RunKind,value:unknown,context:Context):unknown{
  const parsed=ModelWireOutputSchemas[kind].parse(value),h=handlesFor(context);
  if('type' in parsed&&parsed.type==='lookup')return {decision:'LOOKUP',requests:parsed.requests.map((r:any)=>{
    if(r.kind==='message')return {kind:'message',query:need(h.messageBack,r.ref,'UNKNOWN_LOOKUP_MESSAGE'),cursor:null};
    if(r.kind==='source')return {kind:'source',query:need(h.sourceBack,r.ref,'UNKNOWN_LOOKUP_SOURCE'),cursor:r.cursor};
    return r;
  })};
  const result=parsed as any,internal={action:internalAction(kind,result.action,h),statePatch:statePatch(result.state,context,h)};
  return WireOutputSchemas[kind].parse(internal);
}
