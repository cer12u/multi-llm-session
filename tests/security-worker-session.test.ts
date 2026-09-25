import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {saveOwnerExperience} from './fixtures/membership.js';
import {buildServer} from '../apps/core/server.js';

it('R10-SEC-003: a Worker token is not a grant to read every saved Agent using that slot',async()=>{
  const f=fixture(3,{memoryEvery:3}),app=buildServer(f.service,{timers:false});
  try{
    const {owner}=saveOwnerExperience(f),headers={host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.workerTokens['worker-0']};
    f.service.lifecycle(f.id,'pause',randomUUID());
    const other=f.service.createSession(f.input,randomUUID()).id;f.service.lifecycle(other,'start',randomUUID());
    const current=f.claim()!;expect(current.context.self.id).not.toBe(owner);expect(current.context.self.privateState!.entries).toEqual([]);
    for(const path of ['memory','memory-page','archive?q=集合']){
      const wrong=await app.inject({method:'GET',url:`/v1/worker/agents/${owner}/${path}`,headers});
      expect(wrong.statusCode).toBe(403);expect(wrong.body).not.toContain('OWNER_PRIVATE_');
    }
    const permitted=await app.inject({method:'GET',url:`/v1/worker/agents/${current.context.self.id}/memory-page`,headers});
    expect(permitted.statusCode).toBe(200);expect(permitted.json().items).toEqual([]);
    f.service.lifecycle(other,'pause',randomUUID());
    expect((await app.inject({method:'GET',url:`/v1/worker/agents/${current.context.self.id}/memory`,headers})).statusCode).toBe(403);
    // Operator audit of both sessions remains available, without impersonating a Worker.
    const audit=await app.inject({method:'GET',url:`/v1/sessions/${f.id}/diagnostic-export`,headers:{...headers,authorization:'Bearer '+f.config.adminToken}});
    expect(audit.statusCode).toBe(200);expect(audit.body).toContain('OWNER_PRIVATE_MEMORY_KEEP');
  }finally{await app.close();f.close();}
});
