import {expect,it} from 'vitest';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';

it('R10-DIAG-REGRESSION: actual public transcript and private diagnostic routes are distinct and do not invoke inference',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false}),host=new URL(f.config.publicOrigin).host;
  try{
    f.say('one public original');
    const root=`/v1/sessions/${f.id}`;
    const publicRead=await app.inject({method:'GET',url:root+'/transcript',headers:{host,authorization:'Bearer '+f.config.viewerToken}});
    expect(publicRead.statusCode).toBe(200);expect(publicRead.json().kind).toBe('public-transcript');
    expect(publicRead.body).not.toContain('persona');
    const denied=await app.inject({method:'GET',url:root+'/diagnostic-export',headers:{host,authorization:'Bearer '+f.config.viewerToken}});
    expect(denied.statusCode).toBe(403);
    const privateRead=await app.inject({method:'GET',url:root+'/diagnostic-export',headers:{host,authorization:'Bearer '+f.config.adminToken}});
    expect(privateRead.statusCode).toBe(200);expect(privateRead.body).toContain('private-session-diagnostic');
    expect(privateRead.body).not.toContain(f.config.adminToken);expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
