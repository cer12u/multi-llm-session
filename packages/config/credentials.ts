import { readFileSync } from 'node:fs';
import { ensure, type ModelProfile } from '../contracts/index.js';

/** Docker/Kubernetes secret files or process env. Never expose either value through the public API. */
export function credential(profile:ModelProfile,env:NodeJS.ProcessEnv=process.env):string|undefined {
  if(!profile.apiKeyEnv) return undefined;
  const direct=env[profile.apiKeyEnv],file=env[profile.apiKeyEnv+'_FILE'];
  ensure(!(direct&&file),500,'AMBIGUOUS_MODEL_CREDENTIAL');
  if(direct) return direct;
  if(!file) return undefined;
  let value:string;
  try {value=readFileSync(file,'utf8').trim();} catch {throw new Error('MODEL_CREDENTIAL_FILE_UNREADABLE');}
  ensure(value.length>0&&value.length<16384,500,'INVALID_MODEL_CREDENTIAL');
  return value;
}
export function validateProfileUrl(profile:ModelProfile):void {
  if(profile.provider==='mock') return;
  ensure(profile.baseUrl,422,'MISSING_MODEL_URL');
  const url=new URL(profile.baseUrl);
  ensure(!url.username&&!url.password&&!url.search&&!url.hash,422,'UNSAFE_MODEL_URL');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  ensure(url.protocol==='https:'||(profile.allowLocalHttp&&local&&url.protocol==='http:'),422,'MODEL_HTTPS_REQUIRED');
}
