import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CharacterSchema, Slug } from '../../packages/contracts/index.js';
import { LocalCharacterProvider } from '../../packages/characters/index.js';
import { CharacterCatalog } from '../../packages/session-service/characters.js';
import type { SessionService } from '../../packages/session-service/index.js';
import { hash } from '../../packages/domain/index.js';

/** The caller supplies the same operator/Origin/CSRF authorization used by other administration routes. */
export function registerCharacterRoutes(app: FastifyInstance, service: SessionService, authorize: (request: FastifyRequest, write?: boolean) => void): void {
  const catalog = new CharacterCatalog(service);
  const Ref = z.object({characterId:Slug,version:z.coerce.number().int().positive()}).strict();
  app.get('/v1/characters/:characterId/versions', async req => {
    authorize(req); const {characterId} = z.object({characterId:Slug}).strict().parse(req.params); return catalog.versions(characterId);
  });
  app.get('/v1/characters/:characterId/versions/:version', async req => {
    authorize(req); const {characterId:id,version} = Ref.parse(req.params); return catalog.get({id,version});
  });
  app.get('/v1/characters/:characterId/versions/:version/export', async (req,reply) => {
    authorize(req); const {characterId:id,version} = Ref.parse(req.params);
    const character = catalog.load({id,version});
    reply.header('content-disposition',`attachment; filename="character-${id}-v${version}.json"`); return character;
  });
  app.post('/v1/characters/validate', async req => {
    authorize(req,true); const character = CharacterSchema.parse(req.body); return {character,hash:hash(character)};
  });
  app.post('/v1/characters/import', async req => {
    authorize(req,true); const character = CharacterSchema.parse(req.body);
    return catalog.import(new LocalCharacterProvider([character]),{id:character.id,version:character.version});
  });
}
