import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { SourceSchema } from '../contracts/index.js';
import type { SessionService } from '../session-service/index.js';

export type FeedItem={externalId:string;title:string;text:string;url:string|null;publishedAt:string|null};
const list=(v:unknown):unknown[]=>v===undefined||v===null?[]:Array.isArray(v)?v:[v];
function text(v:unknown):string {if(typeof v==='string'||typeof v==='number')return String(v);if(v&&typeof v==='object')return text((v as Record<string,unknown>)['#text']);return '';}
export function parseFeed(xml:string):FeedItem[] {
  if(xml.length>1048576||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('UNSAFE_FEED');
  const data=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:false}).parse(xml) as {rss?:{channel?:{item?:unknown}};feed?:{entry?:unknown}};
  return list(data.rss?.channel?.item??data.feed?.entry).slice(0,20).map(raw=>{
    const item=raw as Record<string,unknown>;
    const rawLink=typeof item.link==='string'?item.link:list(item.link).map(v=>(v as Record<string,unknown>)?.['@_href']).find(v=>typeof v==='string');
    const url=typeof rawLink==='string'&&/^https?:\/\//i.test(rawLink)?rawLink:null;
    const title=text(item.title).replace(/<[^>]*>/g,'').slice(0,300)||'Untitled';
    const body=text(item.description??item.summary??item.content??item['content:encoded']).replace(/<[^>]*>/g,'').trim().slice(0,20000)||title;
    const date=text(item.pubDate??item.published??item.updated),parsed=Date.parse(date);
    return {externalId:createHash('sha256').update(text(item.guid??item.id)||url||title+':'+date).digest('hex'),title,text:body,url,publishedAt:Number.isFinite(parsed)?new Date(parsed).toISOString():null};
  });
}
export class FeedPoller {
  private busy=new Set<string>();private due=new Map<string,number>();
  constructor(readonly service:SessionService,readonly fetcher:typeof fetch=fetch){}
  async tick():Promise<void> {
    const sessions=this.service.listSessions().filter(s=>s.lifecycle==='RUNNING');if(!sessions.length)return;
    for(const feed of this.service.config.feeds){
      if(this.busy.has(feed.id)||(this.due.get(feed.id)??0)>this.service.now())continue;
      this.busy.add(feed.id);this.due.set(feed.id,this.service.now()+feed.intervalMs);
      try {
        const response=await this.fetcher(feed.url,{signal:AbortSignal.timeout(15000),redirect:'error'});
        if(!response.ok||!response.body)throw new Error('FEED_HTTP_ERROR');
        const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw new Error('FEED_SIZE_LIMIT');}chunks.push(value);}
        for(const session of sessions)for(const item of parseFeed(Buffer.concat(chunks).toString('utf8'))){
          if(this.service.session(session.id).lifecycle!=='RUNNING')break;
          if(this.service.store.get('SELECT id FROM source_items WHERE session_id=? AND source=? AND external_id=?',session.id,feed.id,item.externalId))continue;
          const {externalId,...input}=item;this.service.injectSource(session.id,SourceSchema.parse(input),externalId,feed.id);
        }
      }catch{for(const session of sessions)this.service.store.run('INSERT INTO traces(session_id,code,detail,created_at) VALUES(?,?,?,?)',session.id,'FEED_ERROR',JSON.stringify({feedId:feed.id}),this.service.now());}
      finally{this.busy.delete(feed.id);}
    }
  }
}
