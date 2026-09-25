import {createHash} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {canonical,hash} from '../domain/index.js';
import {ensure,Id,type Context} from '../contracts/index.js';
import {diagnosticProjection,diagnosticScope,checkDiagnosticStructure,type Projection} from '../storage-sqlite/diagnostic-migration.js';
import {type Store,type MessageRow,type RunRow,profileOf,characterOf,settingsOf} from '../storage-sqlite/index.js';
import type {SessionService} from '../session-service/index.js';
import {MAX_DIAGNOSTIC_BYTES,MAX_DIAGNOSTIC_ROWS,snapshotHash,type Snapshot,type Row,type Header,type Frame,type Footer} from './replay.js';

const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const json=(s:string|null)=>s===null?null:JSON.parse(s) as Row;
const numeric=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
export type JournalRow={seq:number;session_id:string;table_name:string;key_json:string;kind:Frame['kind'];before_json:string|null;after_json:string|null};
const frame=(r:JournalRow):Frame=>({type:'change',seq:r.seq,sessionId:r.session_id,table:r.table_name,key:json(r.key_json)!,kind:r.kind,before:json(r.before_json),after:json(r.after_json)});

/** Read only an explicit session-owned projection, never credential/RPC capability tables. */
export function diagnosticSnapshot(store:Store,sessionId:string,projection:Projection[]=diagnosticProjection(store.db)):Snapshot {
  let count=0,bytes=0;
  return projection.map(p=>{
    const predicate=diagnosticScope(p,'x')+'=?';
    const size=store.get<{n:number;bytes:number}>(`SELECT COUNT(*) n,COALESCE(SUM(${p.columns.map(c=>`COALESCE(length(CAST(x.${quote(c)} AS BLOB)),0)`).join('+')}),0) bytes FROM ${quote(p.table)} x WHERE ${predicate}`,sessionId)!;
    count+=size.n;bytes+=size.bytes;ensure(count<=MAX_DIAGNOSTIC_ROWS&&bytes<=MAX_DIAGNOSTIC_BYTES/2,413,'DIAGNOSTIC_SIZE_LIMIT');
    const rows=store.all<Row>(`SELECT ${p.columns.map(c=>'x.'+quote(c)).join(',')} FROM ${quote(p.table)} x WHERE ${predicate}`,sessionId);
    const key=(row:Row)=>canonical(Object.fromEntries(p.keys.map(k=>[k,row[k]])));
    return {table:p.table,rows:rows.sort((a,b)=>key(a).localeCompare(key(b)))};
  });
}

/** Facts recorded by the application, with unrecorded execution provenance explicitly unknown. */
export function diagnosticManifest(service:SessionService,id:string,env:NodeJS.ProcessEnv=process.env){
  const s=service.session(id),agents=service.store.all<Parameters<typeof profileOf>[0]>('SELECT * FROM agent_instances WHERE session_id=? ORDER BY id',id);
  const commit=env.BUILD_SHA??env.GITHUB_SHA;
  const usage=service.store.get<{calls:number;inputKnown:number;outputKnown:number;inputTokens:number|null;outputTokens:number|null}>(
    'SELECT COUNT(*) calls,COUNT(c.input_tokens) inputKnown,COUNT(c.output_tokens) outputKnown,SUM(c.input_tokens) inputTokens,SUM(c.output_tokens) outputTokens FROM llm_calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=?',id)!;
  return {exporterCommit:commit&&/^[a-f0-9]{40}$/i.test(commit)?commit:null,executionCommits:null,seed:null,
    missingProvenance:['Historical Core/Worker build SHAs and RNG seed were not recorded; export does not invent them.'],
    exportedAt:service.now(),sqliteVersion:service.store.sqliteVersion,settings:settingsOf(s),lifecycle:s.lifecycle,stopReason:s.stop_reason,
    mode:agents.every(a=>profileOf(a).provider==='mock')?'mock':'provider-adapter',
    liveModelVerified:false,declaredEvidenceMode:['synthetic','live'].includes(env.DIAGNOSTIC_EVIDENCE_MODE??'')?env.DIAGNOSTIC_EVIDENCE_MODE:'unknown',
    agents:agents.map(a=>({id:a.id,slot:a.slot,retiredAt:a.retired_at,character:characterOf(a),profile:profileOf(a),profileHash:hash(profileOf(a))})),
    usage:{...usage,missingInput:usage.calls-usage.inputKnown,missingOutput:usage.calls-usage.outputKnown,estimatedTokens:null,
      interpretation:'Sums contain only reported tokens; null/missing is not zero. Request estimates are per recorded context, not billable usage.'},
    replay:{mode:'recorded-private-projection',regenerateModels:false,operationalRestore:false,
      excluded:['Worker/authentication credentials','run bearer tokens','command receipt replay capabilities','volatile heartbeats','global catalog and shared Provider health'],
      baseline:'V8 rows are a migration baseline, not reconstructed earlier events; subsequent committed transitions are recorded.'}};
}

/** Capture a consistent committed high-water mark and independent final projection. No lock survives the return. */
export function diagnosticExport(service:SessionService,id:string,env:NodeJS.ProcessEnv=process.env):{header:Header;lines:()=>AsyncGenerator<string>} {
  Id.parse(id);
  const header=service.store.tx(()=>{
    service.session(id);checkDiagnosticStructure(service.store.db);
    const meta=service.store.get<{high:number;records:number;baseline:number;bytes:number}>(`SELECT COALESCE(MAX(seq),0) high,COUNT(*) records,
      COALESCE(SUM(kind='BASELINE'),0) baseline,COALESCE(SUM(COALESCE(length(CAST(before_json AS BLOB)),0)+COALESCE(length(CAST(after_json AS BLOB)),0)+length(CAST(key_json AS BLOB))+512),0) bytes
      FROM diagnostic_journal WHERE session_id=?`,id)!;
    ensure(meta.bytes<MAX_DIAGNOSTIC_BYTES/2,413,'DIAGNOSTIC_SIZE_LIMIT');
    const projection=diagnosticProjection(service.store.db),state=diagnosticSnapshot(service.store,id,projection);
    const result:Header={type:'manifest',kind:'private-session-diagnostic',formatVersion:1,databaseSchema:Number(service.store.db.pragma('user_version',{simple:true})) as 9|10,sessionId:id,
      high:meta.high,records:meta.records,baselineRecords:meta.baseline,stateRows:state.reduce((n,t)=>n+t.rows.length,0),
      stateHash:snapshotHash(state),projection,manifest:diagnosticManifest(service,id,env)};
    return result;
  });
  return {header,lines:async function*(){
    let position=0,count=0,bytes=0;const digest=createHash('sha256');
    const encode=(value:unknown)=>{const line=JSON.stringify(value)+'\n';bytes+=Buffer.byteLength(line);ensure(bytes<=MAX_DIAGNOSTIC_BYTES,413,'DIAGNOSTIC_SIZE_LIMIT');digest.update(line);return line;};
    yield encode(header);
    while(position<header.high){
      const rows=service.store.all<JournalRow>('SELECT * FROM diagnostic_journal WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 100',id,position,header.high);
      ensure(rows.length,409,'DIAGNOSTIC_JOURNAL_INCOMPLETE');
      for(const row of rows){position=row.seq;count++;yield encode(frame(row));}
      await nextTurn();
    }
    ensure(count===header.records,409,'DIAGNOSTIC_JOURNAL_INCOMPLETE');
    const footer:Footer={type:'end',records:count,high:header.high,sha256:digest.digest('hex')};yield JSON.stringify(footer)+'\n';
  }};
}

/** Deliberate allowlist: public speech only, no diagnostics, source material, profile/persona hashes or token consumption. */
export function publicTranscript(service:SessionService,id:string){
  return service.store.tx(()=>{
    const s=service.session(Id.parse(id)),size=service.store.get<{n:number;bytes:number}>('SELECT COUNT(*) n,COALESCE(SUM(length(CAST(text AS BLOB))+1024),0) bytes FROM messages WHERE session_id=?',id)!;
    ensure(size.n<=MAX_DIAGNOSTIC_ROWS&&size.bytes<MAX_DIAGNOSTIC_BYTES,413,'TRANSCRIPT_SIZE_LIMIT');
    return {kind:'public-transcript',formatVersion:1,session:{id:s.id,title:s.title,lifecycle:s.lifecycle,revision:s.revision,episode:s.episode},
      transcript:service.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? ORDER BY sequence',id).map(m=>service.publicMessage(m))};
  });
}

export function diagnosticRuns(service:SessionService,id:string,options:{before?:number;limit?:number}={}){
  service.session(Id.parse(id));const limit=options.limit??25,before=options.before??Number.MAX_SAFE_INTEGER;
  ensure(numeric(before)&&Number.isInteger(limit)&&limit>=1&&limit<=50,422,'INVALID_DIAGNOSTIC_PAGE');
  const rows=service.store.all<{position:number;id:string;agent_id:string;kind:string;state:string;created_at:number;candidate_id:string|null;snapshot_revision:number}>(
    'SELECT rowid position,id,agent_id,kind,state,created_at,candidate_id,snapshot_revision FROM runs WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?',id,before,limit+1);
  const selected=rows.slice(0,limit);return {items:selected,nextBefore:rows.length>limit?selected.at(-1)!.position:null};
}

/** One immutable run's causal references, not the latest owner's state substituted for what was actually supplied. */
export function diagnosticRun(service:SessionService,id:string,runId:string){
  Id.parse(id);Id.parse(runId);
  return service.store.tx(()=>{
    service.session(id);const run=service.store.get<RunRow>('SELECT * FROM runs WHERE id=? AND session_id=?',runId,id);ensure(run,404,'RUN_NOT_FOUND');
    const context=JSON.parse(run.context_json) as Context;
    const changes=service.store.all<JournalRow>("SELECT * FROM diagnostic_journal WHERE session_id=? AND table_name='runs' AND json_extract(key_json,'$.id')=? ORDER BY seq",id,runId);
    const contexts=new Map<string,{hash:string;context:Context;firstSequence:number|null}>();
    for(const change of changes){const after=json(change.after_json);if(typeof after?.context_json==='string'){
      const key=hash(after.context_json);if(!contexts.has(key))contexts.set(key,{hash:key,context:JSON.parse(after.context_json),firstSequence:change.seq});
    }}
    const currentHash=hash(run.context_json);if(!contexts.has(currentHash))contexts.set(currentHash,{hash:currentHash,context,firstSequence:null});
    const traces=service.store.all<{id:number;code:string;detail:string;created_at:number}>('SELECT id,code,detail,created_at FROM traces WHERE session_id=? AND run_id=? ORDER BY id',id,runId);
    const candidates=new Set([run.candidate_id,...service.store.all<{id:string}>("SELECT json_extract(after_json,'$.id') id FROM diagnostic_journal WHERE session_id=? AND table_name='candidates' AND kind='INSERT' AND seq>=? AND seq<=? AND json_extract(after_json,'$.agent_id')=?",id,changes[0]?.seq??0,changes.at(-1)?.seq??0,run.agent_id).map(r=>r.id)].filter((v):v is string=>!!v));
    const candidateChanges=service.store.all<JournalRow>("SELECT * FROM diagnostic_journal WHERE session_id=? AND table_name='candidates' AND json_extract(key_json,'$.id') IN (SELECT value FROM json_each(?)) ORDER BY seq",id,JSON.stringify([...candidates]));
    const commits=service.store.all<MessageRow>('SELECT * FROM messages WHERE session_id=? AND candidate_id IN (SELECT value FROM json_each(?)) ORDER BY sequence',id,JSON.stringify([...candidates]));
    const report={run:{id:run.id,agentId:run.agent_id,kind:run.kind,state:run.state,createdAt:run.created_at,workerEpoch:run.worker_epoch,sessionEpoch:run.session_epoch,resultHash:run.result_hash},
      contextVersions:[...contexts.values()],observation:context.observation??null,delivery:context.delivery??null,recall:context.recall??null,inputBudget:context.inputBudget??null,
      stateChanges:service.store.all('SELECT id,kind,from_version,to_version,observation_json,patch_json,before_json,after_json,created_at FROM agent_state_updates WHERE run_id=? AND agent_id=? ORDER BY id',runId,run.agent_id),
      memoryChanges:service.store.all('SELECT id,kind,old_ids_json,new_id,created_at FROM memory_changes WHERE run_id=? AND agent_id=? ORDER BY id',runId,run.agent_id),
      calls:service.store.all('SELECT id,stage,status,context_hash,started_at,finished_at,input_tokens,output_tokens,error_code FROM llm_calls WHERE run_id=? ORDER BY started_at,rowid',runId),
      traces:traces.map(t=>({...t,detail:JSON.parse(t.detail)})),candidateChanges:candidateChanges.map(frame),publishedMessages:commits.map(m=>service.publicMessage(m)),
      evidence:context.observation?[...context.observation.messages,...context.observation.sources].map(ref=>({ref,publicUrl:ref.kind==='message'?`/?session=${id}&message=${ref.id}`:null,
        inspectionUrl:ref.kind==='source'?`/v1/sessions/${id}/sources/${ref.id}/versions/${ref.version}`:null,
        note:'The captured context version is the evidence actually supplied; current original edits must not replace it.'})):[]};
    ensure(Buffer.byteLength(JSON.stringify(report))<=2*1024*1024,413,'DIAGNOSTIC_DETAIL_LIMIT');return report;
  });
}
