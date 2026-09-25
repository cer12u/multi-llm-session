import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delay } from '../agent-worker/runtime.js';

export async function startCluster(input:NodeJS.ProcessEnv=process.env,quiet=false,credentialBindings?:Record<string,string[]>):Promise<{base:string;token:string;stop:()=>Promise<void>;children:ChildProcess[]}> {
  const env={...input};const port=Number(env.PORT??3000);const base=env.PUBLIC_ORIGIN??`http://127.0.0.1:${port}`;
  env.PORT=String(port);env.PUBLIC_ORIGIN=base;env.APP_BIND=env.APP_BIND??'127.0.0.1';
  env.ADMIN_TOKEN=env.ADMIN_TOKEN??randomBytes(32).toString('hex');
  const file=env.APP_CONFIG?JSON.parse(readFileSync(env.APP_CONFIG,'utf8')) as {workerSlots?:{id:string;tokenEnv:string}[];profiles?:{apiKeyEnv?:string}[]}:{ };
  const slots=file.workerSlots??['a','b','c'].map(x=>({id:'worker-'+x,tokenEnv:'WORKER_'+x.toUpperCase()+'_TOKEN'}));
  for(const slot of slots)env[slot.tokenEnv]=env[slot.tokenEnv]??randomBytes(32).toString('hex');
  const ts=import.meta.url.endsWith('.ts');
  const launch=(relative:string,childEnv:NodeJS.ProcessEnv)=>spawn(process.execPath,[...ts?['--import','tsx']:[],fileURLToPath(new URL(relative+(ts?'.ts':'.js'),import.meta.url))],{env:childEnv,stdio:quiet?'ignore':'inherit'});
  const children:ChildProcess[]=[launch('../core/main',env)];
  let stopped=false;
  const stop=async()=>{
    if(stopped)return;stopped=true;
    for(const child of children.slice(1))child.kill('SIGTERM');
    await delay(150);children[0].kill('SIGTERM');
    const until=Date.now()+12000;
    while(children.some(c=>c.exitCode===null&&c.signalCode===null)&&Date.now()<until)await delay(50);
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  };
  try {
    let ready=false;
    for(let i=0;i<100;i++){
      if(children[0].exitCode!==null)throw new Error('Core exited before becoming ready');
      try{ready=(await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
      if(ready)break;await delay(100);
    }
    if(!ready)throw new Error('Core did not become ready');
    for(const slot of slots){
      const workerEnv:NodeJS.ProcessEnv={...env,CORE_URL:base,WORKER_TOKEN:env[slot.tokenEnv],WORKER_SLOT:slot.id};
      delete workerEnv.ADMIN_TOKEN;delete workerEnv.VIEWER_TOKEN;delete workerEnv.APP_CONFIG;delete workerEnv.DB_PATH;
      for(const other of slots)delete workerEnv[other.tokenEnv];
      if(credentialBindings){
        for(const profile of file.profiles??[])if(profile.apiKeyEnv){delete workerEnv[profile.apiKeyEnv];delete workerEnv[profile.apiKeyEnv+'_FILE'];}
        for(const name of credentialBindings[slot.id]??[]){if(env[name])workerEnv[name]=env[name];if(env[name+'_FILE'])workerEnv[name+'_FILE']=env[name+'_FILE'];}
      }
      children.push(launch('../agent-worker/main',workerEnv));
    }
    if(!quiet)console.log(`\nDedicated session app: ${base}\nLocal operator login token: ${env.ADMIN_TOKEN}\nMock mode uses no LLM API. Stop this cluster with Ctrl+C.\n`);
    return {base,token:env.ADMIN_TOKEN,stop,children};
  }catch(e){await stop();throw e;}
}
