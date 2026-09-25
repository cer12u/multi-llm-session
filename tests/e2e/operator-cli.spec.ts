import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const admin='e2e-test-operator-only-not-a-production-secret',viewer='e2e-viewer-read-only-not-a-production-secret';
// Real CLI processes call the shared running Core. No service fixture or direct DB writes.
test('R10-DELIVERY-E2E: documented character, archive and paging CLI commands use the application and preserve read-only access',async()=>{
  const root=mkdtempSync(join(tmpdir(),'operator-cli-e2e-'));
  const invoke=(args:string[],token=admin)=>new Promise<{status:number;out:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['dist/apps/cli/command.js',...args],{env:{...process.env,CORE_URL:'http://127.0.0.1:4173',ADMIN_TOKEN:token},stdio:['ignore','pipe','pipe']});let out='';
    child.stdout.on('data',data=>{out+=data;});child.stderr.resume();const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({status:code??1,out});});
  });
  const call=async(args:string[],token=admin)=>{const value=await invoke(args,token);expect(value.status,value.out).toBe(0);return JSON.parse(value.out);};
  try{
    const characters=await call(['characters']),character={...characters[0],id:'zz-cli-'+crypto.randomUUID(),version:1,persona:'SYNTHETIC_CLI_PRIVATE_PERSONA'};
    const file=join(root,'character.json');writeFileSync(file,JSON.stringify(character));
    expect((await call(['character-validate',file])).character).toEqual(character);
    expect((await invoke(['character-import',file],viewer)).status).not.toBe(0);
    expect((await call(['character-import',file])).character).toEqual(character);
    expect((await call(['character-versions',character.id]))[0].version).toBe(1);
    expect((await call(['character-get',character.id,'1'])).character).toEqual(character);
    expect(await call(['character-export',character.id,'1'])).toEqual(character);
    const input=join(root,'session.json');writeFileSync(input,JSON.stringify({title:'CLI delivery',participants:['a','b','c'].map((slot,i)=>({slot:'worker-'+slot,characterId:i?characters[i].id:character.id,profileId:'mock'}))}));
    const {id}=await call(['create',input]);
    const message=await call(['say',id,'CLI_ORIGINAL_MARKER']);
    expect((await call(['original',id,message.id])).text).toBe('CLI_ORIGINAL_MARKER');
    expect((await call(['history',id])).items.map((m:{id:string})=>m.id)).toEqual([message.id]);
    expect((await call(['thread',id,message.id])).rootId).toBe(message.id);
    expect((await call(['search-page',id,'CLI_ORIGINAL_MARKER'])).items.map((m:{id:string})=>m.id)).toEqual([message.id]);
    expect((await call(['usage',id])).calls).toEqual([]);
    const read=await invoke(['history',id],viewer);expect(read.status).toBe(0);expect(read.out).not.toContain(character.persona);
    expect((await invoke(['character-export',character.id,'1'],viewer)).status).not.toBe(0);
    await call(['end',id]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
