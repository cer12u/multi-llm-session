import {expect,it} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelProfileSchema} from '../packages/contracts/index.js';
import {credential,validateProfileUrl} from '../packages/config/credentials.js';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';

const profile=(name='MODEL_KEY')=>ModelProfileSchema.parse({id:'configured',provider:'openai',model:'synthetic',baseUrl:'https://fixture.invalid/v1',apiKeyEnv:name});
it.each(['ADMIN_TOKEN','VIEWER_TOKEN','WORKER_TOKEN','WORKER_A_TOKEN','APP_TOKEN_FILES','NODE_OPTIONS','GITHUB_TOKEN','MODEL_KEY_FILE'])('R10-SEC-000: profile %s cannot read a privileged environment binding or a secret path as a model key',name=>{
  const p=profile(name);
  expect(()=>validateProfileUrl(p)).toThrow('RESERVED_CREDENTIAL_NAME');
  expect(()=>credential(p,{[name]:'PRIVILEGED_VALUE_MUST_NOT_BE_READ'})).toThrow('RESERVED_CREDENTIAL_NAME');
});
it('R10-SEC-001: runtime model credentials are bounded regular files or validated values, with projected-secret symlink support',()=>{
  const dir=mkdtempSync(join(tmpdir(),'model-credential-'));
  try{
    const p=profile(),file=join(dir,'secret'),alias=join(dir,'projected'),large=join(dir,'large');
    writeFileSync(file,'synthetic-credential\n');symlinkSync(file,alias);writeFileSync(large,'x'.repeat(16384));
    expect(credential(p,{MODEL_KEY_FILE:alias})).toBe('synthetic-credential');
    for(const path of [dir,large,join(dir,'missing')])expect(()=>credential(p,{MODEL_KEY_FILE:path})).toThrow();
    for(const value of ['','x'.repeat(16384),'first\r\nAuthorization: stolen','x\u0000y','x\ty'])expect(()=>credential(p,{MODEL_KEY:value})).toThrow('INVALID_MODEL_CREDENTIAL');
    expect(()=>credential(p,{MODEL_KEY:'',MODEL_KEY_FILE:file})).toThrow('AMBIGUOUS_MODEL_CREDENTIAL');
    expect(credential(p,{})).toBeUndefined();expect(credential(p,{MODEL_KEY:'synthetic-valid'})).toBe('synthetic-valid');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('R10-SEC-002: real profile API refuses privileged credential references before persisting or invoking a Provider',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    const headers={host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.adminToken};
    for(const name of ['ADMIN_TOKEN','WORKER_TOKEN','GITHUB_TOKEN','MODEL_KEY_FILE']){
      const result=await app.inject({method:'POST',url:'/v1/model-profiles',headers,payload:profile(name)});
      expect(result.statusCode).toBe(422);expect(result.json().code).toBe('RESERVED_CREDENTIAL_NAME');
      expect(result.body).not.toContain(f.config.adminToken);
    }
    expect(f.service.modelProfiles().map(p=>p.id)).toEqual(['mock']);expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
