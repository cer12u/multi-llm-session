import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {FeedPoller,parseFeed} from '../packages/sources/index.js';

const xml='<rss><channel><item><guid>stable</guid><title>original</title><description>material</description></item></channel></rss>';
function setup(){const f=fixture(3,{selfWakeEnabled:false});f.config.feeds=[{id:'news',url:'https://fixture.invalid/feed',intervalMs:60000}];f.start();
  const feed=f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:0},randomUUID());
  const job=f.service.sources.claimFeed(feed.id)!;f.service.sources.finishFeed(job,parseFeed(xml));return {...f,feed};}

it('R6-FEED-000: reacquisition cannot re-enable a disabled original or widen an operator-restricted audience',()=>{
  const f=setup();try{
    const owner=f.service.agents(f.id)[0].id,record=f.service.sources.list(f.id)[0];
    const {id,version,fetchedAt:_,...input}=f.service.sources.get(f.id,record.id);
    f.service.sources.update(f.id,id,{...input,expectedVersion:version,audience:[owner],enabled:false},randomUUID());
    f.advance(60001);const job=f.service.sources.claimFeed(f.feed.id)!;
    f.service.sources.finishFeed(job,parseFeed(xml.replace('material','new material')));
    expect(f.service.sources.get(f.id,id)).toMatchObject({audience:[owner],enabled:false,text:'new material'});
    expect(f.service.sources.list(f.id)).toHaveLength(1);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});

it('R6-FEED-001: changing only the poll interval never re-grants a per-original private audience',()=>{
  const f=setup();try{
    const owner=f.service.agents(f.id)[0].id,record=f.service.sources.list(f.id)[0];
    const {id,version,fetchedAt:_,...input}=f.service.sources.get(f.id,record.id);
    f.service.sources.update(f.id,id,{...input,expectedVersion:version,audience:[owner]},randomUUID());
    const before=f.service.sources.get(f.id,id);
    f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:1,intervalMs:120000},randomUUID());
    expect(f.service.sources.get(f.id,id)).toEqual(before);
  }finally{f.close();}
});

it('R6-FEED-002: an unsafe configured feed cannot crash the poller or prevent an independent allowed feed',async()=>{
  const f=fixture(3,{selfWakeEnabled:false});try{
    f.config.feeds=[{id:'unsafe',url:'file:///private/file',intervalMs:60000},{id:'good',url:'https://fixture.invalid/feed',intervalMs:60000}];
    f.start();const calls:string[]=[];
    const poller=new FeedPoller(f.service,async url=>{calls.push(String(url));return new Response(xml);});
    await expect(poller.tick()).resolves.toBeUndefined();
    expect(calls).toEqual(['https://fixture.invalid/feed']);
    expect(f.service.sources.configured().find(row=>row.id==='unsafe')?.usable).toBe(false);
    expect(f.service.sources.list(f.id)).toHaveLength(1);
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});
