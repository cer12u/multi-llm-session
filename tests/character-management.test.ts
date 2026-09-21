import { expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { randomUUID } from 'node:crypto';

it('R9-CHAR-001: version listing/import/export preserve pinned personas and reject viewer access', async () => {
  const f = fixture(), app = buildServer(f.service, {timers:false});
  const headers = {host:new URL(f.config.publicOrigin).host, authorization:'Bearer '+f.config.adminToken};
  try {
    const original = f.config.characters[0];
    const first = await app.inject({method:'GET',url:`/v1/characters/${original.id}/versions`,headers});
    expect(first.statusCode).toBe(200); expect(first.json()).toEqual([expect.objectContaining({id:original.id,version:1})]);
    const updated = {...original,version:2,name:'Updated synthetic character',persona:'A different private synthetic persona'};
    const imported = await app.inject({method:'POST',url:'/v1/characters/import',headers,payload:updated});
    expect(imported.statusCode).toBe(200); expect(imported.json().character).toEqual(updated);
    const versions = await app.inject({method:'GET',url:`/v1/characters/${original.id}/versions`,headers});
    expect(versions.json().map((v:{version:number})=>v.version)).toEqual([2,1]);
    const old = await app.inject({method:'GET',url:`/v1/characters/${original.id}/versions/1`,headers});
    expect(old.json().character).toEqual(original);
    const exported = await app.inject({method:'GET',url:`/v1/characters/${original.id}/versions/2/export`,headers});
    expect(exported.statusCode).toBe(200); expect(exported.json()).toEqual(updated);
    expect(f.service.snapshot(f.id).agents[0].characterVersion).toBe(1);
    const next = f.service.createSession(f.input,randomUUID()).id;
    expect(f.service.snapshot(next).agents[0].characterVersion).toBe(2);
    const conflict = await app.inject({method:'POST',url:'/v1/characters/import',headers,payload:{...updated,persona:'Illegal overwrite'}});
    expect(conflict.statusCode).toBe(409);
    const malformed = await app.inject({method:'POST',url:'/v1/characters/import',headers,payload:{...updated,version:3,secret:'not allowed'}});
    expect(malformed.statusCode).toBe(422);
    const viewer = {...headers,authorization:'Bearer '+f.config.viewerToken};
    for (const path of [`/v1/characters/${original.id}/versions`,`/v1/characters/${original.id}/versions/2`,`/v1/characters/${original.id}/versions/2/export`]) {
      const response = await app.inject({method:'GET',url:path,headers:viewer}); expect(response.statusCode).toBe(403); expect(response.body).not.toContain(updated.persona);
    }
    const publicList = await app.inject({method:'GET',url:'/v1/characters',headers:viewer});
    expect(publicList.statusCode).toBe(200); expect(publicList.body).not.toContain('persona');
    expect(f.service.session(f.id).call_count).toBe(0);
  } finally { await app.close(); f.close(); }
});
