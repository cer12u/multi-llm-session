import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { subscribeSession } from '../apps/web/src/event-stream.js';
import type { PresentationEvent } from '../packages/presentation/index.js';

class Stream {
  static all: Stream[]=[];
  onmessage: ((event: {data:string})=>void)|null=null;
  onerror: (()=>void)|null=null;
  onopen: (()=>void)|null=null;
  closed=false;
  constructor(readonly url:string){Stream.all.push(this);}
  close(){this.closed=true;}
}

it('R9-PRESENT-006: actual snapshot/event data reaches the replaceable adapter without awaiting its ACK', async()=>{
  vi.useFakeTimers();vi.stubGlobal('EventSource',Stream);Stream.all=[];
  const f=fixture(), supplied:PresentationEvent[]=[], published=vi.fn();let stop=()=>{};
  try{
    f.say('既存の公開発言');
    const load=vi.fn(async()=>f.service.snapshot(f.id));
    stop=subscribeSession(load,published,()=>{},{adapter:{handle:event=>{supplied.push(event);return new Promise<void>(()=>{});}},adapterTimeoutMs:1000});
    await vi.advanceTimersByTimeAsync(0);
    const cursor=f.service.snapshot(f.id).cursor, old=Stream.all[0];
    const first=f.say('新しい公開発言');const event=f.service.eventsAfter(f.id,cursor).find(e=>e.message)!;
    old.onmessage!({data:JSON.stringify({...event,privateState:'NOT-FOR-RENDERER'})});
    await vi.advanceTimersByTimeAsync(100);
    expect(supplied).toHaveLength(1);expect(supplied[0].message!.id).toBe(first.id);
    expect(JSON.stringify(supplied)).not.toContain('NOT-FOR-RENDERER');
    expect(published).toHaveBeenLastCalledWith(f.service.snapshot(f.id));
    old.onmessage!({data:JSON.stringify(event)});await vi.advanceTimersByTimeAsync(100);
    expect(supplied).toHaveLength(1);
    old.onerror!();await vi.advanceTimersByTimeAsync(1000);
    expect(old.closed).toBe(true);expect(Stream.all).toHaveLength(2);
    const calls=load.mock.calls.length;
    old.onmessage!({data:JSON.stringify(event)});await vi.advanceTimersByTimeAsync(100);
    expect(load.mock.calls).toHaveLength(calls);
    const now=f.service.snapshot(f.id).cursor;const second=f.say('再接続後も文字表示');
    for(const e of f.service.eventsAfter(f.id,now))Stream.all[1].onmessage!({data:JSON.stringify(e)});
    await vi.advanceTimersByTimeAsync(100);
    expect(published.mock.calls.at(-1)![0].messages.at(-1).id).toBe(second.id);
    expect(f.service.session(f.id).call_count).toBe(0);expect(f.store.all('SELECT * FROM runs')).toHaveLength(0);
  }finally{stop();f.close();vi.unstubAllGlobals();vi.useRealTimers();}
});
