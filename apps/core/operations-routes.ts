import {HttpBody} from '../../packages/contracts/http.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Id, Slug, ensure } from '../../packages/contracts/index.js';
import { operations, profileCatalog, profileVersions } from '../../packages/session-service/operations.js';
import type { SessionService } from '../../packages/session-service/index.js';

export function registerOperationsRoutes(app:FastifyInstance,service:SessionService,authorize:(req:FastifyRequest,write?:boolean)=>void):void{
  app.get('/v1/sessions/:id/usage',async req=>{authorize(req);const {id}=z.object({id:Id}).parse(req.params);return service.budgetReport(id);});
  app.post('/v1/sessions/:id/budget-policy',async req=>{
    authorize(req,true);const {id}=z.object({id:Id}).parse(req.params);
    const key=req.headers['idempotency-key'];ensure(typeof key==='string',422,'IDEMPOTENCY_KEY_REQUIRED');
    return service.updateBudgetPolicy(id,req.body,key);
  });
  app.get('/v1/provider-catalog',async req=>{authorize(req);return profileCatalog(service);});
  app.get('/v1/model-profiles/:profile/versions',async req=>{
    authorize(req);const {profile}=z.object({profile:Slug}).parse(req.params);
    const result=profileVersions(service,profile);ensure(result.length,404,'PROFILE_NOT_FOUND');return result;
  });
  app.get('/v1/sessions/:id/operations',async req=>{authorize(req);const {id}=z.object({id:Id}).parse(req.params);return operations(service,id);});
  app.post('/v1/model-profiles/:profile/versions/:version/retry',async req=>{
    authorize(req,true);HttpBody.empty.parse(req.body);
    const {profile,version}=z.object({profile:Slug,version:z.coerce.number().int().positive()}).parse(req.params);
    const key=req.headers['idempotency-key'];ensure(typeof key==='string',422,'IDEMPOTENCY_KEY_REQUIRED');
    return service.retryProvider(profile,key,version);
  });
}
