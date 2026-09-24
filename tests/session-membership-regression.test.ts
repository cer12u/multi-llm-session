import {expect,it} from 'vitest';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';

it('R7-MEMBERS-000: the actual Core exposes current versus historical membership without starting inference',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    const response=await app.inject({method:'GET',url:`/v1/sessions/${f.id}/membership`,headers:{host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.adminToken}});
    expect(response.statusCode).toBe(200);
    expect(response.json().current).toHaveLength(3);
    expect(response.json().archived).toEqual([]);
    expect(response.json().epoch).toBe(f.service.session(f.id).epoch);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
