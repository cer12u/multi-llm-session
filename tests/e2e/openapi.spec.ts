import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const admin='e2e-test-operator-only-not-a-production-secret',viewer='e2e-viewer-read-only-not-a-production-secret';
const headers={authorization:'Bearer '+admin};
// Product CLI + running Core + SQLite, not Service/DB fixtures or simulated routes.
test('R10-OPENAPI-E2E: registered APIs, defaults, authentication and CLI exports match actual application operations',async({request})=>{
  const root=mkdtempSync(join(tmpdir(),'openapi-e2e-'));let sessionId:string|undefined;
  const cli=(args:string[])=>new Promise<{code:number;out:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env:{...process.env,CORE_URL:'http://127.0.0.1:4173',ADMIN_TOKEN:admin},stdio:['ignore','pipe','pipe']});let out='';
    child.stdout.on('data',data=>{out+=data;});child.stderr.resume();const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve({code:code??1,out});});
  });
  try{
    expect((await request.get('/v1/openapi.json')).status()).toBe(401);
    expect((await request.get('/v1/openapi.json',{headers:{authorization:'Bearer '+viewer}})).status()).toBe(403);
    expect((await request.get('/v1/openapi.json',{headers:{...headers,origin:'https://wrong.invalid'}})).status()).toBe(403);
    const response=await request.get('/v1/openapi.json',{headers});expect(response.status()).toBe(200);
    const doc=await response.json();expect(doc.openapi).toBe('3.1.1');
    const methods=['get','post','put','patch','delete','options','head','trace'];
    const documented=Object.entries(doc.paths).flatMap(([path,item])=>Object.keys(item as object).filter(m=>methods.includes(m)).map(m=>m.toUpperCase()+' '+path));
    const actual=doc['x-coverage'].registeredRoutes.filter((r:string)=>!doc['x-coverage'].excluded.includes(r)).map((r:string)=>r.replace(/:([A-Za-z][A-Za-z0-9]*)/g,'{$1}'));
    expect(documented.sort()).toEqual(actual.sort());expect(new Set(documented).size).toBe(doc['x-coverage'].explicitApiOperations);
    const refs=(node:unknown):void=>{if(!node||typeof node!=='object')return;for(const [key,value] of Object.entries(node)){
      if(key==='$ref'){expect(String(value)).toMatch(/^#\/components\//);let target:any=doc;for(const part of String(value).slice(2).split('/'))target=target?.[part.replaceAll('~1','/').replaceAll('~0','~')];expect(target,'unresolved '+value).toBeDefined();}
      else refs(value);
    }};refs(doc);
    expect(doc.components.schemas.sessionCreateRequest.required).not.toContain('settings');
    expect(doc.components.schemas.profileRequest.required).not.toContain('maxOutputTokens');
    expect(doc.components.schemas.characterRequest.required).not.toContain('presentationRef');
    expect(doc.paths['/v1/sessions/{id}/messages/lookup'].post['x-required-role']).toBe('reader');
    expect(doc.paths['/v1/sessions/{id}/events'].get.responses['200'].content['text/event-stream']).toBeDefined();
    expect(doc.paths['/v1/sessions/{id}/diagnostic-export'].get.responses['200'].content['application/x-ndjson']).toBeDefined();
    expect(doc.paths['/v1/worker/runs/{id}/result'].post['x-run-output-schemas'].memory).toBeDefined();
    const downloaded=await cli(['dist/apps/cli/command.js','openapi']);expect(downloaded.code).toBe(0);expect(JSON.parse(downloaded.out)).toEqual(doc);
    const generated=await cli(['dist/apps/cli/schema.js',root,'--check']);expect(generated.code).toBe(0);expect(JSON.parse(readFileSync(join(root,'openapi.json'),'utf8'))).toEqual(doc);
    const caps=await(await request.get('/v1/capabilities',{headers})).json(),characters=await(await request.get('/v1/characters',{headers})).json();
    // Deliberately omit defaulted settings: the request contract must not require output defaults.
    const created=await request.post('/v1/sessions',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{title:'OpenAPI client workflow',participants:caps.slots.slice(0,3).map((slot:string,i:number)=>({slot,characterId:characters[i].id,profileId:'mock'}))}});
    expect(created.status()).toBe(200);sessionId=(await created.json()).id;
    const rootPath='/v1/sessions/'+sessionId,key=crypto.randomUUID(),data={text:'OPENAPI_APPLICATION_ORIGINAL'};
    const posted=await request.post(rootPath+'/messages',{headers:{...headers,'idempotency-key':key},data});expect(posted.status()).toBe(200);const message=await posted.json();
    const replay=await request.post(rootPath+'/messages',{headers:{...headers,'idempotency-key':key},data});expect(await replay.json()).toEqual(message);
    const read=await request.post(rootPath+'/messages/lookup',{headers:{authorization:'Bearer '+viewer},data:{ids:[message.id]}});expect(read.status()).toBe(200);expect((await read.json())[0].text).toBe(data.text);
    expect((await request.post(rootPath+'/messages',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{...data,notAField:true}})).status()).toBe(422);
    const valid=await request.post('/v1/characters/validate',{headers,data:{schemaVersion:1,id:'api-check',version:1,name:'Synthetic',persona:'OPENAPI_PRIVATE_CANARY'}});expect(valid.status()).toBe(200);expect((await valid.json()).character.presentationRef).toBeNull();
    const reread=await request.get('/v1/openapi.json',{headers});expect(await reread.json()).toEqual(doc);expect(await reread.text()).not.toContain('OPENAPI_PRIVATE_CANARY');
    expect((await(await request.get(rootPath+'/usage',{headers})).json()).calls).toEqual([]);
    mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/openapi-e2e.json',JSON.stringify({mode:'actual-cli-http-sqlite',apiOperations:documented.length,allRegistered:true,refsResolved:true,inputDefaultsPreserved:true,operatorOnly:true,readonlyPostWorks:true,cliMatchesHttp:true,inferenceFromReads:0}));
  }finally{if(sessionId)await request.post('/v1/sessions/'+sessionId+'/end',{headers:{...headers,'idempotency-key':crypto.randomUUID()},data:{}});rmSync(root,{recursive:true,force:true});}
});
