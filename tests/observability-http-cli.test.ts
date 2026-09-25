import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';
import {diagnosticCommand,replayFile} from '../apps/cli/diagnostic-client.js';
import {operatorCommand} from '../apps/cli/operator-client.js';
import {diagnosticSnapshot} from '../packages/observability/index.js';
import {ReplayStream} from '../packages/observability/replay.js';

it('R10-DIAG-009: public/private HTTP export and run detail retain authentication, Host/Origin and logout boundaries without model calls',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});const host=new URL(f.config.publicOrigin).host,admin={host,authorization:'Bearer '+f.config.adminToken};
  try{
    f.say('public only');f.start();const run=f.claim()!;f.finish(run,{decision:'ABSTAIN',reason:'quiet'});const count=f.service.session(f.id).call_count;
    const root=`/v1/sessions/${f.id}`,viewer={host,authorization:'Bearer '+f.config.viewerToken};
    const publicRead=await app.inject({method:'GET',url:root+'/transcript',headers:viewer});expect(publicRead.statusCode).toBe(200);expect(publicRead.json().kind).toBe('public-transcript');
    const legacy=await app.inject({method:'GET',url:root+'/export',headers:admin});expect(legacy.json()).toEqual(publicRead.json());
    for(const url of [root+'/diagnostic-export',root+'/diagnostic-runs',root+'/diagnostic-runs/'+run.id]){
      const allowed=await app.inject({method:'GET',url,headers:admin});expect(allowed.statusCode).toBe(200);expect(allowed.body).not.toContain(run.token);
      for(const headers of [viewer,{host},{host,authorization:'Bearer '+f.config.workerTokens['worker-0']},{...admin,host:'invalid.test'},{...admin,origin:'https://invalid.test'}]){
        const response=await app.inject({method:'GET',url,headers});expect([401,403]).toContain(response.statusCode);expect(response.body).not.toContain(f.config.characters[0].persona);
      }
    }
    const other=f.service.createSession(f.input,randomUUID()).id;
    expect((await app.inject({method:'GET',url:`/v1/sessions/${other}/diagnostic-runs/${run.id}`,headers:admin})).statusCode).toBe(404);
    const login=await app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin:f.config.publicOrigin},payload:{token:f.config.adminToken}});
    const cookie='mls_session='+login.cookies[0].value,csrf=login.json().csrf;
    await app.inject({method:'POST',url:'/v1/auth/logout',headers:{host,origin:f.config.publicOrigin,cookie,'x-csrf-token':csrf},payload:{}});
    expect((await app.inject({method:'GET',url:root+'/diagnostic-export',headers:{host,cookie}})).statusCode).toBe(401);
    expect(f.service.session(f.id).call_count).toBe(count);
  }finally{await app.close();f.close();}
});

it('R10-DIAG-010: CLI downloads authenticated private NDJSON to mode 0600, replays offline and refuses overwrite/truncation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diagnostic-cli-')),f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    f.say('CLI public source');f.start();const run=f.claim()!;f.finish(run,{decision:'ABSTAIN',reason:'quiet'});
    await app.listen({host:'127.0.0.1',port:0});const addr=app.server.address();if(!addr||typeof addr==='string')throw new Error('Missing test port');
    const base=`http://127.0.0.1:${addr.port}`;f.config.publicOrigin=base;const env={CORE_URL:base,ADMIN_TOKEN:f.config.adminToken};
    const expected=diagnosticSnapshot(f.store,f.id),file=join(dir,'private.ndjson'),out=join(dir,'replayed.json');
    const result=await diagnosticCommand(['diagnostic-export',f.id,file],env);expect(result?.records).toBeGreaterThan(0);expect(statSync(file).mode&0o077).toBe(0);
    const text=readFileSync(file,'utf8');expect(text).not.toContain(run.token);expect(text).not.toContain(f.config.adminToken);expect((await replayFile(file)).state).toEqual(expected);
    const forbidden:typeof fetch=async()=>{throw new Error('OFFLINE_REPLAY_MUST_NOT_FETCH');};
    expect((await diagnosticCommand(['replay',file,out],{},forbidden))?.kind).toBe('private-replayed-projection');
    expect(statSync(out).mode&0o077).toBe(0);expect(JSON.parse(readFileSync(out,'utf8')).state).toEqual(expected);
    await expect(diagnosticCommand(['replay',file,out],{},forbidden)).rejects.toThrow('DIAGNOSTIC_DESTINATION_EXISTS');
    const partial=join(dir,'partial.ndjson'),bad=join(dir,'bad.json');writeFileSync(partial,text.slice(0,text.lastIndexOf('{"type":"end"')));
    await expect(diagnosticCommand(['replay',partial,bad],{},forbidden)).rejects.toThrow('REPLAY_FOOTER_REQUIRED');expect(existsSync(bad)).toBe(false);
    for(const args of [['transcript',f.id],['diagnostic-runs',f.id],['diagnostic-run',f.id,run.id]])expect((await operatorCommand(args,env)).ok).toBe(true);
    expect(f.service.session(f.id).call_count).toBe(1);
  }finally{await app.close();f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R10-DIAG-011: cookie expiry during private streaming cuts off the response without a valid completion footer',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    for(let i=0;i<120;i++)f.say('private export input '+i);
    const host=new URL(f.config.publicOrigin).host;
    const login=await app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin:f.config.publicOrigin},payload:{token:f.config.adminToken}});
    const cookie='mls_session='+login.cookies[0].value;
    // Once streaming moves to the next event-loop turn, expire the authentic cookie instead of bypassing authorization.
    const timer=setTimeout(()=>f.advance(48*3600000),0);
    let text='';try{const response=await app.inject({method:'GET',url:`/v1/sessions/${f.id}/diagnostic-export`,headers:{host,cookie}});text=response.body;}catch{}finally{clearTimeout(timer);}
    const replay=new ReplayStream();expect(()=>{for(const line of text.split('\n').filter(Boolean))replay.push(line);replay.finish();}).toThrow();
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
