import {registerObservabilityRoutes} from './observability-routes.js';
import {publicTranscript} from '../../packages/observability/index.js';
import { registerSourceRoutes } from './source-routes.js';
import Fastify, { type FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { z, ZodError } from 'zod';
import { AppError, ensure, Id, UsageSchema, ErrorCodeSchema, type ModelErrorCode } from '../../packages/contracts/index.js';
import { LookupRequestSchema, Slug } from '../../packages/contracts/index.js';
import { credential } from '../../packages/config/credentials.js';
import { SessionService } from '../../packages/session-service/index.js';
import { registerCharacterRoutes } from './character-routes.js';
import { registerOperationsRoutes } from './operations-routes.js';
import { registerMembershipRoutes } from './membership-routes.js';

type Role='operator'|'viewer';
type Login={role:Role;csrf:string;expires:number};
function equal(a:string,b:string):boolean { const aa=Buffer.from(a),bb=Buffer.from(b); return aa.length===bb.length&&timingSafeEqual(aa,bb); }
function header(request:FastifyRequest,name:string):string { const value=request.headers[name]; return typeof value==='string'?value:''; }
const ParamId=z.object({id:Id});
const PageQuery=z.object({cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).strict();
const RunAuth=z.object({epoch:z.number().int().positive(),token:Id}).strict();
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.map':'application/json','.svg':'image/svg+xml'};

/** Single-operator lab authentication. Not a multi-tenant/public hosting authentication product. */
export function buildServer(service:SessionService,options:{webRoot?:string;timers?:boolean}={}) {
  const config=service.config;
  const app=Fastify({logger:false,bodyLimit:65536,requestTimeout:20000,connectionTimeout:10000,forceCloseConnections:true});
  const logins=new Map<string,Login>(),attempts=new Map<string,{count:number;until:number}>();
  const streams=new Set<()=>void>();
  const security={
    'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cache-control':'no-store',
  };
  app.addHook('onRequest',async(req,reply)=>{
    for(const [k,v] of Object.entries(security)) reply.header(k,v);
    ensure(header(req,'host')===new URL(config.publicOrigin).host || (req.url.startsWith('/v1/worker/') && Object.values(config.workerTokens).some(t=>equal(header(req,'authorization'),'Bearer '+t))),403,'INVALID_HOST');
    const origin=header(req,'origin'); if(origin) ensure(origin===config.publicOrigin,403,'INVALID_ORIGIN');
  });
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof ZodError) return reply.code(422).send({code:'VALIDATION_ERROR',issues:error.issues.map(i=>({path:i.path,message:i.message}))});
    if(error instanceof AppError) return reply.code(error.status).send({code:error.code});
    const status=(error as {statusCode?:number}).statusCode;
    return reply.code(status&&status>=400&&status<500?status:500).send({code:status===413?'BODY_TOO_LARGE':'REQUEST_FAILED'});
  });
  function cookieId(req:FastifyRequest):string {
    return header(req,'cookie').split(';').map(v=>v.trim()).find(v=>v.startsWith('mls_session='))?.slice('mls_session='.length)??'';
  }
  function principal(req:FastifyRequest,write=false,operator=false):Login {
    const bearer=header(req,'authorization');
    if(bearer.startsWith('Bearer ')) {
      const token=bearer.slice(7); const role=equal(token,config.adminToken)?'operator':config.viewerToken&&equal(token,config.viewerToken)?'viewer':null;
      ensure(role,401,'AUTH_REQUIRED'); ensure(!operator||role==='operator',403,'OPERATOR_REQUIRED');
      ensure(!write||role==='operator',403,'READ_ONLY'); return {role,csrf:'',expires:Infinity};
    }
    const login=logins.get(cookieId(req)); ensure(login&&login.expires>service.now(),401,'AUTH_REQUIRED');
    ensure(!operator||login.role==='operator',403,'OPERATOR_REQUIRED');
    if(write) { ensure(login.role==='operator',403,'READ_ONLY'); ensure(header(req,'origin')===config.publicOrigin,403,'ORIGIN_REQUIRED'); ensure(equal(header(req,'x-csrf-token'),login.csrf),403,'CSRF_REQUIRED'); }
    return login;
  }
  function worker(req:FastifyRequest):string {
    const token=header(req,'authorization').replace(/^Bearer /,'');
    const slot=Object.entries(config.workerTokens).find(([,key])=>equal(token,key))?.[0]; ensure(slot,401,'WORKER_AUTH_REQUIRED'); return slot;
  }
  function key(req:FastifyRequest):string { return header(req,'idempotency-key'); }
  function sessionId(req:FastifyRequest):string { return ParamId.parse(req.params).id; }
  function ownAgent(req:FastifyRequest,agentId:string):string { const slot=worker(req),agent=service.agent(agentId); ensure(agent.slot===slot&&agent.retired_at===null,403,'PRIVATE_STATE_FORBIDDEN'); return slot; }
  app.get('/healthz',async()=>({ok:true,sqlite:service.store.sqliteVersion}));
  app.post('/v1/auth/login',async(req,reply)=>{
    ensure(header(req,'origin')===config.publicOrigin,403,'ORIGIN_REQUIRED');
    const now=service.now(); for(const [ip,v] of attempts) if(v.until<=now) attempts.delete(ip);
    const old=attempts.get(req.ip)??{count:0,until:now+60000}; old.count++; attempts.set(req.ip,old); ensure(old.count<=10,429,'LOGIN_RATE_LIMIT');
    const {token}=z.object({token:z.string().max(500)}).strict().parse(req.body);
    const role=equal(token,config.adminToken)?'operator':config.viewerToken&&equal(token,config.viewerToken)?'viewer':null;
    ensure(role,401,'INVALID_LOGIN');
    for(const [id,login] of logins) if(login.expires<=now) logins.delete(id);
    ensure(logins.size<100,503,'LOGIN_CAPACITY');
    const id=randomBytes(32).toString('base64url');const login:Login={role,csrf:randomBytes(32).toString('base64url'),expires:now+8*3600000}; logins.set(id,login);
    reply.header('set-cookie',`mls_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.publicOrigin.startsWith('https:')?'; Secure':''}`);
    return {role:login.role,csrf:login.csrf};
  });
  app.get('/v1/auth/me',async req=>{const p=principal(req);return {role:p.role,csrf:p.csrf};});
  app.post('/v1/auth/logout',async(req,reply)=>{
    principal(req); ensure(header(req,'origin')===config.publicOrigin,403,'ORIGIN_REQUIRED');
    logins.delete(cookieId(req));service.changes.emit('changed');reply.header('set-cookie','mls_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return {ok:true};
  });
  app.get('/v1/capabilities',async req=>{principal(req);return {
    profiles:service.modelProfiles().map(p=>({id:p.id,provider:p.provider,model:p.model})),
    slots:Object.keys(config.workerTokens),defaults:config.defaults,liveEnabled:config.allowLive,
  };});
  app.get('/v1/model-profiles',async req=>{principal(req,false,true);return service.providerDiagnostics().map(item=>{
    let credentialConfigured=false;try{credentialConfigured=!item.profile.authRequired||!!credential(item.profile);}catch{}
    return {...item,credentialConfigured:item.profile.provider==='mock'||credentialConfigured,liveEnabled:config.allowLive};
  });});
  app.post('/v1/model-profiles',async req=>{principal(req,true,true);return service.putModelProfile(req.body);});
  app.post('/v1/model-profiles/:profile/retry',async req=>{principal(req,true,true);const {profile}=z.object({profile:Slug}).parse(req.params);return service.retryProvider(profile,key(req));});
  registerOperationsRoutes(app,service,(req,write=false)=>{ principal(req,write,true); });
  registerSourceRoutes(app,service,(req,write=false)=>{ principal(req,write,true); });
  registerMembershipRoutes(app,service,(req,write=false,operator=false)=>{ principal(req,write,operator); });
  app.get('/v1/characters',async req=>{
    const p=principal(req);return service.characters().map(c=>p.role==='operator'?c:{schemaVersion:c.schemaVersion,id:c.id,version:c.version,name:c.name,presentationRef:c.presentationRef});
  });
  app.post('/v1/characters',async req=>{principal(req,true,true);return service.store.tx(()=>service.putCharacter(req.body));});
  registerCharacterRoutes(app,service,(req,write=false)=>{ principal(req,write,true); });
  app.get('/v1/sessions',async req=>{principal(req);return service.listSessions();});
  app.post('/v1/sessions',async req=>{principal(req,true,true);return service.createSession(req.body,key(req));});
  for(const action of ['start','pause','resume','end'] as const) app.post(`/v1/sessions/:id/${action}`,async req=>{
    principal(req,true,true);z.object({}).strict().parse(req.body??{});return service.lifecycle(sessionId(req),action,key(req));
  });
  app.post('/v1/sessions/:id/settings',async req=>{principal(req,true,true);return service.updateSettings(sessionId(req),req.body,key(req));});
  app.post('/v1/sessions/:id/members',async req=>{
    principal(req,true,true);const body=z.object({agentId:Id,enabled:z.boolean()}).strict().parse(req.body);
    service.setAgentEnabled(sessionId(req),body.agentId,body.enabled,key(req));return {ok:true};
  });
  app.post('/v1/sessions/:id/budget',async req=>{principal(req,true,true);z.object({}).strict().parse(req.body);return service.renewBudget(sessionId(req),key(req));});
  app.post('/v1/sessions/:id/agents/:agentId/retry',async req=>{principal(req,true,true);const p=z.object({id:Id,agentId:Id}).parse(req.params);return service.retryAgent(p.id,p.agentId,key(req));});
  app.get('/v1/sessions/:id/history',async req=>{principal(req);return service.pages.history(sessionId(req),PageQuery.parse(req.query));});
  app.get('/v1/sessions/:id/threads/:messageId',async req=>{principal(req);const p=z.object({id:Id,messageId:Id}).parse(req.params);return service.pages.thread(p.id,p.messageId,PageQuery.parse(req.query));});
  app.get('/v1/sessions/:id/search-page',async req=>{principal(req);const {q,...options}=PageQuery.extend({q:z.string().min(1).max(200)}).parse(req.query);return service.pages.search(sessionId(req),q,options);});
  app.post('/v1/sessions/:id/messages/lookup',async req=>{principal(req);const {ids}=z.object({ids:z.array(Id).max(200)}).strict().parse(req.body);return service.pages.byIds(sessionId(req),ids);});
  app.get('/v1/sessions/:id/snapshot',async req=>{principal(req);return service.snapshot(sessionId(req));});
  app.post('/v1/sessions/:id/messages',async req=>{principal(req,true,true);return service.humanMessage(sessionId(req),req.body,key(req));});
  app.post('/v1/sessions/:id/messages/:messageId',async req=>{
    principal(req,true,true);const p=z.object({id:Id,messageId:Id}).parse(req.params),body=z.object({text:z.string().nullable()}).strict().parse(req.body);
    return service.changeMessage(p.id,p.messageId,body.text,key(req));
  });
  app.post('/v1/sessions/:id/sources',async req=>{principal(req,true,true);return service.injectSource(sessionId(req),req.body,key(req));});
  app.get('/v1/sessions/:id/search',async req=>{principal(req);const q=z.object({q:z.string().min(1).max(200)}).parse(req.query);return service.searchArchive(sessionId(req),q.q);});
  app.get('/v1/sessions/:id/archive/:messageId',async req=>{principal(req);const p=z.object({id:Id,messageId:Id}).parse(req.params);return service.archiveMessage(p.id,p.messageId);});
  app.get('/v1/sessions/:id/commands/:operation/:key',async req=>{
    principal(req,false,true);const p=z.object({id:Id,operation:z.enum(['message','lifecycle','edit','settings','membership','participants','clone']),key:z.string().max(128)}).parse(req.params);
    return service.commandReceipt(p.id,p.operation,p.key);
  });
  registerObservabilityRoutes(app,service,(req,operator)=>{principal(req,false,operator);});
  app.get('/v1/sessions/:id/diagnostics',async req=>{principal(req,false,true);return service.diagnostics(sessionId(req));});
  app.get('/v1/sessions/:id/export',async(req,reply)=>{principal(req,false,true);const id=sessionId(req);reply.header('content-disposition',`attachment; filename="session-${id}.json"`);return publicTranscript(service,id);});
  app.get('/v1/sessions/:id/events',async(req,reply)=>{
    const p=principal(req),id=sessionId(req);const loginId=header(req,'authorization').startsWith('Bearer ')?'':cookieId(req);const authorized=()=>p.expires>service.now()&&(!loginId||logins.get(loginId)===p);
    const query=z.object({cursor:z.string().max(100).optional()}).parse(req.query);
    let cursor=header(req,'last-event-id')||query.cursor||service.snapshot(id).cursor;
    service.eventsAfter(id,cursor,1); ensure(streams.size<50,503,'STREAM_LIMIT');
    reply.hijack();reply.raw.writeHead(200,{...security,'content-type':'text/event-stream; charset=utf-8','connection':'keep-alive','x-accel-buffering':'no'});
    reply.raw.write(': connected\n\n');
    let closed=false,pumping=false;
    const close=()=>{if(closed)return;closed=true;clearInterval(timer);service.changes.off('changed',pump);streams.delete(close);reply.raw.end();};
    const pump=()=>{
      if(closed||pumping)return;
      if(!authorized()||reply.raw.writableLength>262144){close();return;}
      pumping=true;
      try {
        const events=service.eventsAfter(id,cursor);
        for(const event of events) {cursor=event.id;if(!reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)){close();return;}}
        if(events.length===100) setImmediate(pump);
      } catch {close();} finally {pumping=false;}
    };
    const timer=setInterval(()=>{if(!authorized())close();else {reply.raw.write(': heartbeat\n\n');pump();}},10000);
    streams.add(close);service.changes.on('changed',pump);reply.raw.on('close',close);pump();
  });
  app.post('/v1/worker/register',async req=>{z.object({}).strict().parse(req.body);return service.registerWorker(worker(req));});
  app.post('/v1/worker/claim',async req=>{const b=z.object({epoch:z.number().int().positive()}).strict().parse(req.body);return service.claim(worker(req),b.epoch);});
  app.post('/v1/worker/runs/:id/heartbeat',async req=>{const b=RunAuth.parse(req.body);return service.heartbeat(worker(req),b.epoch,sessionId(req),b.token);});
  app.post('/v1/worker/runs/:id/calls',async req=>{
    const b=RunAuth.extend({requestKey:z.string().min(8).max(128),stage:z.enum(['primary','repair','lookup'])}).parse(req.body);
    return service.reserveCall(worker(req),b.epoch,sessionId(req),b.token,b.requestKey,b.stage);
  });
  app.post('/v1/worker/runs/:id/calls/:callId',async req=>{
    const p=z.object({id:Id,callId:Id}).parse(req.params),b=z.object({token:Id,usage:UsageSchema,error:ErrorCodeSchema.nullable(),retryAfterMs:z.number().int().min(0).max(86400000).default(0)}).strict().parse(req.body);
    return service.finishCall(worker(req),p.id,b.token,p.callId,b.usage,b.error,b.retryAfterMs);
  });
  app.post('/v1/worker/runs/:id/lookup',async req=>{
    const b=RunAuth.extend({requestKey:z.string().min(8).max(128),requests:z.array(LookupRequestSchema).min(1).max(3)}).parse(req.body);
    return service.retrieve(worker(req),b.epoch,sessionId(req),b.token,b.requestKey,b.requests);
  });
  app.get('/v1/worker/agents/:id/memory-page',async req=>{
    const id=sessionId(req);ownAgent(req,id);const {q,...options}=PageQuery.extend({q:z.string().max(200).default('')}).parse(req.query);return service.pages.memories(id,q,options);
  });
  app.post('/v1/worker/runs/:id/result',async req=>{const b=RunAuth.extend({output:z.unknown()}).parse(req.body);return service.completeRun(worker(req),b.epoch,sessionId(req),b.token,b.output);});
  app.post('/v1/worker/runs/:id/failure',async req=>{const b=RunAuth.extend({code:ErrorCodeSchema}).parse(req.body);return service.failRun(worker(req),b.epoch,sessionId(req),b.token,b.code as ModelErrorCode);});
  app.get('/v1/worker/agents/:id/memory',async req=>{const id=sessionId(req);return service.workerMemories(ownAgent(req,id),id);});
  app.get('/v1/worker/agents/:id/archive',async req=>{const id=sessionId(req);ownAgent(req,id);const q=z.object({q:z.string().min(1).max(200)}).parse(req.query);return service.searchArchive(service.agent(id).session_id,q.q);});
  app.get('/v1/worker/agents/:id/archive/:messageId',async req=>{const p=z.object({id:Id,messageId:Id}).parse(req.params);ownAgent(req,p.id);return service.archiveMessage(service.agent(p.id).session_id,p.messageId);});
  const root=resolve(options.webRoot??'dist/web');
  async function asset(path:string) {const file=resolve(root,path);ensure(file.startsWith(root+sep),404,'NOT_FOUND');try{return await readFile(file);}catch{throw new AppError(404,'NOT_FOUND');}}
  app.get('/',async(_req,reply)=>{reply.type('text/html; charset=utf-8');return asset('index.html');});
  app.get('/assets/*',async(req,reply)=>{const p=(req.params as {'*':string})['*'];reply.type(mime[extname(p)]??'application/octet-stream');return asset('assets/'+p);});
  let scheduler:ReturnType<typeof setInterval>|undefined;
  if(options.timers!==false) scheduler=setInterval(()=>{try{service.tick();}catch{console.error('Scheduler transaction failed');}},200);
  app.addHook('preClose',async()=>{if(scheduler)clearInterval(scheduler);for(const close of [...streams])close();});
  return app;
}
