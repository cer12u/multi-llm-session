import { loadConfig } from '../../packages/config/index.js';
import { Store } from '../../packages/storage-sqlite/index.js';
import { SessionService } from '../../packages/session-service/index.js';
import { FeedPoller } from '../../packages/sources/index.js';
import { buildServer } from './server.js';

const config=loadConfig(),store=new Store(config.dbPath),service=new SessionService(store,config);
service.recover();
const app=buildServer(service),poller=new FeedPoller(service);
let feedJob:Promise<void>|null=null;
const timer=setInterval(()=>{if(!feedJob)feedJob=poller.tick().finally(()=>{feedJob=null;});},1000);
let stopping=false;
async function stop() {
  if(stopping)return;stopping=true;clearInterval(timer);await app.close();await feedJob;store.close();
}
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{void stop().catch(()=>{process.exitCode=1;});});
try {await app.listen({host:config.host,port:config.port});console.log(`Session Core listening; SQLite ${store.sqliteVersion}; live=${config.allowLive}`);}
catch {await stop();throw new Error('Core startup failed');}
