import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';

it('R6-SOURCE-000: the real source API accepts an explicit owner without publicly announcing its private title',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    const owner=f.service.agents(f.id)[0].id;
    const result=await app.inject({method:'POST',url:`/v1/sessions/${f.id}/sources`,headers:{host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.adminToken,'idempotency-key':randomUUID()},
      payload:{title:'PRIVATE_TARGETED_TITLE',text:'PRIVATE_TARGETED_BODY',audience:[owner]}});
    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(f.service.eventsAfter(f.id,f.id+':0'))).not.toContain('PRIVATE_TARGETED_');
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
