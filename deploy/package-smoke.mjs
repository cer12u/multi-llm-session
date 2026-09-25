// E2E: load the packaged image and launch the archived source's Compose in an isolated project.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createReadStream,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

const [bundleArg,reportArg]=process.argv.slice(2);assert(bundleArg&&reportArg,'PACKAGE_SMOKE_ARGUMENTS_REQUIRED');
const bundle=resolve(bundleArg),report=resolve(reportArg),root=mkdtempSync(join(tmpdir(),'mls-package-install-')),source=join(root,'source');mkdirSync(source);
const digest=async file=>{const h=createHash('sha256');for await(const data of createReadStream(file))h.update(data);return h.digest('hex');};
const run=(exe,args,cwd=source,input)=>{const r=spawnSync(exe,args,{cwd,input,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});assert.equal(r.status,0,'PACKAGE_INSTALL_COMMAND_FAILED_'+exe);return r.stdout;};
let compose,manifest,outcome='FAILED',failure=null,posts=0,restored=false,auth=null;
try{
  manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));
  assert.equal(manifest.formatVersion,1);assert(/^[a-f0-9]{40}$/.test(manifest.sourceSha));assert.equal(manifest.image.tag,'multi-llm-session:bundle-'+manifest.sourceSha);
  for(const file of ['source.tar.gz','image.tar.gz'])assert.equal(await digest(join(bundle,file)),manifest.files[file],'PACKAGE_CHECKSUM_MISMATCH');
  run('docker',['image','load','-i',join(bundle,'image.tar.gz')]);
  const loaded=JSON.parse(run('docker',['image','inspect',manifest.image.tag]))[0];assert.equal(loaded.Id,manifest.image.id);assert.equal(loaded.Config.User,'node');
  run('tar',['-xzf',join(bundle,'source.tar.gz'),'-C',source,'--no-same-owner']);
  assert.equal(await digest(join(source,'package-lock.json')),manifest.lockfileSha256);
  run(process.execPath,['deploy/init-env.mjs']);
  const environment=Object.fromEntries(readFileSync(join(source,'.env'),'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));auth=environment.ADMIN_TOKEN;
  const override=join(root,'override.json');
  const configure=path=>writeFileSync(override,JSON.stringify({services:Object.fromEntries(['core','agent-a','agent-b','agent-c'].map(name=>[name,{image:manifest.image.tag,...name==='core'?{environment:{DB_PATH:path,RESTART_POLICY:'paused'}}:{}}]))}));
  configure('/data/conversation.sqlite');
  const args=['compose','--env-file',join(source,'.env'),'-p','mls-package-'+randomUUID().slice(0,8),'-f',join(source,'deploy/compose.yaml'),'-f',override];
  compose=(...command)=>run('docker',[...args,...command]);
  const api=async(path,body)=>{const r=await fetch('http://127.0.0.1:3000'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});assert(r.ok,'PACKAGE_INSTALL_API_'+r.status);return r.json();};
  const boot=async()=>{
    compose('up','-d','--no-build');const until=Date.now()+60000;
    while(Date.now()<until){try{await api('/v1/capabilities');return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('PACKAGE_INSTALL_START_TIMEOUT');
  };
  await boot();
  const html=await fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(10000)});assert.equal(html.status,200);assert((await html.text()).includes('<html'));
  // Run the existing authenticated container workflow, not direct Service/SQLite fixtures.
  run('docker',[...args,'exec','-T','core','node','--input-type=module'],source,readFileSync(join(source,'deploy/smoke.mjs')));
  const sessions=await api('/v1/sessions');assert.equal(sessions.length,1);const id=sessions[0].id;
  const before=await api(`/v1/sessions/${id}/transcript`),fingerprint=await api(`/v1/sessions/${id}/continuity-fingerprint`);posts=before.transcript.length;
  assert(posts>0);assert.equal(fingerprint.tables.length,9);
  const storage=(...a)=>JSON.parse(compose('exec','-T','core','node','dist/apps/cli/storage.js',...a));
  const saved=storage('backup','/data/conversation.sqlite','/data/packaged-backup.sqlite');assert.equal(saved.integrity,'ok');
  const copy=storage('restore','/data/packaged-backup.sqlite','/data/packaged-restored.sqlite');assert.equal(copy.schemaVersion,saved.schemaVersion);
  compose('down');configure('/data/packaged-restored.sqlite');await boot();
  assert.deepEqual((await api(`/v1/sessions/${id}/transcript`)).transcript,before.transcript,'PACKAGE_RESTORE_TRANSCRIPT');
  assert.deepEqual((await api(`/v1/sessions/${id}/continuity-fingerprint`)).tables,fingerprint.tables,'PACKAGE_RESTORE_PRIVATE_CONTINUITY');
  assert.equal((await api(`/v1/sessions/${id}/snapshot`)).session.lifecycle,'PAUSED');
  assert.equal(storage('inspect','/data/packaged-restored.sqlite').integrity,'ok');
  await api(`/v1/sessions/${id}/end`,{});restored=true;outcome='PASSED';
}catch(error){failure=error instanceof Error&&/^PACKAGE_[A-Z_0-9]+$/.test(error.message)?error.message:'PACKAGE_INSTALL_ASSERTION_FAILED';process.exitCode=1;}
finally{
  try{compose?.('down','--volumes');}finally{rmSync(root,{recursive:true,force:true});}
  mkdirSync(resolve(report,'..'),{recursive:true});writeFileSync(report,JSON.stringify({mode:'packaged-application-e2e',outcome,failure,sourceSha:manifest?.sourceSha,imageId:manifest?.image?.id,archivedSourceUsed:true,loadedImageUsed:true,originals:posts,backupRestored:restored,liveModelCalls:0,publishedToRegistry:false},null,2));
  console.log(JSON.stringify({outcome,posts,backupRestored:restored,liveModelCalls:0}));
}
