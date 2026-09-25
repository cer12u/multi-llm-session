import {z} from 'zod';
import {CharacterSchema,ModelProfileSchema,SettingsSchema,SessionCreateSchema,MessageInputSchema,SourceSchema,WireOutputSchemas,Id,Slug,type PublicMessage,type PublicAgent,type PublicSession,type Snapshot} from './index.js';
import {SourceUpdateSchema,FeedSubscriptionSchema} from './source.js';
import {MembershipUpdateSchema,SessionCloneSchema} from './session-membership.js';
import {BudgetPolicyUpdateSchema} from './budget.js';
import {HttpBody,HttpQuery,ReceiptParams} from './http.js';

export type RegisteredRoute={method:string;url:string};
type Json=Record<string,any>;
type Access='anonymous'|'reader'|'operator'|'worker'|'logout';
type Route={method:'GET'|'POST';url:string;summary:string;access:Access;body?:string;query?:keyof typeof HttpQuery;response:string;idem?:boolean;optionalBody?:boolean;note?:string;media?:string};
const requests:Record<string,z.ZodType>={
  ...HttpBody,sessionCreate:SessionCreateSchema,message:MessageInputSchema,settings:SettingsSchema,
  character:CharacterSchema,profile:ModelProfileSchema,source:SourceSchema,sourceUpdate:SourceUpdateSchema,
  feed:FeedSubscriptionSchema,membership:MembershipUpdateSchema,clone:SessionCloneSchema,budgetPolicy:BudgetPolicyUpdateSchema,
};
const string=z.string(),count=z.number().int().nonnegative(),nullableNumber=count.nullable();
// These exported response descriptions are type-checked against the public DTOs.
// They are NOT installed as Fastify serializers and cannot strip/reshape actual replies.
const message:z.ZodType<PublicMessage>=z.object({id:Id,sessionId:Id,sequence:count,threadRootId:Id,revision:count,
  authorId:Id.nullable(),authorName:string,characterId:string.nullable(),characterVersion:nullableNumber,text:string,act:string,
  replyTo:Id.nullable(),addressedTo:z.array(Id),deleted:z.boolean(),episode:count,createdAt:count}).passthrough();
const agent:z.ZodType<PublicAgent>=z.object({id:Id,slot:Slug,characterId:Slug,characterVersion:count,name:string,
  presentationRef:string.nullable(),profileId:Slug,enabled:z.boolean(),status:string,workerOnline:z.boolean(),lastSeenAt:nullableNumber,nextRetryAt:nullableNumber}).passthrough();
const session:z.ZodType<PublicSession>=z.object({id:Id,title:string,lifecycle:z.enum(['DRAFT','RUNNING','PAUSED','ENDED']),activity:z.enum(['ACTIVE','QUIET','DEGRADED','BUDGET_PAUSED']),revision:count,
  epoch:count,createdAt:count,startedAt:nullableNumber,stopReason:string.nullable(),calls:count,botMessages:count,
  budget:z.object({callsUsed:count,messagesUsed:count,activeMs:count}),settings:SettingsSchema,mode:z.enum(['mock','live'])}).passthrough();
const snapshot:z.ZodType<Snapshot>=z.object({session,agents:z.array(agent),messages:z.array(message),cursor:string,historyCursor:string.nullable()}).passthrough();
const page=z.object({items:z.array(message),highWater:count,nextCursor:string.nullable()}).passthrough();
const record=z.object({}).passthrough();
const memory=z.object({id:Id,text:string,sourceMessageIds:z.array(Id),provenance:record.optional()}).passthrough();
const responses:Record<string,z.ZodType>={
  ok:z.object({ok:z.literal(true)}),health:z.object({ok:z.literal(true),sqlite:string}),
  login:z.object({role:z.enum(['operator','viewer']),csrf:string}),created:z.object({id:Id}).passthrough(),versioned:z.object({id:Id,version:count}),
  session,sessions:z.array(session),message,messages:z.array(message),snapshot,page,thread:page.extend({rootId:Id}),
  character:CharacterSchema,characterRecord:z.object({character:CharacterSchema,hash:string}),
  characters:z.array(z.union([CharacterSchema,CharacterSchema.omit({persona:true})])),
  characterVersions:z.array(z.object({id:Slug,version:count,name:string,hash:string})),profile:ModelProfileSchema,
  capabilities:z.object({profiles:z.array(z.object({id:Slug,provider:string,model:string})),slots:z.array(string),defaults:SettingsSchema,liveEnabled:z.boolean()}),
  epoch:z.object({epoch:z.number().int().positive()}),claim:record.nullable(),context:record,
  memories:z.array(memory),memoryPage:z.object({items:z.array(memory),highWater:count,nextCursor:string.nullable()}),
  record,records:z.array(record),receipt:z.unknown(),document:record,
  // Variable diagnostics are extensible, not a made-up complete schema of every private table.
  transcript:record,diagnostic:record,usage:record,membership:record,feed:record,source:record,
  continuity:z.object({kind:z.literal('private-continuity-fingerprint'),formatVersion:z.literal(1),sessionId:Id,databaseSchema:count,capturedAt:count,
    method:z.literal('sha256-canonical-table-rows'),tables:z.array(z.object({table:string,rows:count,sha256:z.string().regex(/^[a-f0-9]{64}$/)})),scope:string}),
};
const routes:Route[]=[];
function add(method:Route['method'],url:string,summary:string,access:Access,response:string,extra:Partial<Route>={}){routes.push({method,url,summary,access,response,...extra});}
const s='/v1/sessions/:id',w='/v1/worker';
add('GET','/healthz','Process health and SQLite version','anonymous','health');
add('GET','/v1/openapi.json','Application route and shared-schema contract','operator','document');
add('POST','/v1/auth/login','Create an eight-hour operator or viewer cookie','anonymous','login',{body:'login',note:'Origin is required. Rate limited to 10 attempts per IP per 60 seconds; 100 concurrent logins. Sets mls_session HttpOnly/SameSite=Strict cookie; Secure on HTTPS.'});
add('GET','/v1/auth/me','Read the current role and CSRF token','reader','login');
add('POST','/v1/auth/logout','Revoke the current cookie and close its streams','logout','ok',{note:'Origin is required for all authentication forms. Viewer logout is allowed. No CSRF token is required by this endpoint. Already downloaded files are not erased.'});
add('GET','/v1/capabilities','Read public configuration capabilities','reader','capabilities');
add('GET','/v1/model-profiles','Read fixed provider status and credential-presence flags','operator','records');
add('POST','/v1/model-profiles','Save an immutable model profile version','operator','profile',{body:'profile',note:'URLs and credential binding names have additional runtime validation. No inference is started by saving a profile.'});
add('POST','/v1/model-profiles/:profile/retry','Permit one probe of the latest profile version','operator','record',{idem:true,note:'Legacy latest-version operation; the body is ignored. Prefer the explicit version route.'});
add('GET','/v1/provider-catalog','Read provider/profile capabilities and fixed versions','operator','records');
add('GET','/v1/model-profiles/:profile/versions','List immutable profile versions','operator','records');
add('POST','/v1/model-profiles/:profile/versions/:version/retry','Permit one probe of the specified profile version','operator','record',{body:'empty',idem:true});
add('GET','/v1/characters','Read latest characters, without persona for viewers','reader','characters');
add('POST','/v1/characters','Save an immutable character version','operator','character',{body:'character'});
add('GET','/v1/characters/:characterId/versions','List character version metadata','operator','characterVersions');
add('GET','/v1/characters/:characterId/versions/:version','Read a full character version and hash','operator','characterRecord');
add('GET','/v1/characters/:characterId/versions/:version/export','Export a full character definition','operator','character');
for(const action of ['validate','import'])add('POST','/v1/characters/'+action,action==='validate'?'Validate a character without saving':'Import an immutable character version','operator','characterRecord',{body:'character'});
add('GET','/v1/sessions','List public sessions','reader','sessions');
add('POST','/v1/sessions','Create a DRAFT without starting inference','operator','created',{body:'sessionCreate',idem:true});
for(const action of ['start','pause','resume','end'])add('POST',s+'/'+action,action+' the session','operator','session',{body:'empty',idem:true,optionalBody:true});
add('POST',s+'/settings','Replace settings while DRAFT or PAUSED','operator','session',{body:'settings',idem:true});
add('POST',s+'/members','Enable or disable an existing participant','operator','ok',{body:'memberEnabled',idem:true});
add('GET',s+'/membership','Read participant identities and pinned versions','operator','membership');
add('POST',s+'/membership','Apply participant changes with expected epoch','operator','membership',{body:'membership',idem:true});
add('GET',s+'/episodes','Read public episode boundaries','reader','records');
add('POST',s+'/clone','Clone definitions into a new session without private experience','operator','created',{body:'clone',idem:true});
add('POST',s+'/budget','Renew budget without erasing memory or resuming a human pause','operator','session',{body:'empty',idem:true});
add('GET',s+'/usage','Read purpose/phase/owner usage, unknown values and budget windows','operator','usage');
add('POST',s+'/budget-policy','Set explicit operational budget policy','operator','usage',{body:'budgetPolicy',idem:true});
add('POST',s+'/agents/:agentId/retry','Retry one current participant with generation fencing','operator','ok',{idem:true,note:'The request body is ignored. This does not replace persona/model versions.'});
add('GET',s+'/operations','Read non-response reasons and available recovery operations','operator','record');
add('GET',s+'/history','Page all retained original messages','reader','page',{query:'page'});
add('GET',s+'/threads/:messageId','Page an old reply tree including tombstones','reader','thread',{query:'page'});
add('GET',s+'/search-page','Search originals with edit-generation fenced pagination','reader','page',{query:'searchPage'});
add('GET',s+'/search','Legacy first-page original search','reader','messages',{query:'search',note:'At most 50 records; use search-page for continuation.'});
add('POST',s+'/messages/lookup','Read up to 200 public originals by ID without a mutation','reader','messages',{body:'messageLookup',note:'Read-only POST: viewer credentials are allowed; no CSRF or idempotency key is required.'});
add('GET',s+'/snapshot','Read public session state, participants and initial history page','reader','snapshot');
add('POST',s+'/messages','Publish one human message exactly once','operator','message',{body:'message',idem:true});
add('POST',s+'/messages/:messageId','Edit human text or tombstone a message','operator','message',{body:'messageEdit',idem:true,note:'Non-null text is also validated with MessageInputSchema, including trim and Unicode limits. Bot text cannot be rewritten; deletion remains possible.'});
add('GET',s+'/archive/:messageId','Read an original; deleted originals return 410','reader','message');
add('GET',s+'/commands/:operation/:key','Resolve an unknown command outcome by its receipt','operator','receipt',{note:'Returns the original command result shape. Missing receipts are 404, not proof that a lost network request cannot still commit.'});
add('GET',s+'/transcript','Export the allowlisted public transcript','reader','transcript');
add('GET',s+'/export','Operator-only legacy public transcript export','operator','transcript');
add('GET',s+'/diagnostics','Read private runtime diagnostics','operator','diagnostic');
add('GET',s+'/continuity-fingerprint','Hash current private durable experience without exporting old run contexts','operator','continuity');
add('GET',s+'/diagnostic-runs','Page private execution evidence','operator','record',{query:'diagnosticRuns'});
add('GET',s+'/diagnostic-runs/:run','Read one private run and its causal evidence','operator','diagnostic');
add('GET',s+'/diagnostic-export','Stream private recorded-state replay data','operator','record',{media:'application/x-ndjson',note:'Bounded, operator-only NDJSON with authorization rechecked while streaming. HTTP 413 DIAGNOSTIC_SIZE_LIMIT is possible. This is not an unlimited historical export.'});
add('GET',s+'/events','Stream public events with resumable session-bound cursor','reader','record',{query:'events',media:'text/event-stream',note:'Last-Event-ID overrides query cursor. Invalid, future or foreign-session cursors return 409. Cookie logout/expiry closes the stream. Viewing never starts inference.'});
add('GET','/v1/source-configurations','Read operator-configured feed origins','operator','records');
add('POST',s+'/sources','Inject a versioned source for selected owners','operator','versioned',{body:'source',idem:true});
add('GET',s+'/sources','List sources including private audiences','operator','records');
add('GET',s+'/sources/:source','Read the current full source','operator','source');
add('GET',s+'/sources/:source/versions','List retained source versions','operator','records');
add('GET',s+'/sources/:source/versions/:version','Read one retained source version','operator','source');
add('POST',s+'/sources/:source','Update source content and audience with expectedVersion','operator','versioned',{body:'sourceUpdate',idem:true});
add('GET',s+'/feeds','Read session feed subscriptions','operator','records');
add('POST',s+'/feeds','Save a versioned feed subscription','operator','versioned',{body:'feed',idem:true});
add('POST',s+'/feeds/:source/retry','Retry one registered feed fetch','operator','ok',{body:'empty',idem:true});
add('POST',w+'/register','Register one Worker slot and advance its epoch','worker','epoch',{body:'empty'});
add('POST',w+'/claim','Claim a run for the authenticated current Worker epoch','worker','claim',{body:'workerClaim',note:'Null means no eligible work. A non-null object is ClaimedRun and contains a private Context, lease and immutable profile; never expose it to peers/viewers.'});
add('POST',w+'/runs/:id/heartbeat','Extend an owned, current run lease','worker','ok',{body:'runAuth'});
add('POST',w+'/runs/:id/calls','Reserve before dispatching a model call','worker','created',{body:'callReserve'});
add('POST',w+'/runs/:id/calls/:callId','Settle a call with measured or unknown usage','worker','ok',{body:'callFinish'});
add('POST',w+'/runs/:id/lookup','Retrieve owner-scoped evidence without losing observation binding','worker','context',{body:'runLookup'});
add('POST',w+'/runs/:id/result','Atomically commit an owned run result and private state patch','worker','ok',{body:'runResult',note:'output must match the bound run kind (see x-run-output-schemas); schema-valid foreign owner/evidence/version data is still rejected atomically.'});
add('POST',w+'/runs/:id/failure','Report an owned run failure separately from voluntary silence','worker','ok',{body:'runFailure'});
for(const [suffix,response,query] of [['memory','memories',undefined],['memory-page','memoryPage','memoryPage'],['archive','messages','search'],['archive/:messageId','message',undefined]] as const)
  add('GET',w+'/agents/:id/'+suffix,'Read only the active run owner\'s '+suffix,'worker',response,{query,note:'Requires RUNNING, enabled non-retired owner, an ACTIVE unexpired run and matching Worker/session generations. A reusable Worker slot alone grants no access to prior owners.'});

const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const jsonSchema=(schema:z.ZodType,io:'input'|'output'='input')=>z.toJSONSchema(schema,{io}) as Json;
const scoped=(access:Access,write:boolean):Json[]=>{
  if(access==='anonymous')return [];
  if(access==='worker')return [{workerToken:[]}];
  if(access==='logout')return [{operatorToken:[],sameOrigin:[]},{viewerToken:[],sameOrigin:[]},{sessionCookie:[],sameOrigin:[]}];
  const cookie=write?{sessionCookie:[],csrfToken:[],sameOrigin:[]}:{sessionCookie:[]};
  return access==='operator'?[{operatorToken:[]},cookie]:[{operatorToken:[]},{viewerToken:[]},cookie];
};
/** Registration inventory is captured from Fastify itself, never a regex of source text.
 * Missing metadata or stale/deleted routes fail export rather than silently omit an API. */
export function buildOpenApi(registered:RegisteredRoute[]){
  const actual=new Set(registered.filter(r=>r.method!=='HEAD'&&r.url!=='/'&&r.url!=='/assets/*').map(r=>r.method+' '+r.url));
  const documented=new Set(routes.map(r=>r.method+' '+r.url));
  const missing=[...actual].filter(k=>!documented.has(k)),stale=[...documented].filter(k=>!actual.has(k));
  if(missing.length||stale.length||documented.size!==routes.length)throw new Error('OPENAPI_ROUTE_DRIFT: '+JSON.stringify({missing,stale}));
  const schemas:Record<string,Json>={};
  for(const [name,schema] of Object.entries(requests))schemas[name+'Request']=jsonSchema(schema);
  for(const [name,schema] of Object.entries(responses))schemas[name+'Response']=jsonSchema(schema,'output');
  for(const [kind,schema] of Object.entries(WireOutputSchemas))schemas[kind+'Output']=jsonSchema(schema);
  schemas.Error={type:'object',required:['code'],properties:{code:{type:'string'},issues:{type:'array',items:{type:'object',additionalProperties:true}}},additionalProperties:true};
  const paths:Record<string,Json>={};
  for(const r of routes.slice().sort((a,b)=>(a.url+' '+a.method).localeCompare(b.url+' '+b.method))){
    const path=r.url.replace(/:([A-Za-z][A-Za-z0-9]*)/g,'{$1}'),parameters:Json[]=[];
    for(const match of r.url.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)){
      const name=match[1];let schema:Json;
      if(name==='version')schema=jsonSchema(z.number().int().min(r.url.includes('/sources/')?0:1));
      else if(name==='profile'||name==='characterId')schema=jsonSchema(Slug);
      else if(name==='operation'||name==='key')schema=jsonSchema(ReceiptParams.shape[name]);
      else schema=jsonSchema(Id);
      parameters.push({name,in:'path',required:true,schema});
    }
    if(r.query){const schema=jsonSchema(HttpQuery[r.query]);for(const [name,value] of Object.entries(schema.properties??{}))parameters.push({name,in:'query',required:(schema.required??[]).includes(name),schema:value});}
    if(r.idem)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$'},description:'Retry the same operation/payload with the same key. A different payload using the same scoped key returns 409.'});
    if(r.url==='/v1/auth/login')parameters.push({name:'Origin',in:'header',required:true,schema:{type:'string'},description:'Must exactly equal configured PUBLIC_ORIGIN.'});
    if(r.media==='text/event-stream')parameters.push({name:'Last-Event-ID',in:'header',required:false,schema:{type:'string'},description:'Takes precedence over cursor; session-bound event ID.'});
    const write=r.method==='POST'&&r.access==='operator';
    const op:Json={operationId:r.method.toLowerCase()+'_'+r.url.replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_|_$/g,''),summary:r.summary,
      description:r.note??'See API.md for state, ownership and version-dependent rejection rules.',tags:[r.access],
      security:scoped(r.access,write),parameters,
      'x-required-role':r.access,'x-idempotency':r.idem?'scoped-command-receipt':r.access==='worker'?'run/epoch/request-key-specific':'not-a-command-receipt',
      responses:{'200':{description:r.media?'Authorized stream':r.summary,content:{[r.media??'application/json']:{schema:r.media?{type:'string'}:ref(r.response+'Response')}}},default:{$ref:'#/components/responses/ApplicationError'}}};
    if(r.body)op.requestBody={required:!r.optionalBody,content:{'application/json':{schema:ref(r.body+'Request')}}};
    if(['record','records','receipt','document','diagnostic','usage','membership','source','feed','transcript','claim','context'].includes(r.response))op['x-response-shape']='Extensible result; nested diagnostic/metadata fields are not a complete generated DTO.';
    if(r.body==='runResult')op['x-run-output-schemas']=Object.fromEntries(Object.keys(WireOutputSchemas).map(kind=>[kind,ref(kind+'Output')]));
    if(r.url==='/v1/auth/login')op.responses['200'].headers={'Set-Cookie':{description:'mls_session; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; Secure on HTTPS',schema:{type:'string'}}};
    (paths[path]??={})[r.method.toLowerCase()]=op;
  }
  return {openapi:'3.1.1',jsonSchemaDialect:'https://json-schema.org/draft/2020-12/schema',
    info:{title:'Multi LLM Session HTTP API',version:'1',description:'Single-operator private lab. Host and optional Origin checks apply globally. Operator/viewer/Worker tokens are distinct opaque credentials, not JWTs. All private reads remain operator- or active-run-owner-only. Request schemas reuse runtime validators; domain ownership, generation, evidence and lifecycle checks remain authoritative.'},servers:[{url:'/'}],paths,
    components:{schemas,responses:{ApplicationError:{description:'Application rejection: 401 authentication; 403 permission/Host/Origin/CSRF; 404 missing; 409 lifecycle/version/idempotency/cursor conflict; 410 deleted original; 413 capacity; 422 validation; 429 rate/concurrency; 5xx operational failure. Error bodies never intentionally include credentials or raw Provider responses.',content:{'application/json':{schema:ref('Error')}}}},
      securitySchemes:{operatorToken:{type:'http',scheme:'bearer',description:'ADMIN_TOKEN, full operator grant.'},viewerToken:{type:'http',scheme:'bearer',description:'VIEWER_TOKEN, public read-only grant.'},workerToken:{type:'http',scheme:'bearer',description:'Per-slot Worker token; run lease/epoch/owner checks also apply.'},sessionCookie:{type:'apiKey',in:'cookie',name:'mls_session',description:'Cookie role must satisfy x-required-role; possession is not an operator grant.'},csrfToken:{type:'apiKey',in:'header',name:'X-CSRF-Token'},sameOrigin:{type:'apiKey',in:'header',name:'Origin',description:'Exact configured PUBLIC_ORIGIN.'}}},
    'x-coverage':{explicitApiOperations:actual.size,registeredRoutes:registered.filter(r=>r.method!=='HEAD').map(r=>r.method+' '+r.url).sort(),excluded:['GET /','GET /assets/*'],implicitMethods:'Framework-generated HEAD mirrors GET authorization and is omitted from operation counts.'},
    'x-limits':{defaultRequestBodyBytes:65536,privateDiagnosticExportBytes:134217728},
    'x-contract-scope':'Every explicit health/v1 operation, request envelope/shared input schema, path/query/header, authentication alternative and response media type is described. Private extensible diagnostic results are explicitly not fully typed. OpenAPI metadata never changes Fastify validation or serialization.'};
}
