import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CharacterSchema, ModelProfileSchema, SettingsSchema, Slug, ensure } from '../contracts/index.js';
import { defaultCharacters } from './index.js';
import { validateProfileUrl } from './credentials.js';
import { providerScope } from '../provider-state/index.js';

export const DeploymentSchema = z.object({
  schemaVersion: z.literal(1), allowLive: z.literal(true),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).default('multi-llm-session-live'),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/).default('multi-llm-session:ci'),
  port: z.number().int().min(1024).max(65535).default(3000),
  publicOrigin: z.string().url().default('http://127.0.0.1:3000'),
  characters: z.array(CharacterSchema).min(3).max(100).default(() => structuredClone(defaultCharacters)),
  profiles: z.array(ModelProfileSchema).min(1).max(30),
  workers: z.array(z.object({ id: z.string().regex(/^worker-[a-z0-9-]{1,24}$/), characterId: Slug, profileId: Slug }).strict()).min(3).max(16),
  credentialFiles: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().min(1)).default({}),
  sessionDefaults: SettingsSchema.default(() => SettingsSchema.parse({})),
}).strict();
export type Deployment = z.infer<typeof DeploymentSchema>;
export type ComposeService = {
  image: string; read_only: boolean; tmpfs: string[]; cap_drop: string[]; security_opt: string[];
  restart: string; command: string[]; environment: Record<string,string>; secrets: string[];
  build?: {context:string;dockerfile:string}; ports?: string[]; volumes?: string[];
  depends_on?: Record<string,{condition:string}>;
  healthcheck?: {test:string[];interval:string;timeout:string;retries:number};
};
export type DeploymentResult = {
  composePath:string; configPath:string; sessionPath:string; adminTokenPath:string;
  profiles:{id:string;version:number}[]; workers:number;
};
const reserved = /^(?:ADMIN_TOKEN|VIEWER_TOKEN|WORKER_TOKEN|WORKER_.*_TOKEN|NODE_OPTIONS|NODE_PATH|PATH|HOME|LD_.*|APP_.*|CORE_URL|ALLOW_.*|DB_PATH|PUBLIC_ORIGIN|PORT|RESTART_POLICY)$/;

/** Create-only output outside the source tree: private configuration/secrets never enter a build context. */
export function generateDeployment(input:unknown, output:string, repository=process.cwd()):DeploymentResult {
  const data=DeploymentSchema.parse(input), root=resolve(repository), target=resolve(output);
  const rel=relative(root,target);
  ensure(rel.startsWith('..'+(process.platform==='win32'?'\\':'/')) || rel==='..',422,'DEPLOY_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  ensure(process.platform!=='win32',422,'DEPLOY_LINUX_REQUIRED');
  ensure(new URL(data.publicOrigin).origin===data.publicOrigin,422,'PUBLIC_ORIGIN_MUST_BE_ORIGIN');
  ensure(new Set(data.characters.map(c=>c.id)).size===data.characters.length,422,'DUPLICATE_CHARACTER');
  ensure(new Set(data.profiles.map(p=>p.id)).size===data.profiles.length,422,'DUPLICATE_PROFILE');
  ensure(new Set(data.workers.map(w=>w.id)).size===data.workers.length,422,'DUPLICATE_WORKER_IDENTITY');
  const scopes=new Map<string,string>(), used=new Set<string>();
  for(const profile of data.profiles){
    validateProfileUrl(profile);
    const scope=providerScope(profile), policy=JSON.stringify([profile.maxConcurrent,profile.failureThreshold,profile.circuitCooldownMs]);
    ensure(!scopes.has(scope)||scopes.get(scope)===policy,422,'CONFLICTING_PROVIDER_POLICY');scopes.set(scope,policy);
    if(profile.apiKeyEnv){
      ensure(!reserved.test(profile.apiKeyEnv),422,'RESERVED_CREDENTIAL_NAME');
      if(data.credentialFiles[profile.apiKeyEnv])used.add(profile.apiKeyEnv);
    }
    ensure(profile.provider==='mock'||!profile.authRequired||!!(profile.apiKeyEnv&&data.credentialFiles[profile.apiKeyEnv]),422,'MISSING_MODEL_KEY');
  }
  for(const name of Object.keys(data.credentialFiles))ensure(used.has(name),422,'UNUSED_MODEL_CREDENTIAL');
  for(const worker of data.workers){
    ensure(data.characters.some(c=>c.id===worker.characterId),422,'UNKNOWN_CHARACTER');
    ensure(data.profiles.some(p=>p.id===worker.profileId),422,'UNKNOWN_MODEL_PROFILE');
  }
  // Read/validate sources before creating anything. Error messages never include their contents.
  const values=new Map<string,string>();
  for(const name of used){
    let value:string;
    try {const path=resolve(data.credentialFiles[name]);ensure(statSync(path).size<16384,422,'INVALID_MODEL_CREDENTIAL');value=readFileSync(path,'utf8').trim();}
    catch {throw new Error('DEPLOY_CREDENTIAL_UNREADABLE');}
    ensure(value.length>0&&value.length<16384,422,'INVALID_MODEL_CREDENTIAL');values.set(name,value);
  }
  mkdirSync(target,{mode:0o700});
  try {
    const secrets:Record<string,{file:string}>={}, credentialSecrets=new Map<string,string>();
    const secret=(id:string,value:string)=>{
      const file=join(target,id+'.secret');
      // Parent is mode0700. Docker file-secret mounts retain host file modes; 0444 allows the image's non-root UID to read them.
      writeFileSync(file,value+'\n',{flag:'wx',mode:0o444});secrets[id]={file};return id;
    };
    const admin=secret('admin-token',randomBytes(48).toString('base64url'));
    let index=0;for(const [name,value] of values)credentialSecrets.set(name,secret('model-'+index++,value));
    const tokenNames=data.workers.map((_,i)=>'WORKER_'+i+'_TOKEN');
    const tokens=data.workers.map((_,i)=>secret('worker-'+i+'-token',randomBytes(48).toString('base64url')));
    const configPath=join(target,'app.json'),sessionPath=join(target,'session-create.json');
    const config={characters:data.characters,profiles:data.profiles,workerSlots:data.workers.map((w,i)=>({id:w.id,tokenEnv:tokenNames[i]})),sessionDefaults:data.sessionDefaults};
    writeFileSync(configPath,JSON.stringify(config,null,2),{flag:'wx',mode:0o444});
    writeFileSync(sessionPath,JSON.stringify({title:'独立Agentの会話',participants:data.workers.map(w=>({slot:w.id,characterId:w.characterId,profileId:w.profileId})),settings:data.sessionDefaults},null,2),{flag:'wx',mode:0o600});
    const runtime=():ComposeService=>({image:data.image,read_only:true,tmpfs:['/tmp'],cap_drop:['ALL'],security_opt:['no-new-privileges:true'],restart:'unless-stopped',command:[],environment:{ALLOW_LIVE_MODELS:'1'},secrets:[]});
    const core=runtime();
    core.build={context:root,dockerfile:'deploy/Dockerfile'};core.command=['node','dist/apps/cli/file-secret-entrypoint.js','core'];
    const tokenFiles:Record<string,string>={ADMIN_TOKEN:'/run/secrets/'+admin};
    tokens.forEach((id,i)=>{tokenFiles[tokenNames[i]]='/run/secrets/'+id;});
    core.environment={...core.environment,APP_BIND:'0.0.0.0',PORT:'3000',PUBLIC_ORIGIN:data.publicOrigin,DB_PATH:'/data/conversation.sqlite',APP_CONFIG:'/config/app.json',RESTART_POLICY:'paused',APP_TOKEN_FILES:JSON.stringify(tokenFiles)};
    core.secrets=[admin,...tokens,...credentialSecrets.values()];
    // Core validates configured credential presence; it receives only model bindings named in this configuration.
    for(const [name,id] of credentialSecrets)core.environment[name+'_FILE']='/run/secrets/'+id;
    core.volumes=['session-data:/data',configPath+':/config/app.json:ro'];core.ports=[`127.0.0.1:${data.port}:3000`];
    core.healthcheck={test:['CMD','node','-e',"fetch('http://127.0.0.1:3000/healthz',{headers:{host:new URL(process.env.PUBLIC_ORIGIN).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'3s',timeout:'3s',retries:20};
    const services:Record<string,ComposeService>={core};
    data.workers.forEach((worker,i)=>{
      const service=runtime(),profile=data.profiles.find(p=>p.id===worker.profileId)!;
      service.command=['node','dist/apps/cli/file-secret-entrypoint.js','worker'];
      service.environment={...service.environment,CORE_URL:'http://core:3000',APP_TOKEN_FILES:JSON.stringify({WORKER_TOKEN:'/run/secrets/'+tokens[i]})};
      service.secrets=[tokens[i]];
      const key=profile.apiKeyEnv&&credentialSecrets.get(profile.apiKeyEnv);
      if(key){service.secrets.push(key);service.environment[profile.apiKeyEnv!+'_FILE']='/run/secrets/'+key;}
      service.depends_on={core:{condition:'service_healthy'}};services[worker.id]=service;
    });
    const composePath=join(target,'compose.json');
    writeFileSync(composePath,JSON.stringify({name:data.name,services,secrets,volumes:{'session-data':{}}},null,2),{flag:'wx',mode:0o600});
    return {composePath,configPath,sessionPath,adminTokenPath:secrets[admin].file,profiles:data.profiles.map(p=>({id:p.id,version:p.version})),workers:data.workers.length};
  } catch(error){rmSync(target,{recursive:true,force:true});throw error;}
}
