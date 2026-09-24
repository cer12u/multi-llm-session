import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {ArchiveSession,type ArchiveRead} from '../apps/web/src/archive-session.js';
import {subscribeSession} from '../apps/web/src/event-stream.js';
import type {Snapshot} from '../packages/contracts/index.js';

function reader(f:ReturnType<typeof fixture>,fail:()=>boolean):ArchiveRead {
  return async<T>(path:string,body?:unknown):Promise<T>=>{
    const url=new URL(path,'http://synthetic.invalid');
    if(url.pathname.endsWith('/messages/lookup')){if(fail())throw new Error('SYNTHETIC_OFFLINE');return f.service.pages.byIds(f.id,(body as {ids:string[]}).ids) as T;}
    if(url.pathname.endsWith('/history'))return f.service.pages.history(f.id,{limit:100,cursor:url.searchParams.get('cursor')}) as T;
    if(url.pathname.endsWith('/snapshot'))return f.service.snapshot(f.id) as T;
    throw new Error('UNEXPECTED_ARCHIVE_ROUTE');
  };
}
it('R7-ARCHIVE-010: failed old-message revalidation is retried for an identical snapshot revision',async()=>{
  const f=fixture();let fail=false;const cache=new ArchiveSession(f.id,reader(f,()=>fail),()=>{});
  try{
    const original=f.say('old original');for(let i=1;i<300;i++)f.say('newer '+i);
    await cache.synchronize(f.service.snapshot(f.id));await cache.loadOlder();expect(cache.messages).toHaveLength(300);
    f.service.changeMessage(f.id,original.id,null,randomUUID());const snapshot=f.service.snapshot(f.id);
    fail=true;await cache.synchronize(snapshot);expect(cache.historyError).toBe('SYNTHETIC_OFFLINE');
    expect(cache.messages.find(m=>m.id===original.id)?.deleted).toBe(false);
    fail=false;await cache.synchronize(snapshot);
    expect(cache.messages.find(m=>m.id===original.id)).toMatchObject({deleted:true,text:''});expect(cache.historyError).toBe('');
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{cache.dispose();f.close();}
});
it('R7-ARCHIVE-011: a later observed event cannot conceal an earlier missed edit outside the recent snapshot',async()=>{
  const f=fixture(),cache=new ArchiveSession(f.id,reader(f,()=>false),()=>{});
  try{
    const original=f.say('old original');for(let i=1;i<300;i++)f.say('newer '+i);
    await cache.synchronize(f.service.snapshot(f.id));await cache.loadOlder();
    f.service.changeMessage(f.id,original.id,null,randomUUID());const latest=f.say('a later event');
    cache.event({kind:'message.created',revision:latest.revision,message:latest});
    await cache.synchronize(f.service.snapshot(f.id));
    expect(cache.messages.find(m=>m.id===original.id)).toMatchObject({deleted:true,text:''});
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{cache.dispose();f.close();}
});
it('R7-STREAM-010: coming online immediately cancels offline backoff and disposal removes its listener',async()=>{
  vi.useFakeTimers();const browser=new EventTarget();vi.stubGlobal('window',browser);
  class Source {static all:Source[]=[];onmessage:((event:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;onopen:(()=>void)|null=null;closed=false;constructor(readonly url:string){Source.all.push(this);}close(){this.closed=true;}}
  vi.stubGlobal('EventSource',Source);const id=randomUUID(),snapshot=(revision:number)=>({session:{id},cursor:id+':'+revision}) as Snapshot;
  const load=vi.fn().mockResolvedValueOnce(snapshot(1)).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot(4));
  const publish=vi.fn(),stop=subscribeSession(load,publish,()=>{});
  try{
    await vi.advanceTimersByTimeAsync(0);browser.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(3000);expect(load).toHaveBeenCalledTimes(3);
    browser.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(4);expect(publish).toHaveBeenLastCalledWith(snapshot(4));expect(Source.all[0].closed).toBe(true);
    stop();browser.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(20000);expect(load).toHaveBeenCalledTimes(4);
  }finally{stop();vi.unstubAllGlobals();vi.useRealTimers();}
});
