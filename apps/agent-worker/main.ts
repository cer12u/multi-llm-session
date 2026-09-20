import { CoreClient, CoreError, WorkerRuntime, delay } from './runtime.js';
const token=process.env.WORKER_TOKEN,base=process.env.CORE_URL??'http://127.0.0.1:3000';
if(!token||token.length<24) throw new Error('WORKER_TOKEN is required');
const shutdown=new AbortController(),runtime=new WorkerRuntime(new CoreClient(base,token));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{shutdown.abort();runtime.stop();});
for(let retry=0;;retry++) {
  try { await runtime.register(); break; }
  catch { if(retry>=30||shutdown.signal.aborted) throw new Error('Core registration failed'); await delay(500,shutdown.signal); }
}
while(!shutdown.signal.aborted) {
  try { const worked=await runtime.once(shutdown.signal); if(!worked) await delay(350,shutdown.signal); }
  catch(e) { if(e instanceof CoreError&&e.code==='STALE_WORKER') { process.exitCode=2; break; } await delay(1000,shutdown.signal); }
}
