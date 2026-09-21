import { expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateDeployment } from '../packages/config/deployment.js';
import { readServiceTokenFiles } from '../packages/config/service-token-files.js';
import { loadConfig } from '../packages/config/index.js';
import { buildServer } from '../apps/core/server.js';
import { fixture } from './helpers.js';

function data(dir:string){const file=join(dir,'key');writeFileSync(file,'synthetic-startup-key-000000000000000000');return {schemaVersion:1,allowLive:true,profiles:[{id:'native',version:3,provider:'ollama',model:'synthetic',baseUrl:'http://127.0.0.1:11434/api',allowLocalHttp:true,apiKeyEnv:'MODEL_KEY'}],workers:['sora','nagi','rin'].map((characterId,i)=>({id:'worker-'+i,characterId,profileId:'native'})),credentialFiles:{MODEL_KEY:file}};}
it('R10-DEPLOY-004: the generated config and file-token environment load through the real Core configuration contract',()=>{
  const dir=mkdtempSync(join(tmpdir(),'deployment-startup-'));
  try{
    const result=generateDeployment(data(dir),join(dir,'runtime')),compose=JSON.parse(readFileSync(result.composePath,'utf8'));
    const env:NodeJS.ProcessEnv={...compose.services.core.environment,APP_CONFIG:result.configPath};
    const local=(path:string)=>compose.secrets[path.split('/').at(-1)!].file as string;
    env.APP_TOKEN_FILES=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(env.APP_TOKEN_FILES!) as Record<string,string>).map(([name,path])=>[name,local(path)])));
    for(const [name,value] of Object.entries(env))if(name.endsWith('_FILE')&&value?.startsWith('/run/secrets/'))env[name]=local(value);
    Object.assign(env,readServiceTokenFiles(env));const config=loadConfig(env);
    expect(config.allowLive).toBe(true);expect(Object.keys(config.workerTokens)).toEqual(['worker-0','worker-1','worker-2']);
    expect(config.profiles[0]).toMatchObject({id:'native',version:3,model:'synthetic'});
    expect(config.restartPolicy).toBe('paused');expect(config.adminToken.length).toBeGreaterThanOrEqual(24);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('R10-DEPLOY-005: generated healthcheck sends the configured Host to the actual guarded server without weakening Host validation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deployment-health-')),f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    f.config.publicOrigin='http://health.example';await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();if(!address||typeof address==='string')throw new Error('No fixture port');
    expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(403);
    const result=generateDeployment(data(dir),join(dir,'runtime')),compose=JSON.parse(readFileSync(result.composePath,'utf8'));
    const script=compose.services.core.healthcheck.test[3].replace('port:3000','port:'+address.port);
    await expect(promisify(execFile)(process.execPath,['-e',script],{env:{...process.env,PUBLIC_ORIGIN:f.config.publicOrigin},timeout:4000})).resolves.toMatchObject({stdout:'',stderr:''});
    expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(403);
  }finally{await app.close();f.close();rmSync(dir,{recursive:true,force:true});}
});
it('R10-DEPLOY-006: a parent symlink cannot put generated secrets back inside the Git/build tree',()=>{
  const dir=mkdtempSync(join(tmpdir(),'deployment-symlink-'));
  try{
    const repository=join(dir,'repository');mkdirSync(repository);symlinkSync(repository,join(dir,'alias'));
    const output=join(dir,'alias','private-output');expect(()=>generateDeployment(data(dir),output,repository)).toThrow('DEPLOY_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
    expect(existsSync(output)).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
