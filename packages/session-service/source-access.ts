import { ensure, type Context } from '../contracts/index.js';
import type { SourceChunk } from '../contracts/source.js';
import type { Store } from '../storage-sqlite/index.js';

export type SourceRow = {id:string;session_id:string;source:string;external_id:string;title:string;text:string;
  url:string|null;published_at:string|null;fetched_at:number;version:number;enabled:number;audience_json:string};
/** Only fixed, internal aliases are passed. Values remain SQL parameters. */
export const visibleInputSQL = (alias='i') => `(${alias}.kind='message' OR EXISTS(SELECT 1 FROM source_items s
  WHERE s.id=${alias}.entity_id AND s.session_id=${alias}.session_id AND s.enabled=1
  AND (s.audience_json='null' OR EXISTS(SELECT 1 FROM json_each(s.audience_json) WHERE value=?))))`;
export function sourceAllowed(row:SourceRow,agentId:string):boolean {
  return !!row.enabled && (row.audience_json==='null' || (JSON.parse(row.audience_json) as string[]).includes(agentId));
}
export function ownerSource(store:Store,sessionId:string,agentId:string,id:string):SourceRow {
  const owner=store.get<{session_id:string;retired_at:number|null}>('SELECT session_id,retired_at FROM agent_instances WHERE id=?',agentId);
  const row=store.get<SourceRow>('SELECT * FROM source_items WHERE id=? AND session_id=?',id,sessionId);
  ensure(owner?.session_id===sessionId && owner.retired_at===null && row && sourceAllowed(row,agentId),404,'SOURCE_NOT_FOUND');
  return row;
}
export function inputHigh(store:Store,sessionId:string,agentId?:string):number {
  const suffix=agentId?` AND ${visibleInputSQL()}`:'';
  return store.get<{n:number}>(`SELECT COALESCE(MAX(i.id),0) n FROM agent_input_log i WHERE i.session_id=?${suffix}`,
    ...agentId?[sessionId,agentId]:[sessionId])!.n;
}
export function sourceChunk(row:SourceRow,agentId:string,offset=0):SourceChunk {
  const through=Math.min(row.text.length,offset+1600);
  return {id:row.id,title:row.title,text:row.text.slice(offset,through),url:row.url,publishedAt:row.published_at,
    fetchedAt:row.fetched_at,version:row.version,offset,totalChars:row.text.length,
    nextCursor:through<row.text.length?Buffer.from(JSON.stringify({id:row.id,version:row.version,agentId,offset:through})).toString('base64url'):null};
}
export function lookupSource(store:Store,sessionId:string,agentId:string,id:string,cursor:string|null):SourceChunk {
  const row=ownerSource(store,sessionId,agentId,id);let offset=0;
  if(cursor){
    let value:{id?:string;version?:number;agentId?:string;offset?:number};
    try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('INVALID_SOURCE_CURSOR');}
    ensure(value && value.id===id && value.agentId===agentId && value.version===row.version &&
      Number.isSafeInteger(value.offset) && value.offset!>=0 && value.offset!<row.text.length,409,'SOURCE_RESYNC_REQUIRED');offset=value.offset!;
  }
  return sourceChunk(row,agentId,offset);
}
export function currentSources(store:Store,sessionId:string,agentId:string):Context['sources'] {
  return store.all<SourceRow>(`SELECT * FROM source_items WHERE session_id=? AND enabled=1
    AND (audience_json='null' OR EXISTS(SELECT 1 FROM json_each(audience_json) WHERE value=?))
    ORDER BY fetched_at DESC,rowid DESC LIMIT 4`,sessionId,agentId).map(row=>sourceChunk(row,agentId));
}
