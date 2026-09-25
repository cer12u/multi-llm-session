import type Database from 'better-sqlite3';

/** Private replay projection: no Worker tokens, command-receipt capabilities, global credentials or volatile heartbeats. */
export const diagnosticTables = [
  'sessions','agent_instances','candidates','runs','messages','message_author_snapshots','events','traces','pending_questions',
  'agent_private_states','agent_state_updates','agent_input_log','agent_input_cursors','agent_input_receipts',
  'candidate_state_bindings','memories','memory_metadata','memory_edges','memory_changes','memory_input_origins',
  'agent_agenda','agent_agenda_bindings','agent_agenda_clock','session_member_changes','session_episodes',
  'source_items','source_versions','source_feeds','source_feed_versions','source_feed_jobs','llm_calls',
] as const;
export type Projection = {table:string;columns:string[];keys:string[]};
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const excluded:Record<string,string[]>={runs:['token','lease_until'],llm_calls:['request_key']};

export function diagnosticProjection(db:Database.Database):Projection[]{
  return diagnosticTables.map(table=>{
    const info=db.prepare('PRAGMA table_info('+quote(table)+')').all() as {name:string;pk:number}[];
    if(!info.length)throw new Error('DIAGNOSTIC_SOURCE_TABLE_MISSING');
    const columns=info.map(c=>c.name).filter(c=>!excluded[table]?.includes(c));
    const keys=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
    if(!keys.length||keys.some(key=>!columns.includes(key)))throw new Error('DIAGNOSTIC_PRIMARY_KEY_REQUIRED');
    return {table,columns,keys};
  });
}
export function diagnosticScope(p:Projection,alias:string):string {
  const col=(name:string)=>alias+'.'+quote(name);
  if(p.table==='sessions')return col('id');
  if(p.columns.includes('session_id'))return col('session_id');
  if(p.columns.includes('agent_id'))return `(SELECT session_id FROM agent_instances WHERE id=${col('agent_id')})`;
  if(p.columns.includes('candidate_id'))return `(SELECT session_id FROM candidates WHERE id=${col('candidate_id')})`;
  if(p.columns.includes('message_id'))return `(SELECT session_id FROM messages WHERE id=${col('message_id')})`;
  if(p.columns.includes('run_id'))return `(SELECT session_id FROM runs WHERE id=${col('run_id')})`;
  if(p.columns.includes('source_id'))return `(SELECT session_id FROM source_items WHERE id=${col('source_id')})`;
  if(p.columns.includes('feed_id'))return `(SELECT session_id FROM source_feeds WHERE id=${col('feed_id')})`;
  const memory=p.columns.includes('memory_id')?'memory_id':p.table==='memory_edges'?'child_id':null;
  if(memory)return `(SELECT a.session_id FROM memories m JOIN agent_instances a ON a.id=m.agent_id WHERE m.id=${col(memory)})`;
  throw new Error('DIAGNOSTIC_SESSION_SCOPE_REQUIRED');
}
function json(columns:string[],alias:string):string{return 'json_object('+columns.flatMap(c=>[literal(c),alias+'.'+quote(c)]).join(',')+')';}

/** UPDATE frames contain keys and changed columns only, avoiding repeated persona/context copies on counters. */
function delta(p:Projection,alias:'OLD'|'NEW'):string{
  return '(SELECT json_group_object(k,v) FROM ('+p.columns.map(c=>'SELECT '+literal(c)+' k,'+alias+'.'+quote(c)+' v WHERE '+(p.keys.includes(c)?'1':'OLD.'+quote(c)+' IS NOT NEW.'+quote(c))).join(' UNION ALL ')+'))';
}

/** One baseline for retained V8 rows, then committed row transitions in their actual SQLite trigger order. */
export function migrateDiagnostics(db:Database.Database):void {
  if(db.pragma('user_version',{simple:true})!==8)throw new Error('DIAGNOSTIC_MIGRATION_REQUIRES_V8');
  db.transaction(()=>{
    const projection=diagnosticProjection(db);
    db.exec(`CREATE TABLE diagnostic_projection(version INTEGER PRIMARY KEY,definition_json TEXT NOT NULL);
      CREATE TABLE diagnostic_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),
        table_name TEXT NOT NULL,key_json TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('BASELINE','INSERT','UPDATE','DELETE')),
        before_json TEXT,after_json TEXT);
      CREATE INDEX diagnostic_session_seq ON diagnostic_journal(session_id,seq);`);
    db.prepare('INSERT INTO diagnostic_projection VALUES(1,?)').run(JSON.stringify(projection));
    // A baseline is explicitly not reconstructed historical actions or past model output.
    for(const p of projection)db.exec(`INSERT INTO diagnostic_journal(session_id,table_name,key_json,kind,before_json,after_json)
      SELECT ${diagnosticScope(p,'x')},${literal(p.table)},${json(p.keys,'x')},'BASELINE',NULL,${json(p.columns,'x')}
      FROM ${quote(p.table)} x ORDER BY ${p.keys.map(k=>'x.'+quote(k)).join(',')};`);
    for(const p of projection){
      const old=json(p.columns,'OLD'),next=json(p.columns,'NEW'),oldKey=json(p.keys,'OLD'),nextKey=json(p.keys,'NEW');
      const oldSession=diagnosticScope(p,'OLD'),nextSession=diagnosticScope(p,'NEW');
      const same=`(${oldKey}=${nextKey} AND ${oldSession}=${nextSession})`;
      const insert='INSERT INTO diagnostic_journal(session_id,table_name,key_json,kind,before_json,after_json)';
      db.exec(`CREATE TRIGGER diagnostic_${p.table}_i AFTER INSERT ON ${quote(p.table)} BEGIN
          ${insert} VALUES(${nextSession},${literal(p.table)},${nextKey},'INSERT',NULL,${next}); END;
        CREATE TRIGGER diagnostic_${p.table}_d AFTER DELETE ON ${quote(p.table)} BEGIN
          ${insert} VALUES(${oldSession},${literal(p.table)},${oldKey},'DELETE',${old},NULL); END;
        CREATE TRIGGER diagnostic_${p.table}_u AFTER UPDATE OF ${p.columns.map(quote).join(',')} ON ${quote(p.table)}
          WHEN ${old} IS NOT ${next} BEGIN
          ${insert} SELECT ${oldSession},${literal(p.table)},${oldKey},'DELETE',${old},NULL WHERE NOT ${same};
          ${insert} VALUES(${nextSession},${literal(p.table)},${nextKey},CASE WHEN ${same} THEN 'UPDATE' ELSE 'INSERT' END,
            CASE WHEN ${same} THEN ${delta(p,'OLD')} ELSE NULL END,CASE WHEN ${same} THEN ${delta(p,'NEW')} ELSE ${next} END); END;`);
    }
    db.pragma('user_version=9');
  }).immediate();
}

export function checkDiagnosticStructure(db:Database.Database):void {
  const objects=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all() as {name:string}[]).map(o=>o.name));
  const required=['diagnostic_projection','diagnostic_journal','diagnostic_session_seq',...diagnosticTables.flatMap(t=>['i','u','d'].map(s=>'diagnostic_'+t+'_'+s))];
  if(required.some(n=>!objects.has(n)))throw new Error('STORAGE_SCHEMA_INCOMPLETE');
  const row=db.prepare('SELECT definition_json FROM diagnostic_projection WHERE version=1').get() as {definition_json:string}|undefined;
  if(!row||row.definition_json!==JSON.stringify(diagnosticProjection(db)))throw new Error('STORAGE_DIAGNOSTIC_SCHEMA_MISMATCH');
}
