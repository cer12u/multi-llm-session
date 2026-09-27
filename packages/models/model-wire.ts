import { z } from 'zod';
import {
  ActSchema, Text, LookupSchema,
  type Context, type Intent, type RunKind, type StatePatch,
} from '../contracts/index.js';

const MessageRef=z.string().regex(/^m\d+$/), SourceRef=z.string().regex(/^s\d+$/), ParticipantRef=z.string().regex(/^p\d+$/), MemoryRef=z.string().regex(/^mem\d+$/);
const EntryId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const refOrNull=<T extends z.ZodTypeAny>(schema:T)=>schema.nullable();

const ModelIntentSchema=z.object({
  act:ActSchema,intent:z.string().trim().min(1).max(500),replyTo:refOrNull(MessageRef),addressedTo:z.array(ParticipantRef).max(16),
}).strict();
const ModelDeferSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('time'),afterMs:z.number().int().min(100).max(300000)}).strict(),
  z.object({kind:z.literal('new_message')}).strict(),
  z.object({kind:z.literal('answer_from'),participant:ParticipantRef}).strict(),
]);
const ModelDecisionSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('SPEAK'),intent:ModelIntentSchema}).strict(),
  z.object({decision:z.literal('DEFER'),reason:z.string().max(160),defer:ModelDeferSchema}).strict(),
  z.object({decision:z.literal('ABSTAIN'),reason:z.string().max(160)}).strict(),
]);
const ModelDraftSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('DRAFT'),text:Text}).strict(),
  z.object({decision:z.literal('DROP'),reason:z.string().max(160)}).strict(),
]);
const ModelReviewSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('KEEP')}).strict(),
  z.object({decision:z.literal('REWRITE'),text:Text,intent:ModelIntentSchema.optional()}).strict(),
  z.object({decision:z.literal('DEFER'),reason:z.string().max(160),defer:ModelDeferSchema}).strict(),
  z.object({decision:z.literal('DROP'),reason:z.string().max(160)}).strict(),
]);
const ModelObserveSchema=z.object({decision:z.literal('ABSTAIN'),reason:z.string().max(160)}).strict();
const ModelQuestionSchema=z.object({
  message:MessageRef,status:z.enum(['open','partial','awaiting_confirmation','resolved','deferred']),
  addressing:z.enum(['explicit','inferred','unknown']),addressedTo:z.array(ParticipantRef).max(16),replyTo:z.array(MessageRef).max(7),
  topics:z.array(z.string().trim().min(1).max(80)).min(1).max(4),
}).strict();
const ModelResumeSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('new_message')}).strict(),
  z.object({kind:z.literal('answer_from'),participant:ParticipantRef}).strict(),
  z.object({kind:z.literal('time'),afterMs:z.number().int().min(100).max(86400000)}).strict(),
  z.object({kind:z.literal('related_topic'),topic:z.string().trim().min(1).max(120)}).strict(),
]);
const ModelStateEntrySchema=z.object({
  id:EntryId,kind:z.enum(['understanding','interest','question','intention']),text:z.string().trim().min(1).max(500),
  evidence:z.array(z.union([MessageRef,SourceRef])).max(8),derivedFrom:z.array(MemoryRef).max(8).optional(),
  question:ModelQuestionSchema.optional(),participation:z.object({code:z.enum(['SATISFIED','CONTENT_LOOP'])}).strict().optional(),
  resume:ModelResumeSchema.nullable(),
}).strict();
const ModelStateDeltaSchema=z.object({upsert:z.array(ModelStateEntrySchema).max(8),remove:z.array(EntryId).max(16)}).strict();
const SearchQuery=z.string().trim().min(1).max(200), Cursor=z.string().max(2048).nullable().default(null);
const ModelLookupRequestSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('messages'),query:SearchQuery,cursor:Cursor}).strict(),
  z.object({kind:z.literal('memories'),query:SearchQuery,cursor:Cursor}).strict(),
  z.object({kind:z.literal('message'),query:MessageRef,cursor:Cursor}).strict(),
  z.object({kind:z.literal('source'),query:SourceRef,cursor:Cursor}).strict(),
]);
const ModelLookupSchema=z.object({decision:z.literal('LOOKUP'),requests:z.array(ModelLookupRequestSchema).min(1).max(3)}).strict();
const Stateful=<T extends z.ZodTypeAny>(action:T)=>z.object({action,stateDelta:ModelStateDeltaSchema.nullable()}).strict();
const ModelMemoryMeaningSchema=z.object({
  subject:ParticipantRef.nullable(),topic:z.string().trim().min(1).max(120),key:z.string().trim().min(1).max(160),value:z.string().trim().min(1).max(240),
  epistemic:z.enum(['self_report','hearsay','inference','uncertain']),validFrom:z.number().int().nonnegative().nullable(),validTo:z.number().int().nonnegative().nullable(),aliases:z.array(z.string().trim().min(1).max(80)).max(8),
}).strict();
const ModelMemoryChangeSchema=z.object({
  operation:z.enum(['add','merge','correct','conflict']),text:z.string().trim().min(1).max(1000),sources:z.array(MessageRef).min(1).max(8),
  meaning:ModelMemoryMeaningSchema,targets:z.array(MemoryRef).max(8),parents:z.array(MemoryRef).max(8),
}).strict().refine(x=>x.operation==='add'||x.targets.length>0,'This operation needs an observed target');
const ModelMemorySchema=z.object({
  notes:z.array(z.object({text:z.string().trim().min(1).max(1000),sources:z.array(MessageRef).min(1).max(8)}).strict()).max(4),
  changes:z.array(ModelMemoryChangeSchema).max(4).optional(),
}).strict().refine(x=>x.notes.length+(x.changes?.length??0)<=4,'At most four memory changes per result');

export const ModelWireOutputSchemas={
  observe:z.union([Stateful(ModelObserveSchema),ModelLookupSchema]),
  decide:z.union([Stateful(ModelDecisionSchema),ModelLookupSchema]),
  draft:z.union([Stateful(ModelDraftSchema),ModelLookupSchema]),
  review:z.union([Stateful(ModelReviewSchema),ModelLookupSchema]),
  memory:Stateful(ModelMemorySchema),
};

export type ModelRefMap={
  participantByRef:Map<string,string>;participantById:Map<string,string>;
  messageByRef:Map<string,{id:string;version:number}>;messageById:Map<string,string>;
  sourceByRef:Map<string,{id:string;version:number}>;sourceById:Map<string,string>;
  memoryByRef:Map<string,string>;memoryById:Map<string,string>;
};
const allMessages=(c:Context)=>[...c.messages,...c.delta,...(c.retrieved??[]).flatMap(r=>r.messages)];
const uniqueBy=<T>(values:T[],key:(v:T)=>string)=>[...new Map(values.map(v=>[key(v),v])).values()];
function refs(c:Context):ModelRefMap{
  const participants=uniqueBy(c.participants,x=>x.id),messages=uniqueBy(allMessages(c),x=>x.id),sources=uniqueBy([...c.sources,...(c.retrieved??[]).flatMap(r=>r.sources??[])],x=>x.id),memories=uniqueBy([...c.memories,...(c.retrieved??[]).flatMap(r=>r.memories)],x=>x.id);
  const participantByRef=new Map<string,string>(),participantById=new Map<string,string>();participants.forEach((x,i)=>{participantByRef.set('p'+i,x.id);participantById.set(x.id,'p'+i);});
  const messageByRef=new Map<string,{id:string;version:number}>(),messageById=new Map<string,string>();messages.forEach((x,i)=>{messageByRef.set('m'+i,{id:x.id,version:x.revision});messageById.set(x.id,'m'+i);});
  const sourceByRef=new Map<string,{id:string;version:number}>(),sourceById=new Map<string,string>();sources.forEach((x,i)=>{sourceByRef.set('s'+i,{id:x.id,version:x.version??x.fetchedAt});sourceById.set(x.id,'s'+i);});
  const memoryByRef=new Map<string,string>(),memoryById=new Map<string,string>();memories.forEach((x,i)=>{memoryByRef.set('mem'+i,x.id);memoryById.set(x.id,'mem'+i);});
  return {participantByRef,participantById,messageByRef,messageById,sourceByRef,sourceById,memoryByRef,memoryById};
}
function need<T>(value:T|undefined):T{if(value===undefined)throw new Error('UNKNOWN_MODEL_REF');return value;}
function modelIntent(value:Intent,map:ModelRefMap){return {act:value.act,intent:value.intent,replyTo:value.replyTo?map.messageById.get(value.replyTo)??null:null,addressedTo:value.addressedTo.map(id=>need(map.participantById.get(id)))};}
function modelEntry(entry:any,map:ModelRefMap,now:number){
  const evidence=entry.evidence.map((r:any)=>r.kind==='message'?map.messageById.get(r.id):map.sourceById.get(r.id)).filter((x:any):x is string=>typeof x==='string');
  const target=entry.resume?.agentId?map.participantById.get(entry.resume.agentId):undefined;
  const resume=entry.resume===null?null:entry.resume?.kind==='answer_from'&&target?{kind:'answer_from',participant:target}:entry.resume?.kind==='time'?{kind:'time',afterMs:Math.max(100,entry.resume.notBefore-now)}:entry.resume?.kind==='related_topic'?{kind:'related_topic',topic:entry.resume.topic}:{kind:'new_message'};
  const qMessage=entry.question?map.messageById.get(entry.question.messageId):undefined;
  const question=entry.question&&qMessage?{message:qMessage,status:entry.question.status,addressing:entry.question.addressing,addressedTo:entry.question.addressedTo.map((id:string)=>map.participantById.get(id)).filter((x:any):x is string=>typeof x==='string'),replyTo:entry.question.replyIds.map((id:string)=>map.messageById.get(id)).filter((x:any):x is string=>typeof x==='string'),topics:entry.question.topics}:undefined;
  const derivedFrom=(entry.derivedFrom??[]).map((id:string)=>map.memoryById.get(id)).filter((x:any):x is string=>typeof x==='string');
  return {id:entry.id,kind:entry.kind,text:entry.text,evidence,...derivedFrom.length?{derivedFrom}:{},...question?{question}:{},...entry.participation?{participation:{code:entry.participation.code}}:{},resume};
}
export function modelContext(c:Context):Record<string,unknown>{
  const map=refs(c),p=(id:string|null)=>id?map.participantById.get(id)??null:null,m=(id:string|null)=>id?map.messageById.get(id)??null:null;
  const message=(x:any)=>({ref:need(map.messageById.get(x.id)),author:p(x.authorId),authorName:x.authorName,text:x.text,act:x.act,replyTo:m(x.replyTo),addressedTo:x.addressedTo.map((id:string)=>need(map.participantById.get(id))),deleted:x.deleted});
  const source=(x:any)=>({ref:need(map.sourceById.get(x.id)),title:x.title,text:x.text,url:x.url,publishedAt:x.publishedAt,excerpt:x.nextCursor!==null,nextCursor:x.nextCursor??null});
  const memory=(x:any)=>({ref:need(map.memoryById.get(x.id)),text:x.text,sources:x.sourceMessageIds.map((id:string)=>map.messageById.get(id)).filter(Boolean),provenance:x.provenance?{status:x.provenance.status,verified:false}:undefined});
  const now=c.agenda?.now??Date.now();
  return {
    self:{ref:map.participantById.get(c.self.id)??null,name:c.self.character.name,persona:c.self.character.persona,state:(c.self.privateState?.entries??[]).map(e=>modelEntry(e,map,now))},
    participants:c.participants.map(x=>({ref:need(map.participantById.get(x.id)),name:x.name,enabled:x.enabled,status:x.status})),
    trigger:c.trigger,historyTruncated:c.historyTruncated,messages:c.messages.map(message),delta:c.delta.map(message),sources:c.sources.map(source),memories:c.memories.map(memory),
    candidate:c.candidate?{text:c.candidate.text,intent:modelIntent(c.candidate.intent,map)}:null,
    questions:c.questions.map(q=>({message:map.messageById.get(q.messageId)??null,text:q.text,from:p(q.from),addressedTo:(q.addressedTo??[]).map(id=>map.participantById.get(id)).filter(Boolean),status:q.status??'unassessed',topics:q.topics??[],excerpt:q.excerpt??false})),
    delivery:c.delivery?{purpose:c.delivery.purpose,complete:c.delivery.complete,entries:c.delivery.entries.map(e=>({ref:e.kind==='message'?map.messageById.get(e.id):map.sourceById.get(e.id),kind:e.kind,superseded:e.superseded,excerpt:e.excerpt}))}:undefined,
    progress:c.progress?{observationPending:c.progress.observationPending,memoryPending:c.progress.memoryPending}:undefined,
    coverage:c.coverage?{complete:c.coverage.complete}:undefined,
    conversation:c.conversation?{signals:c.conversation.signals.map(s=>({kind:s.kind,evidence:s.evidence.map(e=>map.messageById.get(e.id)).filter(Boolean)})),recentPurposes:c.conversation.recentPurposes.map(x=>({message:map.messageById.get(x.messageId),act:x.act,purpose:x.purpose,excerpt:x.excerpt})),previousAssessment:c.conversation.previousAssessment}:undefined,
    agenda:c.agenda?{now:c.agenda.now,timeWakeEnabled:c.agenda.timeWakeEnabled,pending:c.agenda.pending.map(x=>({entryId:x.entryId,kind:x.kind,status:x.status,effectiveAt:x.effectiveAt,reason:x.reason})),triggered:c.agenda.triggered.map(x=>({entryId:x.entryId,kind:x.kind,status:x.status,effectiveAt:x.effectiveAt,reason:x.reason}))}:undefined,
    retrieved:(c.retrieved??[]).map(r=>({request:{kind:r.request.kind,query:r.request.kind==='source'?map.sourceById.get(r.request.query)??null:r.request.kind==='message'?map.messageById.get(r.request.query)??null:r.request.query,cursor:r.request.cursor},messages:r.messages.map(message),memories:r.memories.map(memory),sources:(r.sources??[]).map(source),nextCursor:r.nextCursor})),
    recall:c.recall?{selected:c.recall.selected.map(x=>({ref:map.memoryById.get(x.id),score:x.score,provenance:x.provenance})).filter(x=>x.ref),omitted:c.recall.omittedForBudget.length}:undefined,
  };
}

function bindIntent(v:z.infer<typeof ModelIntentSchema>,map:ModelRefMap):Intent{return {act:v.act,intent:v.intent,replyTo:v.replyTo?need(map.messageByRef.get(v.replyTo)).id:null,addressedTo:v.addressedTo.map(r=>need(map.participantByRef.get(r)))};}
function bindDefer(v:z.infer<typeof ModelDeferSchema>,map:ModelRefMap){return v.kind==='time'?{kind:'time' as const,afterMs:v.afterMs,agentId:null}:v.kind==='answer_from'?{kind:'answer_from' as const,afterMs:100,agentId:need(map.participantByRef.get(v.participant))}:{kind:'new_message' as const,afterMs:100,agentId:null};}
function bindResume(v:z.infer<typeof ModelResumeSchema>,map:ModelRefMap,now:number){return v.kind==='time'?{kind:'time' as const,agentId:null,notBefore:now+v.afterMs,topic:null}:v.kind==='answer_from'?{kind:'answer_from' as const,agentId:need(map.participantByRef.get(v.participant)),notBefore:null,topic:null}:v.kind==='related_topic'?{kind:'related_topic' as const,agentId:null,notBefore:null,topic:v.topic}:{kind:'new_message' as const,agentId:null,notBefore:null,topic:null};}
function bindDelta(delta:z.infer<typeof ModelStateDeltaSchema>|null,c:Context,map:ModelRefMap):StatePatch|null{
  if(delta===null)return null;const state=c.self.privateState,observed=c.observation;if(!state||!observed)throw new Error('STATE_BINDING_MISSING');const now=c.agenda?.now??Date.now();
  return {agentId:c.self.id,sessionId:state.sessionId,expectedVersion:state.version,observationId:observed.id,remove:delta.remove,upsert:delta.upsert.map(e=>({
    id:e.id,kind:e.kind,text:e.text,evidence:e.evidence.map(ref=>ref.startsWith('m')?{kind:'message' as const,...need(map.messageByRef.get(ref))}:{kind:'source' as const,...need(map.sourceByRef.get(ref))}),
    ...e.derivedFrom?{derivedFrom:e.derivedFrom.map(ref=>need(map.memoryByRef.get(ref)))}:{},
    ...e.question?{question:{messageId:need(map.messageByRef.get(e.question.message)).id,status:e.question.status,addressing:e.question.addressing,addressedTo:e.question.addressedTo.map(ref=>need(map.participantByRef.get(ref))),replyIds:e.question.replyTo.map(ref=>need(map.messageByRef.get(ref)).id),topics:e.question.topics}}:{},
    ...e.participation?{participation:{code:e.participation.code,throughInput:c.delivery?.throughInput??0}}:{},resume:e.resume?bindResume(e.resume,map,now):null,
  }))};
}
function bindAction(kind:RunKind,action:any,c:Context,map:ModelRefMap):unknown{
  if(kind==='observe')return action;
  if(kind==='decide')return action.decision==='SPEAK'?{decision:'SPEAK',intent:bindIntent(action.intent,map)}:action.decision==='DEFER'?{decision:'DEFER',reason:action.reason,defer:bindDefer(action.defer,map)}:action;
  if(kind==='draft')return action;
  if(kind==='review')return action.decision==='REWRITE'?{decision:'REWRITE',text:action.text,intent:action.intent?bindIntent(action.intent,map):c.candidate?.intent}:action.decision==='DEFER'?{decision:'DEFER',reason:action.reason,defer:bindDefer(action.defer,map)}:action;
  return {notes:action.notes.map((n:any)=>({text:n.text,sourceMessageIds:n.sources.map((r:string)=>need(map.messageByRef.get(r)).id)})),...action.changes?{changes:action.changes.map((x:any)=>({operation:x.operation,text:x.text,sourceMessageIds:x.sources.map((r:string)=>need(map.messageByRef.get(r)).id),meaning:{subjectId:x.meaning.subject?need(map.participantByRef.get(x.meaning.subject)):null,topic:x.meaning.topic,key:x.meaning.key,value:x.meaning.value,epistemic:x.meaning.epistemic,validFrom:x.meaning.validFrom,validTo:x.meaning.validTo,aliases:x.meaning.aliases},targets:x.targets.map((r:string)=>need(map.memoryByRef.get(r))),parents:x.parents.map((r:string)=>need(map.memoryByRef.get(r)))}))}:{}};
}
export function bindModelOutput(kind:RunKind,value:unknown,c:Context):unknown{
  const parsed=ModelWireOutputSchemas[kind].parse(value),map=refs(c),lookup=ModelLookupSchema.safeParse(parsed);
  if(lookup.success)return LookupSchema.parse({decision:'LOOKUP',requests:lookup.data.requests.map(r=>({kind:r.kind,query:r.kind==='source'?need(map.sourceByRef.get(r.query)).id:r.kind==='message'?need(map.messageByRef.get(r.query)).id:r.query,cursor:r.cursor}))});
  const stateful=parsed as {action:unknown;stateDelta:z.infer<typeof ModelStateDeltaSchema>|null};
  return {action:bindAction(kind,stateful.action,c,map),statePatch:bindDelta(stateful.stateDelta,c,map)};
}
