import {HttpBody} from '../../packages/contracts/http.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Id, ensure } from '../../packages/contracts/index.js';
import type { SessionService } from '../../packages/session-service/index.js';

export function registerSourceRoutes(app:FastifyInstance,service:SessionService,authorize:(request:FastifyRequest,write?:boolean)=>void):void {
  const params=(req:FastifyRequest)=>z.object({id:Id,source:Id}).parse(req.params);
  const session=(req:FastifyRequest)=>z.object({id:Id}).parse(req.params).id;
  const key=(req:FastifyRequest)=>{const value=req.headers['idempotency-key'];ensure(typeof value==='string',422,'IDEMPOTENCY_KEY_REQUIRED');return value;};
  app.get('/v1/source-configurations',async req=>{authorize(req);return service.sources.configured();});
  app.get('/v1/sessions/:id/sources',async req=>{authorize(req);return service.sources.list(session(req));});
  app.get('/v1/sessions/:id/sources/:source',async req=>{authorize(req);const p=params(req);return service.sources.get(p.id,p.source);});
  app.get('/v1/sessions/:id/sources/:source/versions',async req=>{authorize(req);const p=params(req);return service.sources.versions(p.id,p.source);});
  app.get('/v1/sessions/:id/sources/:source/versions/:version',async req=>{authorize(req);const p=params(req);
    const {version}=z.object({version:z.coerce.number().int().nonnegative()}).parse(req.params);return service.sources.get(p.id,p.source,version);});
  app.post('/v1/sessions/:id/sources/:source',async req=>{authorize(req,true);const p=params(req);return service.sources.update(p.id,p.source,req.body,key(req));});
  app.get('/v1/sessions/:id/feeds',async req=>{authorize(req);return service.sources.feeds(session(req));});
  app.post('/v1/sessions/:id/feeds',async req=>{authorize(req,true);return service.sources.putFeed(session(req),req.body,key(req));});
  app.post('/v1/sessions/:id/feeds/:source/retry',async req=>{authorize(req,true);HttpBody.empty.parse(req.body);const p=params(req);return service.sources.retryFeed(p.id,p.source,key(req));});
}
