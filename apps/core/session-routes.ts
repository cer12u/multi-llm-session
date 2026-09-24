import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Id, ensure } from '../../packages/contracts/index.js';
import { continuity, memberCatalog } from '../../packages/session-service/continuity.js';
import type { SessionService } from '../../packages/session-service/index.js';

export function registerSessionRoutes(app: FastifyInstance, service: SessionService,
  authorize: (request: FastifyRequest, write?: boolean, operator?: boolean) => void): void {
  app.get('/v1/session-member-catalog', async req => { authorize(req, false, true); return memberCatalog(service); });
  app.get('/v1/sessions/:id/continuity', async req => {
    authorize(req); const { id } = z.object({ id: Id }).parse(req.params); return continuity(service, id);
  });
  app.post('/v1/sessions/:id/members', async req => {
    authorize(req, true, true); const { id } = z.object({ id: Id }).parse(req.params);
    const key = req.headers['idempotency-key']; ensure(typeof key === 'string', 422, 'IDEMPOTENCY_KEY_REQUIRED');
    return service.changeMembers(id, req.body, key);
  });
}
