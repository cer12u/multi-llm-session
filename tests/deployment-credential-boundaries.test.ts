import { expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateDeployment } from '../packages/config/deployment.js';

function input(path:string){return {schemaVersion:1,allowLive:true,profiles:[{id:'native',provider:'ollama',model:'synthetic',baseUrl:'http://127.0.0.1:11434/api',allowLocalHttp:true,apiKeyEnv:'MODEL_KEY'}],workers:['sora','nagi','rin'].map((characterId,i)=>({id:'worker-'+i,characterId,profileId:'native'})),credentialFiles:{MODEL_KEY:path}};}
it('R10-DEPLOY-007: source credentials inside the Docker/Git tree, even via an external alias, are never copied or built',()=>{
  const dir=mkdtempSync(join(tmpdir(),'credential-boundary-'));
  try{
    const repository=join(dir,'repository');mkdirSync(repository);const key=join(repository,'private.key');writeFileSync(key,'synthetic credential that must never enter an image');
    const alias=join(dir,'alias.key');symlinkSync(key,alias);
    for(const path of [key,alias]){const output=join(dir,'runtime');expect(()=>generateDeployment(input(path),output,repository)).toThrow('DEPLOY_CREDENTIAL_MUST_BE_OUTSIDE_REPOSITORY');expect(existsSync(output)).toBe(false);}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('R10-DEPLOY-008: directories, oversized files and multi-line credentials fail before any deployment is created',()=>{
  const dir=mkdtempSync(join(tmpdir(),'credential-validation-'));
  try{
    const repository=join(dir,'repository');mkdirSync(repository);
    const oversized=join(dir,'oversized.key'),multiline=join(dir,'multiline.key');writeFileSync(oversized,'x'.repeat(16384));writeFileSync(multiline,'one\ntwo');
    for(const path of [dir,oversized,multiline]){const output=join(dir,'runtime');expect(()=>generateDeployment(input(path),output,repository)).toThrow();expect(existsSync(output)).toBe(false);}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
