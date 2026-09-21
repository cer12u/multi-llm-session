import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {ArchiveSession,type ArchiveRead} from '../apps/web/src/archive-session.js';

function reader(f:ReturnType<typeof fixture>):ArchiveRead{return async<T>(path:string,body?:unknown):Promise<T>=>{
  const url=new URL(path,'http://synthetic.invalid');
  if(!url.pathname.startsWith(`/v1/sessions/${f.id}/`))throw new Error('CROSS_SESSION_READ');
  if(url.pathname.endsWith('/messages/lookup'))return f.service.pages.byIds(f.id,(body as {ids:string[]}).ids) as T;
  if(url.pathname.endsWith('/history'))return f.service.pages.history(f.id,{limit:100,cursor:url.searchParams.get('cursor')}) as T;
  throw new Error('UNEXPECTED_WRITE_OR_ROUTE');
};}
it('R7-ARCHIVE-010: failed old-record reconciliation retries at the same snapshot revision rather than retaining a deleted body',async()=>{
  const f=fixture(),normal=reader(f);let fail=false;
  const read:ArchiveRead=async<T>(path:string,body?:unknown)=>{if(fail&&path.endsWith('/lookup'))throw new Error('SYNTHETIC_RECONCILIATION_OFFLINE');return normal<T>(path,body);};
  const cache=new ArchiveSession(f.id,read,()=>{});
  try{
    const old=f.say('削除前の古い本文');for(let i=0;i<220;i++)f.say('新しい発言 '+i);
    await cache.synchronize(f.service.snapshot(f.id));while(cache.historyCursor)await cache.loadOlder();
    f.service.changeMessage(f.id,old.id,null,randomUUID());const snapshot=f.service.snapshot(f.id);
    fail=true;await cache.synchronize(snapshot);expect(cache.historyError).toBe('SYNTHETIC_RECONCILIATION_OFFLINE');
    expect(cache.messages[0].deleted).toBe(false);
    fail=false;await cache.synchronize(snapshot);
    expect(cache.messages[0]).toMatchObject({id:old.id,deleted:true,text:''});expect(cache.historyError).toBe('');
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{cache.dispose();f.close();}
});
it('R7-ARCHIVE-011: reconciling 1205 retained originals does not redraw the full timeline after each lookup chunk',async()=>{
  const f=fixture(),changed=vi.fn(),cache=new ArchiveSession(f.id,reader(f),changed);
  try{
    const old=f.say('最古の発言');for(let i=1;i<1205;i++)f.say('原文 '+i);
    await cache.synchronize(f.service.snapshot(f.id));while(cache.historyCursor)await cache.loadOlder();
    changed.mockClear();f.service.changeMessage(f.id,old.id,null,randomUUID());await cache.synchronize(f.service.snapshot(f.id));
    expect(cache.messages).toHaveLength(1205);expect(cache.messages[0]).toMatchObject({deleted:true,text:''});
    expect(changed.mock.calls.length).toBeLessThanOrEqual(2);expect(f.service.session(f.id).call_count).toBe(0);
  }finally{cache.dispose();f.close();}
});
