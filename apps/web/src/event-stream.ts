import type { Snapshot } from '../../../packages/contracts/index.js';
import { PresentationDispatcher, type PresentationAdapter, type PresentationEvent } from '../../../packages/presentation/index.js';

/** Public projections are replaceable. Rendering never sends a conversation command or starts a worker. */
export function subscribeSession(load:()=>Promise<Snapshot>,publish:(snapshot:Snapshot)=>void,status:(text:string)=>void,
  options:{adapter?:PresentationAdapter;adapterTimeoutMs?:number;onEvent?:(event:PresentationEvent)=>void}={}):()=>void {
  let closed=false,source:EventSource|null=null,retry:ReturnType<typeof setTimeout>|null=null;
  let presentation:PresentationDispatcher|null=null;
  let refreshTimer:ReturnType<typeof setTimeout>|null=null,fetchingGeneration:number|null=null,dirty=false,backoff=1000,generation=0;
  const resetConnection=()=>{generation++;source?.close();source=null;presentation?.dispose();presentation=null;};
  const reconnect=()=>{
    if(closed||retry)return;resetConnection();status('再接続中');
    retry=setTimeout(()=>{retry=null;void connect();},backoff);backoff=Math.min(backoff*2,10000);
  };
  const refresh=async()=>{
    dirty=true;if(fetchingGeneration===generation||closed)return;const expected=generation;fetchingGeneration=expected;
    try{while(dirty&&!closed&&expected===generation){dirty=false;const snapshot=await load();if(!closed&&expected===generation)publish(snapshot);}}
    catch{if(!closed&&expected===generation)reconnect();}
    finally{if(fetchingGeneration===expected)fetchingGeneration=null;}
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
        let accepted=false;
        try{if(typeof event?.data==='string'&&event.data.length<=65536)accepted=presentation?.receive(JSON.parse(event.data))??false;}catch{}
        if(!accepted)requestRefresh();
      };
    }catch{if(!closed&&expected===generation)reconnect();}
  };
  const offline=()=>reconnect();
  // Recovery of connectivity is new evidence: do not keep a previous offline backoff.
  // Fence old pending requests before acquiring a fresh authoritative snapshot.
  const online=()=>{if(closed)return;if(retry)clearTimeout(retry);retry=null;backoff=1000;resetConnection();status('再接続中');void connect();};
  if(typeof window!=='undefined'){window.addEventListener('offline',offline);window.addEventListener('online',online);}
  void connect();
  return()=>{if(typeof window!=='undefined'){window.removeEventListener('offline',offline);window.removeEventListener('online',online);}closed=true;resetConnection();if(retry)clearTimeout(retry);if(refreshTimer)clearTimeout(refreshTimer);};
}
