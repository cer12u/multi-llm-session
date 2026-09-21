import type { Snapshot } from '../../../packages/contracts/index.js';
import { PresentationDispatcher, type PresentationAdapter, type PresentationEvent } from '../../../packages/presentation/index.js';

/** Public projections are replaceable. Rendering never sends a conversation command or starts a worker. */
export function subscribeSession(load:()=>Promise<Snapshot>,publish:(snapshot:Snapshot)=>void,status:(text:string)=>void,
  options:{adapter?:PresentationAdapter;adapterTimeoutMs?:number;onEvent?:(event:PresentationEvent)=>void}={}):()=>void {
  let closed=false,source:EventSource|null=null,retry:ReturnType<typeof setTimeout>|null=null;
  let presentation:PresentationDispatcher|null=null;
  let refreshTimer:ReturnType<typeof setTimeout>|null=null,fetching=false,dirty=false,backoff=1000,generation=0;
  const reconnect=()=>{
    if(closed||retry)return;generation++;source?.close();source=null;presentation?.dispose();presentation=null;status('再接続中');
    retry=setTimeout(()=>{retry=null;void connect();},backoff);backoff=Math.min(backoff*2,10000);
  };
  const refresh=async()=>{
    dirty=true;if(fetching||closed)return;fetching=true;const expected=generation;
    try{while(dirty&&!closed&&expected===generation){dirty=false;const snapshot=await load();if(!closed&&expected===generation)publish(snapshot);}}
    catch{reconnect();}finally{fetching=false;}
  };
  const requestRefresh=()=>{
    if(closed)return;dirty=true;
    if(!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh();},100);
  };
  const connect=async()=>{
    const expected=++generation;
    try{
      const snapshot=await load();if(closed||expected!==generation)return;publish(snapshot);
      presentation?.dispose();
      presentation=new PresentationDispatcher(snapshot.session.id,{handle:event=>{options.onEvent?.(event);requestRefresh();}},options.adapter,snapshot.cursor,options.adapterTimeoutMs);
      source=new EventSource(`/v1/sessions/${snapshot.session.id}/events?cursor=${encodeURIComponent(snapshot.cursor)}`);
      source.onopen=()=>{if(!closed&&expected===generation){backoff=1000;status('接続中');}};
      source.onerror=()=>{if(!closed&&expected===generation)reconnect();};
      source.onmessage=event=>{
        if(closed||expected!==generation)return;
        // Unknown/malformed extension data cannot enter an adapter. The established snapshot path still recovers.
        let accepted=false;
        try{if(typeof event?.data==='string'&&event.data.length<=65536)accepted=presentation?.receive(JSON.parse(event.data))??false;}catch{}
        if(!accepted)requestRefresh();
      };
    }catch{reconnect();}
  };
  const offline=()=>reconnect();
  if(typeof window!=='undefined')window.addEventListener('offline',offline);
  void connect();
  return()=>{if(typeof window!=='undefined')window.removeEventListener('offline',offline);closed=true;generation++;source?.close();presentation?.dispose();if(retry)clearTimeout(retry);if(refreshTimer)clearTimeout(refreshTimer);};
}
