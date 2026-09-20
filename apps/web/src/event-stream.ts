import type { Snapshot } from '../../../packages/contracts/index.js';

/** Public projections are replaceable. A disconnected/stale SSE cursor always recovers from a fresh snapshot. */
export function subscribeSession(load:()=>Promise<Snapshot>,publish:(snapshot:Snapshot)=>void,status:(text:string)=>void):()=>void {
  let closed=false,source:EventSource|null=null,retry:ReturnType<typeof setTimeout>|null=null;
  let refreshTimer:ReturnType<typeof setTimeout>|null=null,fetching=false,dirty=false,backoff=1000,generation=0;
  const reconnect=()=>{
    if(closed||retry)return;generation++;source?.close();source=null;status('再接続中');
    retry=setTimeout(()=>{retry=null;void connect();},backoff);backoff=Math.min(backoff*2,10000);
  };
  const refresh=async()=>{
    dirty=true;if(fetching||closed)return;fetching=true;const expected=generation;
    try{while(dirty&&!closed&&expected===generation){dirty=false;const snapshot=await load();if(!closed&&expected===generation)publish(snapshot);}}
    catch{reconnect();}finally{fetching=false;}
  };
  const connect=async()=>{
    const expected=++generation;
    try{
      const snapshot=await load();if(closed||expected!==generation)return;publish(snapshot);
      source=new EventSource(`/v1/sessions/${snapshot.session.id}/events?cursor=${encodeURIComponent(snapshot.cursor)}`);
      source.onopen=()=>{backoff=1000;status('接続中');};
      source.onerror=reconnect;
      source.onmessage=()=>{dirty=true;if(!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh();},100);};
    }catch{reconnect();}
  };
  void connect();
  return()=>{closed=true;generation++;source?.close();if(retry)clearTimeout(retry);if(refreshTimer)clearTimeout(refreshTimer);};
}
