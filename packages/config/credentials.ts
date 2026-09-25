import {openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import { ensure, type ModelProfile } from '../contracts/index.js';

const limit=16384;
const reserved=/^(?:ADMIN_TOKEN|VIEWER_TOKEN|WORKER_.*|NODE_.*|PATH|HOME|LD_.*|APP_.*|CORE_URL|ALLOW_.*|DB_PATH|PUBLIC_ORIGIN|PORT|RESTART_POLICY|GITHUB_.*|ACTIONS_.*)$/;
/** Profiles may name only dedicated model bindings, never RPC credentials or a _FILE path binding itself. */
export function validateCredentialReference(name:string|undefined):void {
  if(name===undefined)return;
  ensure(/^[A-Z][A-Z0-9_]{0,127}$/.test(name),422,'INVALID_CREDENTIAL_NAME');
  ensure(!reserved.test(name)&&!name.endsWith('_FILE'),422,'RESERVED_CREDENTIAL_NAME');
}
function checked(value:string):string{
  const token=value.trim();
  ensure(token.length>0&&Buffer.byteLength(value,'utf8')<limit&&!/[\u0000-\u001f\u007f]/.test(token),500,'INVALID_MODEL_CREDENTIAL');
  return token;
}
/** Deployment-supplied paths are trusted bindings; opening a profile never accepts a raw path from model output.
 * Follow projected Kubernetes/Docker secret symlinks, then validate and bound the opened descriptor itself.
 */
export function credential(profile:ModelProfile,env:NodeJS.ProcessEnv=process.env):string|undefined {
  validateCredentialReference(profile.apiKeyEnv);
  if(!profile.apiKeyEnv)return undefined;
  const direct=env[profile.apiKeyEnv],file=env[profile.apiKeyEnv+'_FILE'];
  ensure(!(direct!==undefined&&file!==undefined),500,'AMBIGUOUS_MODEL_CREDENTIAL');
  if(direct!==undefined)return checked(direct);
  if(file===undefined)return undefined;
  let fd:number;
  try{fd=openSync(file,constants.O_RDONLY|constants.O_NONBLOCK);}catch{throw new Error('MODEL_CREDENTIAL_FILE_UNREADABLE');}
  try{
    const info=fstatSync(fd);ensure(info.isFile()&&info.size<limit,500,'INVALID_MODEL_CREDENTIAL');
    const buffer=Buffer.alloc(limit);let length=0;
    for(;;){const read=readSync(fd,buffer,length,buffer.length-length,null);if(!read)break;length+=read;
      ensure(length<limit,500,'INVALID_MODEL_CREDENTIAL');}
    let value:string;try{value=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));}
    catch{throw new Error('MODEL_CREDENTIAL_FILE_UNREADABLE');}
    return checked(value);
  }finally{closeSync(fd);}
}
export function validateProfileUrl(profile:ModelProfile):void {
  validateCredentialReference(profile.apiKeyEnv);
  if(profile.provider==='mock')return;
  ensure(profile.baseUrl,422,'MISSING_MODEL_URL');
  const url=new URL(profile.baseUrl);
  ensure(!url.username&&!url.password&&!url.search&&!url.hash,422,'UNSAFE_MODEL_URL');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  ensure(url.protocol==='https:'||(profile.allowLocalHttp&&local&&url.protocol==='http:'),422,'MODEL_HTTPS_REQUIRED');
}
