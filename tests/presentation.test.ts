import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { PresentationDispatcher, publicPresentationEvent, type PresentationAdapter, type PresentationEvent } from '../packages/presentation/index.js';

class FakePresentationAdapter implements PresentationAdapter {
  events: PresentationEvent[] = [];
  handle(event: PresentationEvent): void { this.events.push(event); }
}
afterEach(() => { vi.useRealTimers(); });

it('R9-PRESENT-001: two displays and duplicate/replayed events do not publish twice or invoke agents', () => {
  const f=fixture(), a=new FakePresentationAdapter(), b=new FakePresentationAdapter();
  const one=new PresentationDispatcher(f.id,a), two=new PresentationDispatcher(f.id,b);
  try {
    const message=f.say('公開する合成メッセージ');
    const before=f.service.exportSession(f.id), events=f.service.eventsAfter(f.id,f.id+':0');
    for(const event of events){one.receive(event);one.receive(event);two.receive(event);}
    expect(a.events.filter(e=>e.message?.id===message.id)).toHaveLength(1);
    expect(b.events).toEqual(a.events);
    expect(one.cursor).toBe(f.service.snapshot(f.id).cursor);
    const reconnect=new PresentationDispatcher(f.id,a,undefined,one.cursor);
    for(const event of events)expect(reconnect.receive(event)).toBe(false);
    expect(f.service.exportSession(f.id)).toEqual(before);
    expect(f.service.session(f.id).call_count).toBe(0);
    expect(f.store.all('SELECT * FROM runs')).toHaveLength(0);
    reconnect.dispose();
  }finally{one.dispose();two.dispose();f.close();}
});

it('R9-PRESENT-002: only whitelisted public fields cross the boundary, including nested deletion redaction', () => {
  const f=fixture();
  try {
    const message=f.say('公開本文');const event=f.service.eventsAfter(f.id,f.id+':0').find(e=>e.message)!;
    const privateValue='PRIVATE-SYNTHETIC-CANARY';
    const clean=publicPresentationEvent({...event,persona:privateValue,apiKey:privateValue,
      data:{...event.data,privateState:privateValue,candidate:privateValue},message:{...message,persona:privateValue}})!;
    expect(clean.schemaVersion).toBe(1);expect(JSON.stringify(clean)).not.toContain(privateValue);
    expect(clean.data).toEqual({});expect(clean.message!.text).toBe('公開本文');
    const deleted=publicPresentationEvent({...event,message:{...message,deleted:true,text:privateValue}})!;
    expect(deleted.message!.text).toBe('');expect(JSON.stringify(deleted)).not.toContain(privateValue);
    expect(publicPresentationEvent({...event,schemaVersion:999})).toBeNull();
    expect(publicPresentationEvent({...event,id:randomUUID()+':1'})).toBeNull();
    expect(publicPresentationEvent({...event,message:{...message,sessionId:randomUUID()}})).toBeNull();
    expect(publicPresentationEvent({...event,id:f.id+':9007199254740992'})).toBeNull();
  }finally{f.close();}
});

it('R9-PRESENT-003: throwing, rejected and missing enhancements always leave text delivery operational', async () => {
  const f=fixture(), sinks:PresentationDispatcher[]=[];
  try {
    f.say('本文');const events=f.service.eventsAfter(f.id,f.id+':0');
    for(const enhancement of [undefined,{handle:()=>{throw new Error('synthetic');}},{handle:()=>Promise.reject(new Error('synthetic'))}]) {
      const text=new FakePresentationAdapter(), sink=new PresentationDispatcher(f.id,text,enhancement);sinks.push(sink);
      for(const event of events)sink.receive(event);
      await Promise.resolve();await Promise.resolve();
      expect(text.events).toHaveLength(events.length);
      if(enhancement)expect(sink.enhancementDisabled).toBe(true);
    }
  }finally{for(const sink of sinks)sink.dispose();f.close();}
});

it('R9-PRESENT-004: a hung adapter has no growing queue and cannot delay publication or later text', async () => {
  vi.useFakeTimers();const f=fixture(), text=new FakePresentationAdapter();let invocations=0;
  const sink=new PresentationDispatcher(f.id,text,{handle:()=>{invocations++;return new Promise<void>(()=>{});}},undefined,100);
  try {
    for(let i=0;i<20;i++)f.say('確定発言 '+i);
    const events=f.service.eventsAfter(f.id,f.id+':0');for(const event of events)sink.receive(event);
    expect(invocations).toBe(1);expect(text.events).toHaveLength(events.length);
    await vi.advanceTimersByTimeAsync(100);expect(sink.enhancementDisabled).toBe(true);
    const after=f.say('ACKを待たずに確定');for(const event of f.service.eventsAfter(f.id,sink.cursor))sink.receive(event);
    expect(text.events.at(-1)!.message!.id).toBe(after.id);
    expect(f.service.session(f.id).call_count).toBe(0);expect(invocations).toBe(1);
    sink.dispose();expect(sink.receive(events[0])).toBe(false);
  }finally{sink.dispose();f.close();}
});

it('R9-PRESENT-005: edits/tombstones are new events; stale replay never restores the former text', () => {
  const f=fixture(), text=new FakePresentationAdapter(), sink=new PresentationDispatcher(f.id,text);
  try {
    const message=f.say('以前の本文');const events=f.service.eventsAfter(f.id,f.id+':0');for(const e of events)sink.receive(e);
    f.service.changeMessage(f.id,message.id,'編集した本文',randomUUID());for(const e of f.service.eventsAfter(f.id,sink.cursor))sink.receive(e);
    expect(text.events.at(-1)!.message!.text).toBe('編集した本文');
    f.service.changeMessage(f.id,message.id,null,randomUUID());for(const e of f.service.eventsAfter(f.id,sink.cursor))sink.receive(e);
    expect(text.events.at(-1)!.message).toMatchObject({deleted:true,text:''});
    for(const e of events)expect(sink.receive(e)).toBe(false);
    expect(text.events.at(-1)!.message!.text).toBe('');
    const other=f.service.createSession(f.input,randomUUID()).id;
    for(const e of f.service.eventsAfter(other,other+':0'))expect(sink.receive(e)).toBe(false);
  }finally{sink.dispose();f.close();}
});
