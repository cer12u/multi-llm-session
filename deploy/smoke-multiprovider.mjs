// Only synthetic, locally owned containers and credentials; no external model endpoint is used.
import { mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { generateDeployment } from '../dist/packages/config/deployment.js';
import { ReplayStream } from '../dist/packages/observability/replay.js';

const root=mkdtempSync(join(tmpdir(),'mls-compose-proof-')),reports=[];
function shell(args){
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(result.status!==0)throw new Error('SYNTHETIC_DOCKER_COMMAND_FAILED: '+args.slice(0,4).join(' '));
  return result.stdout;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  for(const scenario of ['shared','mixed']){
    const port=scenario==='shared'?31980:31981,name='mls-synthetic-'+scenario;
    const profiles=Array.from({length:scenario==='shared'?1:3},(_,i)=>({id:'profile-'+i,version:i+3,provider:i===0?'ollama':'openai',model:'synthetic-model-'+i,
      baseUrl:`http://127.0.0.1:${3101+i}/${i===0?'api':'v1'}`,allowLocalHttp:true,apiKeyEnv:'SYNTHETIC_MODEL_'+i,jsonMode:i===1?'schema':i===0?'json':'none',maxConcurrent:3}));
    const characters=['alpha','beta','gamma'].map(id=>({schemaVersion:1,id,version:2,name:id,persona:'synthetic persona '+id,presentationRef:null}));
    const credentialFiles={};profiles.forEach((p,i)=>{const file=join(root,scenario+'-'+i+'.key');writeFileSync(file,'synthetic-only-model-credential-'+scenario+'-'+i+'-000000000000');credentialFiles[p.apiKeyEnv]=file;});
    const workers=characters.map((c,i)=>({id:'worker-'+i,characterId:c.id,profileId:profiles[scenario==='shared'?0:i].id}));
    const config={schemaVersion:1,allowLive:true,name,port,publicOrigin:'http://127.0.0.1:'+port,profiles,characters,workers,credentialFiles,
      sessionDefaults:{selfWakeEnabled:false,idleMs:60000,memoryEvery:3,memoryFlushMs:60000,maxCalls:24,maxMessages:12,maxDurationMs:90000,debounceMs:0,directedDebounceMs:0,maxCoalesceMs:0}};
    const generated=generateDeployment(config,join(root,scenario),resolve('.'));
    const compose=JSON.parse(readFileSync(generated.composePath,'utf8'));
    for(const [i,w] of workers.entries()){
      const service=compose.services[w.id];assert.equal(service.volumes,undefined);
      service.command=['node','dist/apps/cli/synthetic-provider-worker.js'];
      Object.assign(service.environment,{SYNTHETIC_DEPLOYMENT_TEST:'1',SYNTHETIC_PROFILE:JSON.stringify(profiles[scenario==='shared'?0:i]),SYNTHETIC_CHARACTER:w.characterId});
      service.restart='no';
    }
    compose.services.core.restart='no';writeFileSync(generated.composePath,JSON.stringify(compose,null,2));
    const args=['compose','-f',generated.composePath];
    const admin=readFileSync(generated.adminTokenPath,'utf8').trim(),base=config.publicOrigin;
    const api=async(path,body,token=admin)=>{
      const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
      assert.equal(response.ok,true,'synthetic Core API '+path+' status '+response.status);return response.json();
    };
    // Inspection is an administrator grant. An idle/paused Worker is not allowed to read saved private Agents.
    async function privateMemories(id,agents){
      const response=await fetch(base+`/v1/sessions/${id}/diagnostic-export`,{headers:{authorization:'Bearer '+admin},signal:AbortSignal.timeout(5000)});
      assert.equal(response.ok,true,'private synthetic audit');
      const replay=new ReplayStream();for(const line of (await response.text()).split('\n').filter(Boolean))replay.push(line);
      const rows=replay.finish().state.find(table=>table.table==='memories').rows;
      return agents.map(agent=>rows.filter(row=>row.agent_id===agent.id).sort((a,b)=>a.id.localeCompare(b.id)));
    }
    async function until(check,label){for(let i=0;i<180;i++){try{const value=await check();if(value)return value;}catch{}await sleep(250);}throw new Error('SYNTHETIC_WAIT_FAILED: '+label);}
    try{
      shell([...args,'config','--quiet']);shell([...args,'up','-d','--no-build']);
      await until(async()=>{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(2000)});return r.ok;},'health');
      const id=(await api('/v1/sessions',JSON.parse(readFileSync(generated.sessionPath,'utf8')))).id;
      for(let i=0;i<3;i++)await api(`/v1/sessions/${id}/messages`,{text:'synthetic input '+i});
      await api(`/v1/sessions/${id}/start`,{});
      const memories=await until(async()=>{
        const snapshot=await api(`/v1/sessions/${id}/snapshot`),notes=await privateMemories(id,snapshot.agents);
        return notes.every(n=>n.length===1)?notes:null;
      },'three independent memory results');
      await api(`/v1/sessions/${id}/pause`,{});
      const proofs=workers.map(w=>JSON.parse(shell([...args,'exec','-T',w.id,'node','-e',"console.log(require('fs').readFileSync('/tmp/provider-proof.json','utf8'))"])));
      assert.equal(new Set(proofs.map(p=>p.agentId)).size,3);
      for(const [i,proof] of proofs.entries()){
        assert.ok(proof.uid>0);assert.equal(proof.authenticationMatched,true);assert.equal(proof.personaMatched,true);
        assert.equal(proof.characterId,characters[i].id);assert.equal(proof.profileVersion,profiles[scenario==='shared'?0:i].version);assert.ok(proof.calls>=2);
      }
      let faultScope=null;
      if(scenario==='mixed'){
        shell([...args,'exec','-T','worker-2','node','-e',"fetch('http://127.0.0.1:3103/synthetic-fault',{method:'POST'}).then(r=>process.exit(r.ok?0:1))"]);
        await api(`/v1/sessions/${id}/resume`,{});await api(`/v1/sessions/${id}/messages`,{text:'synthetic recovery observation'});
        faultScope=await until(async()=>{const reports=await api('/v1/model-profiles');return reports.find(p=>p.profile.id==='profile-2'&&p.health.state==='OPEN')?.health??null;},'persisted 429 circuit');
        await api(`/v1/sessions/${id}/pause`,{});
      }
      const before=await api(`/v1/sessions/${id}/snapshot`);
      shell([...args,'up','-d','--no-build','--no-deps','--force-recreate','core']);
      await until(async()=>{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(2000)});return r.ok;},'recreated Core');
      const after=await api(`/v1/sessions/${id}/snapshot`);
      assert.equal(after.session.lifecycle,'PAUSED');assert.equal(after.session.calls,before.session.calls);
      assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.agents.map(a=>a.id),before.agents.map(a=>a.id));
      assert.deepEqual(await privateMemories(id,after.agents),memories);
      if(faultScope){const health=(await api('/v1/model-profiles')).find(p=>p.profile.id==='profile-2').health;assert.equal(health.scope,faultScope.scope);assert.equal(health.failures,faultScope.failures);assert.equal(health.lastError,'RATE_LIMIT');}
      const scopes=(await api('/v1/model-profiles')).map(p=>p.health.scope);assert.equal(new Set(scopes).size,profiles.length);
      reports.push({scenario,workers:3,nonRoot:true,authenticatedRoutes:true,pinnedVersions:true,distinctAgents:3,modelScopes:profiles.length,originalsRetained:after.messages.length,privateMemoriesRetained:3,circuitRetained:!!faultScope,coreRecreated:true,mode:'synthetic-loopback-only'});
    }finally{shell([...args,'down','--volumes','--remove-orphans','--timeout','5']);}
  }
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/multiprovider-compose.json',JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports));
}finally{rmSync(root,{recursive:true,force:true});}
