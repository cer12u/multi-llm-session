import { expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { ArchiveSession, type ArchiveRead } from '../apps/web/src/archive-session.js';

it('R7-ARCHIVE-009: deep-link paging batches UI notifications instead of rebuilding the growing DOM on every page', async () => {
  const f=fixture();let changes=0;
  const read:ArchiveRead=async<T>(path:string,body?:unknown)=>{
    const url=new URL(path,'http://synthetic.invalid');
    return (url.pathname.endsWith('/lookup')?f.service.pages.byIds(f.id,(body as {ids:string[]}).ids):f.service.pages.history(f.id,{cursor:url.searchParams.get('cursor'),limit:100})) as T;
  };
  const cache=new ArchiveSession(f.id,read,()=>{changes++;});
  try{
    const original=f.say('原文');for(let i=0;i<1205;i++)f.say('後続 '+i);
    await cache.synchronize(f.service.snapshot(f.id));const before=changes;
    expect(await cache.locate(original.id)).toBe(true);expect(cache.messages).toHaveLength(1206);
    expect(changes-before).toBe(2);expect(cache.historyBusy).toBe(false);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{cache.dispose();f.close();}
});
