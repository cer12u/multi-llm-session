import {expect,it,vi} from 'vitest';
import type {Snapshot} from '../packages/contracts/index.js';
import {subscribeSession} from '../apps/web/src/event-stream.js';
class Stream{
  static all:Stream[]=[];onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:(()=>void)|null=null;closed=false;
  constructor(readonly url:string){Stream.all.push(this);}close(){this.closed=true;}
}
const snapshot=(cursor:string)=>({session:{id:'synthetic-session'},cursor} as Snapshot);
it('R7-STREAM-006: online notification cancels offline backoff immediately and disposal removes both network listeners',async()=>{
  vi.useFakeTimers();const browser=new EventTarget();vi.stubGlobal('window',browser);vi.stubGlobal('EventSource',Stream);Stream.all=[];
  const load=vi.fn().mockResolvedValue(snapshot('old:1')),publish=vi.fn();const stop=subscribeSession(load,publish,()=>{});
  try{
    await vi.advanceTimersByTimeAsync(0);load.mockRejectedValue(new Error('SYNTHETIC_OFFLINE'));browser.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(10000);const before=load.mock.calls.length;expect(before).toBeGreaterThan(2);
    load.mockResolvedValue(snapshot('new:8'));browser.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls.length).toBe(before+1);expect(publish).toHaveBeenLastCalledWith(snapshot('new:8'));
    expect(Stream.all.at(-1)!.closed).toBe(false);stop();const after=load.mock.calls.length;
    browser.dispatchEvent(new Event('online'));browser.dispatchEvent(new Event('offline'));await vi.advanceTimersByTimeAsync(20000);
    expect(load.mock.calls.length).toBe(after);
  }finally{stop();vi.unstubAllGlobals();vi.useRealTimers();}
});
it('R7-STREAM-007: a rejected request from before online recovery cannot close the newer healthy connection',async()=>{
  vi.useFakeTimers();const browser=new EventTarget();vi.stubGlobal('window',browser);vi.stubGlobal('EventSource',Stream);Stream.all=[];
  let reject!:(error:Error)=>void;const old=new Promise<Snapshot>((_resolve,no)=>{reject=no;});
  const load=vi.fn().mockResolvedValueOnce(snapshot('old:1')).mockReturnValueOnce(old).mockResolvedValue(snapshot('new:9'));
  const publish=vi.fn(),stop=subscribeSession(load,publish,()=>{});
  try{
    await vi.advanceTimersByTimeAsync(0);Stream.all[0].onmessage!();await vi.advanceTimersByTimeAsync(100);
    browser.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(0);const recovered=Stream.all.at(-1)!;
    expect(publish).toHaveBeenLastCalledWith(snapshot('new:9'));
    reject(new Error('SYNTHETIC_OLD_FAILURE'));await vi.advanceTimersByTimeAsync(20000);
    expect(recovered.closed).toBe(false);expect(load).toHaveBeenCalledTimes(3);
  }finally{stop();vi.unstubAllGlobals();vi.useRealTimers();}
});
