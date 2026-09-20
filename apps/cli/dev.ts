import { startCluster } from './cluster.js';
const cluster=await startCluster(process.env,process.env.QUIET_START==='1');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await cluster.stop();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void stop();});
for(const child of cluster.children)child.on('exit',code=>{if(!stopping){process.exitCode=code===0?1:code??1;void stop();}});
