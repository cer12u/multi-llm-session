import {z} from 'zod';
import {execFileSync} from 'node:child_process';
import {ModelProfileSchema,CharacterSchema,SettingsSchema,Text,Slug} from '../contracts/index.js';
import {credential,validateProfileUrl} from './credentials.js';
import {hash} from '../domain/index.js';

/** Operator-authored execution manifest. It is never accepted from model output or an automatic browser read. */
export const ExperimentSchema=z.object({
  schemaVersion:z.literal(1),approvedCommit:z.string().regex(/^[a-f0-9]{40}$/),
  evidenceMode:z.enum(['live','synthetic']),purpose:z.enum(['smoke','conversation']),scenario:Slug,
  initialText:Text,profiles:z.array(ModelProfileSchema).min(1).max(16),characters:z.array(CharacterSchema).min(3).max(16),
  participants:z.array(z.object({slot:z.string().regex(/^worker-[a-z0-9-]{1,24}$/),characterId:Slug,profileId:Slug}).strict()).min(3).max(16),
  bounds:z.object({maxCalls:z.number().int().min(1).max(10000),maxPosts:z.number().int().min(1).max(1000),durationMs:z.number().int().min(1000).max(21600000),maxOutputTokens:z.number().int().min(128).max(4096),maxTokens:z.number().int().min(1).max(1000000000)}).strict(),
  settings:z.record(z.string(),z.unknown()).default({}),quietStopMs:z.number().int().min(1000).max(300000).nullable().default(null),
}).strict();
export type Experiment=z.infer<typeof ExperimentSchema>;
export function experimentPreflight(input:unknown,env:NodeJS.ProcessEnv=process.env){
  const manifest=ExperimentSchema.parse(input),blockers:string[]=[];
  if(!import.meta.url.endsWith('.ts'))blockers.push('RUN_PINNED_SOURCE_WITH_TSX');
  let commit:string|null=null,repository:string|null=null;
  try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();repository=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    execFileSync('git',['diff','--quiet','HEAD','--','apps','packages','deploy','package.json','package-lock.json','tsconfig.json'],{stdio:'ignore'});
    if(execFileSync('git',['ls-files','--others','--exclude-standard','--','apps','packages','deploy'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim())blockers.push('UNTRACKED_EXECUTABLE_SOURCE');
  }catch{blockers.push('BUILD_NOT_A_CLEAN_CHECKOUT');}
  if(commit!==manifest.approvedCommit)blockers.push('APPROVED_COMMIT_MISMATCH');
  if(manifest.evidenceMode==='live'&&env.ALLOW_LIVE_MODELS!=='1')blockers.push('LIVE_EXECUTION_NOT_ENABLED');
  const unique=(values:string[])=>new Set(values).size===values.length;
  if(!unique(manifest.profiles.map(p=>p.id))||!unique(manifest.characters.map(c=>c.id))||!unique(manifest.participants.map(p=>p.slot)))blockers.push('DUPLICATE_DEFINITION');
  for(const participant of manifest.participants)if(!manifest.profiles.some(p=>p.id===participant.profileId)||!manifest.characters.some(c=>c.id===participant.characterId))blockers.push('UNRESOLVED_PARTICIPANT');
  for(const profile of manifest.profiles){
    if(!manifest.participants.some(p=>p.profileId===profile.id))blockers.push('UNUSED_PROFILE');
    if(profile.provider==='mock')blockers.push('HTTP_PROFILE_REQUIRED');
    if(profile.maxOutputTokens>manifest.bounds.maxOutputTokens)blockers.push('OUTPUT_BOUND_EXCEEDED');
    try{validateProfileUrl(profile);if(manifest.evidenceMode==='synthetic'&&!['127.0.0.1','localhost','[::1]'].includes(new URL(profile.baseUrl!).hostname))blockers.push('SYNTHETIC_ENDPOINT_NOT_LOOPBACK');}
    catch{blockers.push('INVALID_PROFILE_ENDPOINT');}
    try{if(profile.authRequired&&!credential(profile,env))blockers.push('MISSING_MODEL_CREDENTIAL');}catch{blockers.push('INVALID_MODEL_CREDENTIAL');}
  }
  const settings=SettingsSchema.parse({...manifest.settings,...manifest.purpose==='smoke'?{selfWakeEnabled:false}:{},
    maxCalls:manifest.bounds.maxCalls,maxMessages:manifest.bounds.maxPosts,maxDurationMs:manifest.bounds.durationMs,
    operationalBudget:{mode:'experiment',windowMs:manifest.bounds.durationMs,autoRenew:false,maxTokens:manifest.bounds.maxTokens,scopeMaxCalls:null,scopeMaxTokens:null}});
  if(manifest.quietStopMs!==null&&manifest.purpose==='conversation'&&settings.selfWakeEnabled)blockers.push('QUIET_EXIT_WOULD_PREEMPT_AUTONOMY');
  return {manifest,settings,repository,report:{status:blockers.length?'BLOCKED':'READY',blockers:[...new Set(blockers)],commit,approvedCommit:manifest.approvedCommit,
    configHash:hash({manifest,settings}),scenario:manifest.scenario,purpose:manifest.purpose,evidenceMode:manifest.evidenceMode,
    participants:manifest.participants.length,bounds:manifest.bounds,selfWakeEnabled:settings.selfWakeEnabled,networkCalls:0,
    sourceExecution:import.meta.url.endsWith('.ts'),compiledArtifactVerified:false,billingGuarantee:false,warning:'Provider-side spending limits are required for a monetary cap. Synthetic transport is not live-model quality evidence.'}};
}
