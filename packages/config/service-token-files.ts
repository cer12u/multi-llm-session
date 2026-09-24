import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Bindings=z.record(z.string().regex(/^(?:ADMIN_TOKEN|VIEWER_TOKEN|WORKER_TOKEN|WORKER_[A-Z0-9_]+_TOKEN)$/),z.string().min(1));
/** Trusted process configuration. Return values to the launching process only; never log/serialize them. */
export function readServiceTokenFiles(env:NodeJS.ProcessEnv=process.env):Record<string,string>{
  if(env.ALLOW_LIVE_MODELS!=='1')throw new Error('LIVE_OPT_IN_REQUIRED');
  let bindings:Record<string,string>;
  try{bindings=Bindings.parse(JSON.parse(env.APP_TOKEN_FILES??'{}'));}catch{throw new Error('INVALID_SERVICE_TOKEN_BINDINGS');}
  const result:Record<string,string>={};
  for(const [name,path] of Object.entries(bindings)){
    if(env[name])throw new Error('AMBIGUOUS_SERVICE_TOKEN');
    let value:string;try{value=readFileSync(path,'utf8').trim();}catch{throw new Error('SERVICE_TOKEN_FILE_UNREADABLE');}
    if(value.length<24||value.length>=16384)throw new Error('INVALID_SERVICE_TOKEN');
    result[name]=value;
  }
  return result;
}
