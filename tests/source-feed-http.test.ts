import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {FeedPoller,parseFeed} from '../packages/sources/index.js';

const xml='<rss><channel><item><guid>stable</guid><title>material</title><description>source body</description><pubDate>2020-01-02T03:04:05Z</pubDate></item></channel></rss>';
it.each([
  ['error','FEED_HTTP_ERROR'],['redirect','FEED_HTTP_ERROR'],['size','FEED_SIZE_LIMIT'],
  ['xml','FEED_PARSE_ERROR'],['entity','UNSAFE_FEED'],['timeout','FEED_TIMEOUT'],
] as const)('R6-FEED-010: actual HTTP %s is bounded, records a distinct failure and never invokes inference',async(mode,code)=>{
  const f=fixture(3,{selfWakeEnabled:false});let destinationRequests=0;
  const server=createServer((req,res)=>{
    if(req.url==='/destination'){destinationRequests++;res.end(xml);return;}
    if(mode==='error'){res.writeHead(503);res.end('PRIVATE_PROVIDER_ERROR');return;}
    if(mode==='redirect'){res.writeHead(302,{location:'/destination'});res.end();return;}
    if(mode==='timeout'){res.writeHead(200);res.flushHeaders();return;}
    res.setHeader('content-type','application/xml');
    res.end(mode==='size'?'x'.repeat(1048577):mode==='xml'?'<rss><channel><item>':mode==='entity'?'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>':xml);
  });
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();
    if(!address||typeof address==='string')throw new Error('Missing synthetic port');
    f.config.feeds=[{id:'bounded',url:`http://127.0.0.1:${address.port}/feed`,intervalMs:60000}];f.start();
    await new FeedPoller(f.service).tick();const feed=f.service.sources.feeds(f.id)[0];
    expect(feed).toMatchObject({failures:1,last_error:code,working:false,last_success_at:null,next_at:f.now()+60000});
    expect(f.store.get<{state:string;error_code:string}>('SELECT state,error_code FROM source_feed_jobs')).toEqual({state:'FAILED',error_code:code});
    expect(f.service.sources.list(f.id)).toEqual([]);expect(destinationRequests).toBe(0);
    expect(f.service.session(f.id).call_count).toBe(0);expect(f.service.agents(f.id).every(a=>a.error_count===0)).toBe(true);
    expect(JSON.stringify(f.service.diagnostics(f.id))).not.toContain('PRIVATE_PROVIDER_ERROR');
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));f.close();}
},25000);

it('R6-FEED-011: concurrent pollers share one durable job and repeated acquisition creates no duplicate original or observation',async()=>{
  const f=fixture(3,{selfWakeEnabled:false});let release!:()=>void,enter!:()=>void,calls=0;
  const gate=new Promise<void>(done=>{release=done;}),entered=new Promise<void>(done=>{enter=done;});
  let running:Promise<void>|undefined;
  try{
    f.config.feeds=[{id:'news',url:'https://fixture.invalid/feed',intervalMs:60000}];f.start();
    const fetcher:typeof fetch=async()=>{calls++;expect(f.store.db.inTransaction).toBe(false);enter();await gate;return new Response(xml);};
    running=new FeedPoller(f.service,fetcher).tick();await entered;
    await new FeedPoller(f.service,fetcher).tick();expect(calls).toBe(1);
    f.say('human input commits while feed I/O waits');expect(f.store.db.inTransaction).toBe(false);
    release();await running;running=undefined;
    const original=f.service.sources.list(f.id)[0],before=f.store.all('SELECT * FROM agent_input_log');
    const firstJob=f.store.get<{state:string}>('SELECT state FROM source_feed_jobs');expect(firstJob?.state).toBe('DONE');
    await new FeedPoller(f.service,fetcher).tick();expect(calls).toBe(1);
    f.advance(60001);await new FeedPoller(f.service,fetcher).tick();expect(calls).toBe(2);
    expect(f.service.sources.list(f.id)).toEqual([original]);expect(f.store.all('SELECT * FROM agent_input_log')).toEqual(before);
    expect(f.service.sources.get(f.id,original.id).publishedAt).toBe('2020-01-02T03:04:05.000Z');
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{release();await running?.catch(()=>{});f.close();}
});

it('R6-FEED-012: changing subscription fences old jobs; pause may save already-acquired material but end cannot',()=>{
  const f=fixture(3,{selfWakeEnabled:false});try{
    f.config.feeds=[{id:'news',url:'https://fixture.invalid/feed',intervalMs:60000}];f.start();
    const feed=f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:0},randomUUID());
    const old=f.service.sources.claimFeed(feed.id)!;expect(old).not.toBeNull();
    const target=f.service.agents(f.id)[1].id;
    f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:1,audience:[target]},randomUUID());
    expect(f.service.sources.finishFeed(old,parseFeed(xml))).toBe(false);expect(f.service.sources.list(f.id)).toEqual([]);
    const current=f.service.sources.claimFeed(feed.id)!;f.service.lifecycle(f.id,'pause',randomUUID());
    expect(f.service.sources.claimFeed(feed.id)).toBeNull();
    expect(f.service.sources.finishFeed(current,parseFeed(xml))).toBe(true);
    expect(f.service.sources.list(f.id)[0].audience).toEqual([target]);expect(f.service.session(f.id).lifecycle).toBe('PAUSED');
    const before=f.store.all('SELECT * FROM agent_input_log');
    expect(f.service.sources.finishFeed(current,parseFeed(xml))).toBe(true);expect(f.store.all('SELECT * FROM agent_input_log')).toEqual(before);
    f.service.sources.retryFeed(f.id,feed.id,randomUUID());f.service.lifecycle(f.id,'resume',randomUUID());
    const ending=f.service.sources.claimFeed(feed.id)!;f.service.lifecycle(f.id,'end',randomUUID());
    expect(f.service.sources.finishFeed(ending,parseFeed(xml.replace('source body','must not be stored')))).toBe(false);
    expect(f.store.all('SELECT * FROM agent_input_log')).toEqual(before);
    expect(f.service.sources.get(f.id,f.service.sources.list(f.id)[0].id).text).toBe('source body');
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});

it('R6-FEED-013: explicit audience changes revoke old access immediately but a disabled subscription retains originals',()=>{
  const f=fixture(3,{selfWakeEnabled:false});try{
    f.config.feeds=[{id:'news',url:'https://fixture.invalid/feed',intervalMs:60000}];f.start();
    const [a,b]=f.service.agents(f.id),feed=f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:0,audience:[a.id]},randomUUID());
    f.service.sources.finishFeed(f.service.sources.claimFeed(feed.id)!,parseFeed(xml));const source=f.service.sources.list(f.id)[0];
    const active=f.claim(a.slot)!;expect(active.context.sources[0].id).toBe(source.id);
    f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:1,audience:[b.id],enabled:false},randomUUID());
    expect(f.store.get<{state:string}>('SELECT state FROM runs WHERE id=?',active.id)?.state).toBe('CANCELLED');
    expect(f.service.sources.get(f.id,source.id)).toMatchObject({audience:[b.id],enabled:true,version:2});
    expect(f.service.sources.claimFeed(feed.id)).toBeNull();expect(()=>f.service.sources.retryFeed(f.id,feed.id,randomUUID())).toThrow('FEED_DISABLED');
    expect(f.service.sources.versions(f.id,source.id)).toHaveLength(2);
  }finally{f.close();}
});
