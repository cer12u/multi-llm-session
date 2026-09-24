import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {Id,ensure} from '../../packages/contracts/index.js';
import type {SessionService} from '../../packages/session-service/index.js';

/** Same operator/Host/Origin/CSRF boundary as other administration; episode metadata is public read-only. */
export function registerMembershipRoutes(app:FastifyInstance,service:SessionService,authorize:(req:FastifyRequest,write?:boolean,operator?:boolean)=>void):void{
  const id=(req:FastifyRequest)=>z.object({id:Id}).parse(req.params).id;
  const key=(req:FastifyRequest)=>{const value=req.headers['idempotency-key'];ensure(typeof value==='string',422,'IDEMPOTENCY_KEY_REQUIRED');return value;};
  app.get('/v1/sessions/:id/membership',async req=>{authorize(req,false,true);return service.membership(id(req));});
  app.post('/v1/sessions/:id/membership',async req=>{authorize(req,true,true);return service.updateMembership(id(req),req.body,key(req));});
  app.get('/v1/sessions/:id/episodes',async req=>{authorize(req);return service.episodes(id(req));});
  app.post('/v1/sessions/:id/clone',async req=>{authorize(req,true,true);return service.cloneSession(id(req),req.body,key(req));});
}
