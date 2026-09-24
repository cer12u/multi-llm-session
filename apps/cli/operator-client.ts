import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Id, Slug } from '../../packages/contracts/index.js';

/** CLI and Web use the same application endpoints. Never write directly to SQLite or invoke a model here. */
export async function operatorCommand(args:string[],env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch):Promise<{ok:boolean;body:string}>{
  const [action,id,arg]=args,base=env.CORE_URL??'http://127.0.0.1:3000',token=env.ADMIN_TOKEN;
  if(!token)throw new Error('ADMIN_TOKEN is required');
  const session=()=>encodeURIComponent(Id.parse(id)),profile=()=>encodeURIComponent(Slug.parse(id));
  let path:string,method='GET',body:unknown;
  switch(action){
    case 'list':path='/v1/sessions';break;
    case 'profiles':path='/v1/provider-catalog';break;
    case 'profile-versions':path=`/v1/model-profiles/${profile()}/versions`;break;
    case 'profile-save':path='/v1/model-profiles';method='POST';body=JSON.parse(readFileSync(id,'utf8'));break;
    case 'create':path='/v1/sessions';method='POST';body=JSON.parse(readFileSync(id,'utf8'));break;
    case 'status':path=`/v1/sessions/${session()}/diagnostics`;break;
    case 'operations':path=`/v1/sessions/${session()}/operations`;break;
    case 'export':path=`/v1/sessions/${session()}/export`;break;
    case 'start':case 'pause':case 'resume':case 'end':case 'budget':path=`/v1/sessions/${session()}/${action}`;method='POST';body={};break;
    case 'retry-agent':path=`/v1/sessions/${session()}/agents/${encodeURIComponent(Id.parse(arg))}/retry`;method='POST';body={};break;
    case 'retry-provider':{
      if(!/^[1-9][0-9]*$/.test(arg??'')||!Number.isSafeInteger(Number(arg)))throw new Error('Positive profile VERSION is required');
      path=`/v1/model-profiles/${profile()}/versions/${arg}/retry`;method='POST';body={};break;
    }
    case 'say':path=`/v1/sessions/${session()}/messages`;method='POST';body={text:arg};break;
    case 'source':path=`/v1/sessions/${session()}/sources`;method='POST';body=JSON.parse(readFileSync(arg,'utf8'));break;
    case 'search':path=`/v1/sessions/${session()}/search?q=${encodeURIComponent(arg)}`;break;
    default:throw new Error('Usage: list | create FILE | profiles | profile-versions PROFILE | profile-save FILE | operations/status/start/pause/resume/end/export/budget SESSION | retry-agent SESSION AGENT | retry-provider PROFILE VERSION | say/search SESSION TEXT | source SESSION FILE');
  }
  const response=await fetcher(new URL(path,base),{method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':env.IDEMPOTENCY_KEY??randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {ok:response.ok,body:await response.text()};
}
