import { expect,it } from 'vitest';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateDeployment } from '../packages/config/deployment.js';
import { readServiceTokenFiles } from '../packages/config/service-token-files.js';

function input(dir:string){
  const key=join(dir,'input.key');writeFileSync(key,'synthetic-deployment-model-key-000000000000');
  return {schemaVersion:1,allowLive:true,profiles:[{id:'local',version:7,provider:'ollama',model:'synthetic-model',baseUrl:'http://127.0.0.1:11434/api',allowLocalHttp:true,apiKeyEnv:'OLLAMA_API_KEY',jsonMode:'json'}],
    workers:['sora','nagi','rin'].map((characterId,i)=>({id:'worker-'+i,characterId,profileId:'local'})),credentialFiles:{OLLAMA_API_KEY:key}};
}
it('R10-DEPLOY-001: create-only generation pins versions, separates credentials and keeps all secrets outside the build context',()=>{
  const dir=mkdtempSync(join(tmpdir(),'deployment-'));
  try{
    const data=input(dir),out=join(dir,'runtime'),result=generateDeployment(data,out,resolve('.'));
    const compose=JSON.parse(readFileSync(result.composePath,'utf8')),config=JSON.parse(readFileSync(result.configPath,'utf8'));
    expect(compose.services.core.ports).toEqual(['127.0.0.1:3000:3000']);expect(config.profiles[0].version).toBe(7);
    expect(config.workerSlots).toHaveLength(3);expect(result.profiles).toEqual([{id:'local',version:7}]);
    const text=readFileSync(result.composePath,'utf8');expect(text).not.toContain('synthetic-deployment-model-key');
    expect(text).not.toContain(readFileSync(result.adminTokenPath,'utf8').trim());
    for(let i=0;i<3;i++){
      const worker=compose.services['worker-'+i];expect(worker.volumes).toBeUndefined();expect(worker.read_only).toBe(true);
      expect(worker.secrets).toEqual(['worker-'+i+'-token','model-0']);expect(worker.environment.ADMIN_TOKEN).toBeUndefined();
      expect(Object.keys(JSON.parse(worker.environment.APP_TOKEN_FILES))).toEqual(['WORKER_TOKEN']);
    }
    expect(statSync(out).mode&0o077).toBe(0);expect(readFileSync(data.credentialFiles.OLLAMA_API_KEY,'utf8')).toBe('synthetic-deployment-model-key-000000000000');
    expect(()=>generateDeployment(data,out)).toThrow();expect(existsSync(result.composePath)).toBe(true);
    expect(()=>generateDeployment(data,join(resolve('.'),'must-not-create'))).toThrow('DEPLOY_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('R10-DEPLOY-002: a worker receives only its selected model credential, while unsupported and ambiguous configuration fails before output',()=>{
  const dir=mkdtempSync(join(tmpdir(),'deployment-mixed-'));
  try{
    const data=input(dir),other=join(dir,'other.key');writeFileSync(other,'synthetic-distinct-model-key-0000000000000');
    const profiles=[...data.profiles,{...data.profiles[0],id:'other',apiKeyEnv:'OTHER_API_KEY'}];
    const result=generateDeployment({...data,profiles,credentialFiles:{...data.credentialFiles,OTHER_API_KEY:other},workers:data.workers.map((w,i)=>({...w,profileId:i?'other':'local'}))},join(dir,'mixed'));
    const services=JSON.parse(readFileSync(result.composePath,'utf8')).services;
    expect(services['worker-0'].secrets).toEqual(['worker-0-token','model-0']);expect(services['worker-1'].secrets).toEqual(['worker-1-token','model-1']);
    for(const bad of [{...data,allowLive:false},{...data,credentialFiles:{}},{...data,workers:data.workers.map(w=>({...w,profileId:'missing'}))},{...data,profiles:[...profiles,{...profiles[0]}]}]){
      const path=join(dir,'invalid');expect(()=>generateDeployment(bad,path)).toThrow();expect(existsSync(path)).toBe(false);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('R10-DEPLOY-003: launch token files require opt-in and reject credential ambiguity or executable environment names',()=>{
  const dir=mkdtempSync(join(tmpdir(),'launch-token-'));
  try{
    const file=join(dir,'token');writeFileSync(file,'synthetic-service-token-00000000000000000');
    const env={ALLOW_LIVE_MODELS:'1',APP_TOKEN_FILES:JSON.stringify({WORKER_TOKEN:file})};
    expect(readServiceTokenFiles(env)).toEqual({WORKER_TOKEN:'synthetic-service-token-00000000000000000'});
    expect(()=>readServiceTokenFiles({...env,ALLOW_LIVE_MODELS:'0'})).toThrow('LIVE_OPT_IN_REQUIRED');
    expect(()=>readServiceTokenFiles({...env,WORKER_TOKEN:'already-set'})).toThrow('AMBIGUOUS_SERVICE_TOKEN');
    expect(()=>readServiceTokenFiles({...env,APP_TOKEN_FILES:JSON.stringify({NODE_OPTIONS:file})})).toThrow('INVALID_SERVICE_TOKEN_BINDINGS');
    expect(()=>readServiceTokenFiles({...env,APP_TOKEN_FILES:JSON.stringify({WORKER_TOKEN:join(dir,'missing')})})).toThrow('SERVICE_TOKEN_FILE_UNREADABLE');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
