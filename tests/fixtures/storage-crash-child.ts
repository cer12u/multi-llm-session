// Synthetic subprocess fixture only. Its sole database and process are created/owned by the parent test.
import { fixture } from '../helpers.js';
import { Store } from '../../packages/storage-sqlite/index.js';
import { SessionService } from '../../packages/session-service/index.js';
import { buildServer } from '../../apps/core/server.js';
const [path,phase]=process.argv.slice(2);
if(!path||!['before-transaction','after-message-write','after-state-write','after-commit'].includes(phase))throw new Error('Invalid crash fixture');
const template=fixture(),config={...template.config,dbPath:path};template.close();
const store=new Store(path),service=new SessionService(store,config,()=>1000000,()=>0);
function die():never{process.kill(process.pid,'SIGKILL');throw new Error('Fixture kill did not occur');}
if(phase==='before-transaction'){
  store.tx=<T>(_fn:()=>T):T=>die();
}else if(phase==='after-message-write'||phase==='after-state-write'){
  const write=store.run.bind(store);
  store.run=(sql:string,...args:unknown[])=>{
    const result=write(sql,...args);
    if(phase==='after-message-write'&&sql.startsWith('INSERT INTO messages(')||phase==='after-state-write'&&sql.startsWith('UPDATE agent_private_states SET version='))die();
    return result;
  };
}else{
  // SessionService emits only AFTER its SQLite transaction commits. Kill before later SSE listeners or HTTP completion.
  service.changes.prependOnceListener('changed',()=>die());
}
const app=buildServer(service,{timers:false});
await app.listen({host:'127.0.0.1',port:0});
const address=app.server.address();if(!address||typeof address==='string')throw new Error('No crash fixture port');
config.publicOrigin=`http://127.0.0.1:${address.port}`;
process.send?.({ready:true,base:config.publicOrigin});
