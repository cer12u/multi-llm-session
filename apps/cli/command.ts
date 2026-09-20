import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [action,id,arg]=process.argv.slice(2),base=process.env.CORE_URL??'http://127.0.0.1:3000',token=process.env.ADMIN_TOKEN;
if(!token)throw new Error('ADMIN_TOKEN is required');
let path:string,method='GET',body:unknown;
switch(action){
  case 'list':path='/v1/sessions';break;
  case 'create':path='/v1/sessions';method='POST';body=JSON.parse(readFileSync(id,'utf8'));break;
  case 'status':path=`/v1/sessions/${id}/diagnostics`;break;
  case 'export':path=`/v1/sessions/${id}/export`;break;
  case 'start':case 'pause':case 'resume':case 'end':path=`/v1/sessions/${id}/${action}`;method='POST';body={};break;
  case 'say':path=`/v1/sessions/${id}/messages`;method='POST';body={text:arg};break;
  case 'source':path=`/v1/sessions/${id}/sources`;method='POST';body=JSON.parse(readFileSync(arg,'utf8'));break;
  case 'search':path=`/v1/sessions/${id}/search?q=${encodeURIComponent(arg)}`;break;
  default:throw new Error('Usage: command list | create file.json | status/start/pause/resume/end/export SESSION | say/search SESSION TEXT | source SESSION file.json');
}
const response=await fetch(new URL(path,base),{method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
const result=await response.text();console.log(result);if(!response.ok)process.exitCode=1;
