// Test-owned Worker process with synthetic model output; never connects to a real model Provider.
import { writeFileSync } from 'node:fs';
import { CoreClient, WorkerRuntime } from '../../apps/agent-worker/runtime.js';
const [base,marker]=process.argv.slice(2),token=process.env.SYNTHETIC_WORKER_TOKEN;
if(!base||new URL(base).hostname!=='127.0.0.1'||!marker||!token)throw new Error('Invalid worker crash fixture');
const worker=new WorkerRuntime(new CoreClient(base,token),{ALLOW_LIVE_MODELS:'0'},()=>({
  complete:async()=>{
    writeFileSync(marker,'after-call-reservation-before-result',{flag:'wx',mode:0o600});
    process.kill(process.pid,'SIGKILL');throw new Error('Fixture kill did not occur');
  },
}));
await worker.register();await worker.once();throw new Error('Crash fixture unexpectedly completed');
