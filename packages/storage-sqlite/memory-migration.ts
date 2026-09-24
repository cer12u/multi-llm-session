import type Database from 'better-sqlite3';
/** V6 adds interpretation metadata and history without inferring meaning from old notes. */
export function migrateMemory(db:Database.Database):void{
  const version=db.pragma('user_version',{simple:true}) as number;
  if(version===6)return;
  if(version!==5)throw new Error('Unsupported memory migration source: '+version);
  db.transaction(()=>{
    db.exec(`CREATE TABLE memory_metadata(memory_id TEXT PRIMARY KEY REFERENCES memories(id),
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED','CONFLICT','INVALID')),
      meaning_json TEXT,evidence_json TEXT,reason TEXT);
      CREATE TABLE memory_edges(parent_id TEXT NOT NULL REFERENCES memories(id),child_id TEXT NOT NULL REFERENCES memories(id),
        PRIMARY KEY(parent_id,child_id),CHECK(parent_id!=child_id));
      CREATE INDEX memory_edges_child ON memory_edges(child_id);
      CREATE TABLE memory_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES agent_instances(id),
        run_id TEXT REFERENCES runs(id),kind TEXT NOT NULL,old_ids_json TEXT NOT NULL,new_id TEXT REFERENCES memories(id),created_at INTEGER NOT NULL);
      CREATE INDEX memory_changes_owner ON memory_changes(agent_id,id);
      INSERT INTO memory_metadata(memory_id,status,evidence_json)
        SELECT m.id,'ACTIVE',o.evidence_json FROM memories m LEFT JOIN memory_input_origins o ON o.memory_id=m.id;
      UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
      UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
      UPDATE candidates SET state='NEEDS_REVIEW',reason='MEMORY_UPGRADE' WHERE state='READY';
      PRAGMA user_version=6;`);
  }).immediate();
}
