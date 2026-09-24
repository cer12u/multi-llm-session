import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { validateFeedUrl } from '../config/source-url.js';
import type { SourceAdapter } from './adapters.js';
export { ManualSource, type SourceAdapter } from './adapters.js';
import type { SessionService } from '../session-service/index.js';

export type FeedItem={externalId:string;title:string;text:string;url:string|null;publishedAt:string|null};
const list=(v:unknown):unknown[]=>v===undefined||v===null?[]:Array.isArray(v)?v:[v];
function text(v:unknown):string {if(typeof v==='string'||typeof v==='number')return String(v);if(v&&typeof v==='object')return text((v as Record<string,unknown>)['#text']);return '';}
export function parseFeed(xml:string):FeedItem[] {
  if(xml.length>1048576||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('UNSAFE_FEED');
  const data=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:false}).parse(xml) as {rss?:{channel?:{item?:unknown}};feed?:{entry?:unknown}};
  if(!data||(!Object.hasOwn(data,'rss')&&!Object.hasOwn(data,'feed')))throw new Error('FEED_PARSE_ERROR');
  return list(data.rss?.channel?.item??data.feed?.entry).slice(0,20).map(raw=>{
    const item=raw as Record<string,unknown>;
    const rawLink=typeof item.link==='string'?item.link:list(item.link).map(v=>(v as Record<string,unknown>)?.['@_href']).find(v=>typeof v==='string');
    const url=typeof rawLink==='string'&&/^https?:\/\//i.test(rawLink)?rawLink:null;
    const title=text(item.title).replace(/<[^>]*>/g,'')||'Untitled';
    const body=text(item.description??item.summary??item.content??item['content:encoded']).replace(/<[^>]*>/g,'').trim()||title;
    if(title.length>300||body.length>20000)throw new Error('FEED_SIZE_LIMIT');
    const date=text(item.pubDate??item.published??item.updated),parsed=Date.parse(date);
    return {externalId:createHash('sha256').update(text(item.guid??item.id)||url||title+':'+date).digest('hex'),title,text:body,url,publishedAt:Number.isFinite(parsed)?new Date(parsed).toISOString():null};
  });
}

/** Only exact deployment-configured URLs are instantiated by the scheduler. Redirects are never followed. */
export class ConfiguredFeedSource implements SourceAdapter {
  constructor(private readonly url:string,private readonly fetcher:typeof fetch=fetch){validateFeedUrl(url);}
  async acquire(signal:AbortSignal):Promise<FeedItem[]>{
    const response=await this.fetcher(this.url,{signal,redirect:'error'});
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error('FEED_HTTP_ERROR');}
    // Also reject a substituted final URL from a custom transport.
    if(response.redirected||response.url&&new URL(response.url).href!==new URL(this.url).href){await response.body.cancel();throw new Error('FEED_HTTP_ERROR');}
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;
      if(size>1048576)throw new Error('FEED_SIZE_LIMIT');chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    return parseFeed(Buffer.concat(chunks).toString('utf8'));
  }
}
export class FeedPoller {
  constructor(readonly service:SessionService,readonly fetcher:typeof fetch=fetch){}
  async tick():Promise<void>{
    this.service.sources.seedConfigured();
    const ids=this.service.sources.dueFeeds();
    // Three independent acquisitions at a time; each is claimed just before I/O, not while another waits.
    for(let offset=0;offset<ids.length;offset+=3)await Promise.all(ids.slice(offset,offset+3).map(async id=>{
      const job=this.service.sources.claimFeed(id);if(!job)return;
      const signal=AbortSignal.timeout(15000);
      try{const items=await new ConfiguredFeedSource(job.definition.url,this.fetcher).acquire(signal);this.service.sources.finishFeed(job,items);}
      catch(error){const code=signal.aborted?'FEED_TIMEOUT':error instanceof Error?error.message:'FEED_HTTP_ERROR';
        this.service.sources.finishFeed(job,[],code);}
    }));
  }
}
