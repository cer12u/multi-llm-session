import type { Context, MemoryNote } from '../contracts/index.js';
import type { Store, MessageRow } from '../storage-sqlite/index.js';
import { currentMemoryPredicate, memoryNote, normalizeMemory } from './memory-ledger.js';

export type RecallRequest = { sessionId:string;agentId:string;text:string;evidenceIds:string[];limit:number;
  subjectIds?:string[];at?:number;includeHistorical?:boolean };
export type RecallCandidate = { note:MemoryNote;score:number;originals:MessageRow[];provenance:'versioned'|'legacy-unversioned' };
export interface MemoryRetriever { search(request:RecallRequest):RecallCandidate[] }

/** Replaceable lexical baseline. Every implementation must retain the same owner/current-source predicate. */
export class LocalMemoryRetriever implements MemoryRetriever {
  constructor(protected readonly store:Store,private readonly meanings=false){}
  search(request:RecallRequest):RecallCandidate[]{
    const owner=this.store.get<{session_id:string}>('SELECT session_id FROM agent_instances WHERE id=?',request.agentId);
    if(owner?.session_id!==request.sessionId)return [];
    if(!Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100)throw new Error('INVALID_RECALL_LIMIT');
    const segmenter=new Intl.Segmenter('ja',{granularity:'word'}),normalized=normalizeMemory(request.text);
    const terms=[...new Set([...segmenter.segment(normalized)].filter(s=>s.isWordLike&&[...s.segment].length>=2).map(s=>s.segment))].slice(0,32);
    const meaningScore=this.meanings?`+
      2*(SELECT COUNT(*) FROM json_each(?) t WHERE instr(lower(COALESCE(mm.meaning_json,'')),t.value)>0)
      +8*CASE WHEN json_extract(mm.meaning_json,'$.subjectId') IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END`:'';
    const timeFilter=this.meanings&&request.at!==undefined&&!request.includeHistorical?`
      AND (mm.meaning_json IS NULL OR
        ((json_extract(mm.meaning_json,'$.validFrom') IS NULL OR json_extract(mm.meaning_json,'$.validFrom')<=?)
        AND (json_extract(mm.meaning_json,'$.validTo') IS NULL OR json_extract(mm.meaning_json,'$.validTo')>?)))`:'';
    const args:unknown[]=[JSON.stringify(terms),JSON.stringify(request.evidenceIds)];
    if(this.meanings)args.push(JSON.stringify(terms),JSON.stringify(request.subjectIds??[]));
    args.push(request.agentId,request.sessionId);
    if(timeFilter)args.push(request.at,request.at);
    args.push(request.limit);
    const rows=this.store.all<{id:string;agent_id:string;text:string;sources_json:string;created_at:number;sequence:number;score:number}>(`
      SELECT m.*,(SELECT COUNT(*) FROM json_each(?) t WHERE instr(lower(m.text),t.value)>0)
        +4*CASE WHEN EXISTS(SELECT 1 FROM json_each(m.sources_json) s JOIN json_each(?) e ON s.value=e.value) THEN 1 ELSE 0 END
        ${meaningScore} score
      FROM memories m JOIN agent_instances a ON a.id=m.agent_id LEFT JOIN memory_metadata mm ON mm.memory_id=m.id
      WHERE m.agent_id=? AND a.session_id=? AND ${currentMemoryPredicate()} ${timeFilter}
      ORDER BY score DESC,m.sequence DESC LIMIT ?`,...args);
    const hasQuery=terms.length>0||request.evidenceIds.length>0||(this.meanings&&(request.subjectIds?.length??0)>0);
    return rows.filter(row=>!hasQuery||row.score>0).map(row=>{
      const note=memoryNote(this.store,row);
      return {note,score:row.score,
        originals:this.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence',request.sessionId,row.sources_json),
        provenance:note.provenance?.evidence?'versioned':'legacy-unversioned'};
    });
  }
}
/** Adds declared paraphrase aliases, subject links and explicit validity-time selection, not an embedding/semantic oracle. */
export class MeaningMemoryRetriever extends LocalMemoryRetriever {constructor(store:Store){super(store,true);}}

export function recallRequest(context:Context,sessionId:string,agentId:string,now?:number,includeHistorical=false):RecallRequest {
  const entries=context.self.privateState?.entries??[],recent=context.messages.slice(-3).filter(m=>!m.deleted);
  const text=[...recent.map(m=>m.text),...context.questions.map(q=>q.text),...entries.map(e=>e.text)].join('\n');
  const explicitDate=recent.at(-1)?.text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  let at=now;
  if(explicitDate){const parsed=Date.parse(explicitDate+'T00:00:00Z');if(Number.isFinite(parsed))at=parsed;}
  else if(now!==undefined&&/昨日/.test(recent.at(-1)?.text??''))at=now-86400000;
  else if(now!==undefined&&/明日/.test(recent.at(-1)?.text??''))at=now+86400000;
  const subjectIds=[...new Set([...recent.flatMap(m=>m.addressedTo),...context.questions.map(q=>q.from).filter((id):id is string=>id!==null),
    ...context.participants.filter(p=>text.includes(p.name)).map(p=>p.id)])];
  return {sessionId,agentId,limit:12,text,subjectIds,at,includeHistorical:includeHistorical||/以前|過去|前回|昔|履歴/.test(recent.at(-1)?.text??''),
    evidenceIds:[...new Set([...entries.flatMap(e=>e.evidence.filter(r=>r.kind==='message').map(r=>r.id)),...context.questions.map(q=>q.messageId)])]};
}
