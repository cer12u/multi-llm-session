import { expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { LocalCharacterProvider, resolveCharacter } from '../packages/characters/index.js';
import { CharacterCatalog } from '../packages/session-service/characters.js';
import { buildServer } from '../apps/core/server.js';

it('R9-CHAR-002: local and asynchronous providers preserve exact references without holding the SQLite lock', async () => {
  const f = fixture();
  try {
    const definition = { ...f.config.characters[0], id: 'provider-test', version: 1 };
    const provider = new LocalCharacterProvider([definition]), ref = { id: definition.id, version: 1 };
    const first = provider.load(ref); first.persona = 'caller mutation';
    expect(provider.load(ref).persona).toBe(definition.persona);
    expect(() => provider.load({ ...ref, version: 2 })).toThrow('CHARACTER_VERSION_NOT_FOUND');
    expect(() => new LocalCharacterProvider([definition, definition])).toThrow('DUPLICATE_CHARACTER_VERSION');
    await expect(resolveCharacter({ load: () => ({ ...definition, id: 'another' }) }, ref)).rejects.toThrow('CHARACTER_REF_MISMATCH');
    const catalog = new CharacterCatalog(f.service);
    const imported = await catalog.import({ load: async requested => {
      expect(requested).toEqual(ref); expect(f.store.db.inTransaction).toBe(false);
      await Promise.resolve(); expect(f.store.db.inTransaction).toBe(false); return definition;
    } }, ref);
    expect(imported.character).toEqual(definition); expect(imported.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.load(ref)).toEqual(definition);
    f.store.run('UPDATE characters SET hash=? WHERE id=?', 'corrupt', ref.id);
    expect(() => catalog.get(ref)).toThrow('CHARACTER_DEFINITION_CORRUPT');
  } finally { f.close(); }
});

it('R9-CHAR-003: new character routes enforce Host, session expiry, operator role and write CSRF', async () => {
  const f = fixture(), app = buildServer(f.service, { timers: false });
  const host = new URL(f.config.publicOrigin).host, origin = f.config.publicOrigin;
  const definition = { ...f.config.characters[0], id: 'security-test', version: 1 };
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { host, origin }, payload: { token: f.config.adminToken } });
    expect(login.statusCode).toBe(200);
    const cookie = `mls_session=${login.cookies[0].value}`, csrf = login.json().csrf as string;
    const valid = { host, origin, cookie, 'x-csrf-token': csrf };
    const url = '/v1/characters/validate';
    for (const headers of [{ host, origin, cookie }, { ...valid, 'x-csrf-token': 'wrong' }, { ...valid, host: 'invalid.example' }, { ...valid, origin: 'https://invalid.example' }]) {
      const response = await app.inject({ method: 'POST', url, headers, payload: definition });
      expect(response.statusCode).toBe(403); expect(response.body).not.toContain(definition.persona);
    }
    const validated = await app.inject({ method: 'POST', url, headers: valid, payload: definition });
    expect(validated.statusCode).toBe(200); expect(validated.json().character).toEqual(definition);
    expect(f.store.get('SELECT id FROM characters WHERE id=?', definition.id)).toBeUndefined();
    for (const path of ['/v1/characters/validate', '/v1/characters/import']) {
      const viewer = await app.inject({ method: 'POST', url: path, headers: { host, authorization: 'Bearer ' + f.config.viewerToken }, payload: definition });
      expect(viewer.statusCode).toBe(403);
    }
    const imported = await app.inject({ method: 'POST', url: '/v1/characters/import', headers: valid, payload: definition });
    expect(imported.statusCode).toBe(200);
    const repeated = await app.inject({ method: 'POST', url: '/v1/characters/import', headers: valid, payload: definition });
    expect(repeated.json()).toEqual(imported.json());
    expect(f.store.all('SELECT id FROM characters WHERE id=?', definition.id)).toHaveLength(1);
    const path = `/v1/characters/${definition.id}/versions/1`;
    expect((await app.inject({ method: 'GET', url: path, headers: { host } })).statusCode).toBe(401);
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: valid, payload: {} });
    expect((await app.inject({ method: 'GET', url: path, headers: valid })).statusCode).toBe(401);
    expect(f.service.session(f.id).call_count).toBe(0);
  } finally { await app.close(); f.close(); }
});
