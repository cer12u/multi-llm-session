import { startCluster } from './cluster.js';
const cluster=await startCluster(process.env,process.env.QUIET_START==='1');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await cluster.stop();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void stop();});
cluster.children[0].on('exit',code=>{if(!stopping){process.exitCode=code===0?1:code??1;void stop();}});
for(const [index,child] of cluster.children.slice(1).entries())child.on('exit',code=>{
  if(!stopping)console.error(`Worker slot ${index} exited (${code}); Core and other workers remain running. Restart the local cluster to replace it, or use Compose for automatic worker restart.`);
});
