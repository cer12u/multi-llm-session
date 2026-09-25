import {createReadStream,existsSync,linkSync,openSync,closeSync,writeFileSync,unlinkSync,fsyncSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Id} from '../../packages/contracts/index.js';
import {ReplayStream,MAX_DIAGNOSTIC_BYTES} from '../../packages/observability/replay.js';

export async function replayFile(path:string){
  const replay=new ReplayStream(),source=createReadStream(path),decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='',bytes=0;
  try{
    for await(const chunk of source){bytes+=chunk.length;if(bytes>MAX_DIAGNOSTIC_BYTES)throw new Error('REPLAY_SIZE_LIMIT');
      buffer+=decoder.decode(chunk,{stream:true});let index:number;
      while((index=buffer.indexOf('\n'))>=0){replay.push(buffer.slice(0,index));buffer=buffer.slice(index+1);}
      if(Buffer.byteLength(buffer)>2097152)throw new Error('REPLAY_LINE_LIMIT');
    }
    buffer+=decoder.decode();if(buffer)replay.push(buffer);return replay.finish();
  }finally{source.destroy();}
}
function destination(file:string){const path=resolve(file);if(existsSync(path))throw new Error('DIAGNOSTIC_DESTINATION_EXISTS');return path;}
function publish(temporary:string,target:string){const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}linkSync(temporary,target);unlinkSync(temporary);}

/** Raw private bytes are opt-in file artifacts, never dumped into ordinary CLI status/log output. */
export async function diagnosticCommand(args:string[],env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch):Promise<{kind:string;records:number}|null>{
  const [action,id,file]=args;if(!['diagnostic-export','replay'].includes(action))return null;
  if(args.length!==3)throw new Error('Usage: diagnostic-export SESSION FILE.ndjson | replay PRIVATE_INPUT.ndjson PRIVATE_OUTPUT.json');
  const target=destination(file),temporary=target+'.partial-'+randomUUID();
  try{
    if(action==='replay'){
      const result=await replayFile(id);
      writeFileSync(temporary,JSON.stringify({kind:'private-replayed-projection',formatVersion:1,...result}),{flag:'wx',mode:0o600});
      publish(temporary,target);return {kind:'private-replayed-projection',records:result.records};
    }
    Id.parse(id);if(!env.ADMIN_TOKEN)throw new Error('ADMIN_TOKEN_REQUIRED');
    const response=await fetcher(new URL(`/v1/sessions/${id}/diagnostic-export`,env.CORE_URL??'http://127.0.0.1:3000'),{
      headers:{authorization:'Bearer '+env.ADMIN_TOKEN},redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error('DIAGNOSTIC_EXPORT_FAILED');}
    const fd=openSync(temporary,'wx',0o600),reader=response.body.getReader();let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;
      if(bytes>MAX_DIAGNOSTIC_BYTES)throw new Error('DIAGNOSTIC_SIZE_LIMIT');writeFileSync(fd,value);}
      fsyncSync(fd);
    }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{closeSync(fd);}
    const result=await replayFile(temporary);publish(temporary,target);return {kind:'private-session-diagnostic',records:result.records};
  }finally{if(existsSync(temporary))unlinkSync(temporary);}
}
