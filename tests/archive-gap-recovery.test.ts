import {expect,it} from 'vitest';
import {fixture} from './helpers.js';
import {ArchiveSession,type ArchiveRead} from '../apps/web/src/archive-session.js';

it('R7-ARCHIVE-012: a failed reconnect-gap page is retried without a new message or manual reload',async()=>{
  const f=fixture();let offline=false;
  const read:ArchiveRead=async<T>(path:string,body?:unknown):Promise<T>=>{
    const url=new URL(path,'http://synthetic.invalid');
    if(!url.pathname.startsWith(`/v1/sessions/${f.id}/`))throw new Error('CROSS_SESSION_READ');
    if(url.pathname.endsWith('/history')){if(offline)throw new Error('SYNTHETIC_GAP_OFFLINE');return f.service.pages.history(f.id,{limit:100,cursor:url.searchParams.get('cursor')}) as T;}
    if(url.pathname.endsWith('/messages/lookup'))return f.service.pages.byIds(f.id,(body as {ids:string[]}).ids) as T;
    throw new Error('UNEXPECTED_WRITE_OR_ROUTE');
  };
  const cache=new ArchiveSession(f.id,read,()=>{});
  try{
    for(let i=0;i<250;i++)f.say('先行原文 '+i);await cache.synchronize(f.service.snapshot(f.id));
    for(let i=0;i<300;i++)f.say('切断中の原文 '+i);const next=f.service.snapshot(f.id);
    offline=true;await cache.synchronize(next);expect(cache.historyError).toBe('SYNTHETIC_GAP_OFFLINE');expect(cache.messages).toHaveLength(400);
    offline=false;await cache.synchronize(next);
    expect(cache.messages.map(m=>m.sequence)).toEqual(Array.from({length:500},(_,i)=>i+51));
    expect(cache.historyError).toBe('');expect(f.service.session(f.id).call_count).toBe(0);
  }finally{cache.dispose();f.close();}
});
