import { createHash } from 'node:crypto';
import { AppError, ensure, type PublicMessage, type MemoryNote, type Page } from '../contracts/index.js';
import { Store, type MessageRow } from '../storage-sqlite/index.js';

type Cursor = { v: 1; scope: string; high: number; position: number };
type Options = { cursor?: string | null; limit?: number };
/** Immutable insertion order, never mutable revision, determines a page boundary. */
export class ArchivePages {
  constructor(readonly store: Store, readonly project: (row: MessageRow) => PublicMessage) {}
  private session(id: string): void { ensure(this.store.get('SELECT id FROM sessions WHERE id=?',id),404,'SESSION_NOT_FOUND'); }
  private limit(value=100): number { ensure(Number.isSafeInteger(value)&&value>=1&&value<=200,422,'INVALID_PAGE_SIZE'); return value; }
  private token(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
  private cursor(scope: string, input: string|null|undefined, high: number, direction: 'asc'|'desc'): Cursor {
    if (!input) return {v:1,scope,high,position:direction==='asc'?0:high+1};
    ensure(input.length<=2048,422,'INVALID_PAGE_CURSOR');
    let c: Cursor; try { c=JSON.parse(Buffer.from(input,'base64url').toString('utf8')) as Cursor; } catch { throw new AppError(422,'INVALID_PAGE_CURSOR'); }
    ensure(c.v===1&&c.scope===scope&&Number.isSafeInteger(c.high)&&c.high>=0&&c.high<=high&&Number.isSafeInteger(c.position)&&c.position>=0&&c.position<=c.high+1,409,'PAGE_RESYNC_REQUIRED');
    return c;
  }
  history(session: string, options: Options={}): Page<PublicMessage> {
    this.session(session); const limit=this.limit(options.limit);
    return this.store.tx(()=>{
      const high=this.store.get<{message_seq:number}>('SELECT message_seq FROM sessions WHERE id=?',session)!.message_seq;
      const c=this.cursor('history:'+session,options.cursor,high,'desc');
      const rows=this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT ?',session,c.high,c.position,limit+1);
      const more=rows.length>limit,selected=rows.slice(0,limit);
      return {items:selected.map(this.project).reverse(),highWater:c.high,nextCursor:more?this.token({...c,position:selected.at(-1)!.sequence}):null};
    });
  }
  thread(session: string, messageId: string, options: Options={}): Page<PublicMessage>&{rootId:string} {
    this.session(session); const m=this.store.get<MessageRow>('SELECT * FROM messages WHERE session_id=? AND id=?',session,messageId);
    ensure(m,404,'MESSAGE_NOT_FOUND'); const limit=this.limit(options.limit),rootId=m.thread_root;
    return this.store.tx(()=>{
      const high=this.store.get<{message_seq:number}>('SELECT message_seq FROM sessions WHERE id=?',session)!.message_seq;
      const c=this.cursor('thread:'+session+':'+rootId,options.cursor,high,'asc');
      const rows=this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND thread_root=? AND sequence<=? AND sequence>? ORDER BY sequence LIMIT ?',session,rootId,c.high,c.position,limit+1);
      const selected=rows.slice(0,limit);
      return {rootId,items:selected.map(this.project),highWater:c.high,nextCursor:rows.length>limit?this.token({...c,position:selected.at(-1)!.sequence}):null};
    });
  }
  search(session: string, query: string, options: Options={}): Page<PublicMessage> {
    this.session(session); ensure(query.trim().length>0&&query.length<=200,422,'INVALID_QUERY'); const limit=this.limit(options.limit);
    return this.store.tx(()=>{
      const s=this.store.get<{message_seq:number;edit_generation:number}>('SELECT message_seq,edit_generation FROM sessions WHERE id=?',session)!;
      // Edit/delete may change matching membership. Force an explicit restart rather than silently skip results.
      const digest=createHash('sha256').update(query).digest('hex').slice(0,24);
      const c=this.cursor(`search:${session}:${digest}:${s.edit_generation}`,options.cursor,s.message_seq,'desc');
      const rows=[...query].length>=3?this.store.all<MessageRow>(
        'SELECT m.* FROM messages_fts f JOIN messages m ON m.id=f.message_id WHERE messages_fts MATCH ? AND m.session_id=? AND m.deleted=0 AND m.sequence<=? AND m.sequence<? ORDER BY m.sequence DESC LIMIT ?',
        '"'+query.replaceAll('"','""')+'"',session,c.high,c.position,limit+1):this.store.all<MessageRow>(
        'SELECT * FROM messages WHERE session_id=? AND deleted=0 AND instr(text,?)>0 AND sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT ?',session,query,c.high,c.position,limit+1);
      const selected=rows.slice(0,limit);
      return {items:selected.map(this.project),highWater:c.high,nextCursor:rows.length>limit?this.token({...c,position:selected.at(-1)!.sequence}):null};
    });
  }
  memories(agentId: string, query='', options: Options={}): Page<MemoryNote> {
    const owner=this.store.get<{memory_seq:number}>('SELECT memory_seq FROM agent_instances WHERE id=?',agentId);
    ensure(owner,404,'AGENT_NOT_FOUND'); ensure(query.length<=200,422,'INVALID_QUERY'); const limit=this.limit(options.limit);
    const digest=createHash('sha256').update(query).digest('hex').slice(0,24);
    const c=this.cursor('memory:'+agentId+':'+digest,options.cursor,owner.memory_seq,'desc');
    const rows=this.store.all<{id:string;text:string;sources_json:string;sequence:number}>(
      'SELECT * FROM memories WHERE agent_id=? AND sequence<=? AND sequence<? AND instr(text,?)>0 ORDER BY sequence DESC LIMIT ?',agentId,c.high,c.position,query,limit+1);
    const selected=rows.slice(0,limit);
    return {items:selected.map(m=>({id:m.id,text:m.text,sourceMessageIds:JSON.parse(m.sources_json)})),highWater:c.high,
      nextCursor:rows.length>limit?this.token({...c,position:selected.at(-1)!.sequence}):null};
  }
  byIds(session: string, ids: string[]): PublicMessage[] {
    this.session(session); ensure(ids.length<=200&&new Set(ids).size===ids.length,422,'INVALID_MESSAGE_BATCH');
    const rows=this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence',session,JSON.stringify(ids));
    ensure(rows.length===ids.length,404,'MESSAGE_NOT_FOUND'); return rows.map(this.project);
  }
}
