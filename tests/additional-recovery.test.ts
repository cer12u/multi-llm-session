import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';
const cleanups:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function setup(){const f=fixture();cleanups.push(f.close);return f;}
it('keeps edited messages in original publication order and invalidates derived private notes',()=>{
  const f=setup(),first=f.say('最初の発言'),second=f.say('次の発言'),a=f.service.agents(f.id)[0];
  f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at) VALUES(?,?,?,?,?)',randomUUID(),a.id,'旧本文の要約',JSON.stringify([first.id]),f.now());
  f.service.changeMessage(f.id,first.id,'最初の発言を訂正',randomUUID());
  expect(f.service.snapshot(f.id).messages.map(m=>m.id)).toEqual([first.id,second.id]);expect(f.service.workerMemories(a.slot,a.id)).toHaveLength(0);
});
it('does not starve other workers while one holds a slow inference run',()=>{
  const f=setup();f.start();const slow=f.claim('worker-0')!;f.advance(500);
  const other=f.claim('worker-1')!;f.speak(other);f.finish(f.claim('worker-1')!,{decision:'DRAFT',text:'待たずに会話を進める'});expect(f.service.commitNext(f.id)?.authorId).toBe(other.context.self.id);
  expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',slow.id)?.state).toBe('ACTIVE');
  f.speak(slow);const draft=f.claim('worker-0')!;expect(draft.context.messages.at(-1)?.text).toBe('待たずに会話を進める');
});
it('retains a cancelled remote-call reservation until its timeout boundary',()=>{
  const f=setup();f.config.maxConcurrentProvider=1;f.start();const r=f.claim('worker-0')!;
  f.service.reserveCall('worker-0',r.workerEpoch,r.id,r.token,randomUUID(),'primary');
  f.service.registerWorker('worker-0');const other=f.claim('worker-1')!;
  expect(()=>f.service.reserveCall('worker-1',other.workerEpoch,other.id,other.token,randomUUID(),'primary')).toThrow('PROVIDER_BUSY');
});
it('revokes an open cookie-authenticated SSE stream on logout',async()=>{
  const f=setup(),app=buildServer(f.service,{timers:false});cleanups.push(()=>app.close());
  await app.listen({host:'127.0.0.1',port:0});f.config.publicOrigin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const login=await fetch(f.config.publicOrigin+'/v1/auth/login',{method:'POST',headers:{origin:f.config.publicOrigin,'content-type':'application/json'},body:JSON.stringify({token:f.config.adminToken})});
  const cookie=login.headers.get('set-cookie')!.split(';')[0];const controller=new AbortController();
  try{
    const stream=await fetch(`${f.config.publicOrigin}/v1/sessions/${f.id}/events?cursor=${encodeURIComponent(f.service.snapshot(f.id).cursor)}`,{headers:{cookie},signal:controller.signal});
    const reader=stream.body!.getReader();await reader.read();
    await fetch(f.config.publicOrigin+'/v1/auth/logout',{method:'POST',headers:{cookie,origin:f.config.publicOrigin,'content-type':'application/json'},body:'{}'});
    const result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Stream was not revoked')),2000))]);expect(result.done).toBe(true);
  }finally{controller.abort();}
});
