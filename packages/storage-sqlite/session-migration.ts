import type Database from 'better-sqlite3';

/** SQLite's create-copy-drop-rename migration; all owner IDs, row order and child references survive.
 * Foreign keys are disabled only on this migration connection, outside the transaction, and restored in finally.
 * No writable_schema, source-history deletion, automatic backup replacement or asynchronous work is used.
 */
export function migrateSessions(db:Database.Database):void {
  const version=db.pragma('user_version',{simple:true}) as number;
  if(version===7)return;
  if(version!==6||db.inTransaction)throw new Error('SESSION_MIGRATION_REQUIRES_V6_OUTSIDE_TRANSACTION');
  const foreignKeys=db.pragma('foreign_keys',{simple:true}) as number;
  const table=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_instances'").get() as {sql:string}|undefined;
  if(!table||!/,\s*UNIQUE\s*\(\s*session_id\s*,\s*slot\s*\)/i.test(table.sql))throw new Error('SESSION_MIGRATION_SOURCE_MISMATCH');
  const columns=(db.prepare('PRAGMA table_info(agent_instances)').all() as {name:string}[]).map(c=>'"'+c.name.replaceAll('"','""')+'"').join(',');
  const extras=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='agent_instances' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as {sql:string}[];
  const create=table.sql.replace(/^CREATE TABLE\s+["`\[]?agent_instances["`\]]?/i,'CREATE TABLE agent_instances_v7')
    .replace(/,\s*UNIQUE\s*\(\s*session_id\s*,\s*slot\s*\)/i,'')
    .replace(/\)\s*$/,', retired_at INTEGER, CHECK(retired_at IS NULL OR enabled=0))');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(()=>{
      db.exec(create);
      db.exec(`INSERT INTO agent_instances_v7(rowid,${columns}) SELECT rowid,${columns} FROM agent_instances ORDER BY rowid;
        DROP TABLE agent_instances; ALTER TABLE agent_instances_v7 RENAME TO agent_instances;`);
      for(const extra of extras)db.exec(extra.sql);
      db.exec(`
        CREATE UNIQUE INDEX current_session_worker ON agent_instances(session_id,slot) WHERE retired_at IS NULL;
        CREATE TABLE session_member_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),agent_id TEXT NOT NULL REFERENCES agent_instances(id),
          kind TEXT NOT NULL CHECK(kind IN ('JOIN','RETIRE','APPLY')),epoch INTEGER NOT NULL,
          before_json TEXT,after_json TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX member_changes_session ON session_member_changes(session_id,id);
        CREATE TABLE message_author_snapshots(message_id TEXT PRIMARY KEY REFERENCES messages(id),
          author_id TEXT NOT NULL REFERENCES agent_instances(id),character_id TEXT NOT NULL,character_version INTEGER NOT NULL,
          author_name TEXT NOT NULL);
        INSERT INTO message_author_snapshots
          SELECT m.id,m.author_id,json_extract(a.character_json,'$.id'),json_extract(a.character_json,'$.version'),json_extract(a.character_json,'$.name')
          FROM messages m JOIN agent_instances a ON a.id=m.author_id;
        CREATE TRIGGER message_author_insert AFTER INSERT ON messages WHEN NEW.author_id IS NOT NULL BEGIN
          INSERT INTO message_author_snapshots SELECT NEW.id,NEW.author_id,json_extract(character_json,'$.id'),
            json_extract(character_json,'$.version'),json_extract(character_json,'$.name') FROM agent_instances WHERE id=NEW.author_id;
        END;
        CREATE TABLE session_episodes(session_id TEXT NOT NULL REFERENCES sessions(id),number INTEGER NOT NULL,
          started_at INTEGER NOT NULL,last_message_at INTEGER,first_sequence INTEGER NOT NULL,last_sequence INTEGER NOT NULL,
          closed_at INTEGER,end_sequence INTEGER,origin TEXT NOT NULL,PRIMARY KEY(session_id,number));
        INSERT INTO session_episodes(session_id,number,started_at,last_message_at,first_sequence,last_sequence,origin)
          SELECT session_id,episode,MIN(created_at),MAX(created_at),MIN(sequence),MAX(sequence),'existing-message-boundaries'
          FROM messages GROUP BY session_id,episode;
        INSERT OR IGNORE INTO session_episodes(session_id,number,started_at,first_sequence,last_sequence,origin)
          SELECT id,episode,created_at,1,0,'existing-empty-session' FROM sessions;
        UPDATE session_episodes SET closed_at=(SELECT MIN(n.started_at) FROM session_episodes n
          WHERE n.session_id=session_episodes.session_id AND n.number>session_episodes.number),end_sequence=last_sequence
          WHERE EXISTS(SELECT 1 FROM session_episodes n WHERE n.session_id=session_episodes.session_id AND n.number>session_episodes.number);
        UPDATE session_episodes SET closed_at=COALESCE(last_message_at,started_at),end_sequence=last_sequence,origin=origin||'-end-time-unknown'
          WHERE closed_at IS NULL AND session_id IN (SELECT id FROM sessions WHERE lifecycle='ENDED');
        CREATE TRIGGER session_episode_create AFTER INSERT ON sessions BEGIN
          INSERT INTO session_episodes(session_id,number,started_at,first_sequence,last_sequence,origin)
            VALUES(NEW.id,NEW.episode,NEW.created_at,1,0,'recorded');
        END;
        CREATE TRIGGER session_episode_message AFTER INSERT ON messages BEGIN
          UPDATE session_episodes SET closed_at=NEW.created_at,end_sequence=NEW.sequence-1
            WHERE session_id=NEW.session_id AND number<NEW.episode AND closed_at IS NULL;
          INSERT OR IGNORE INTO session_episodes(session_id,number,started_at,last_message_at,first_sequence,last_sequence,origin)
            VALUES(NEW.session_id,NEW.episode,NEW.created_at,NEW.created_at,NEW.sequence,NEW.sequence,'recorded');
          UPDATE session_episodes SET last_message_at=NEW.created_at,last_sequence=NEW.sequence
            WHERE session_id=NEW.session_id AND number=NEW.episode;
        END;
        UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
        UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
        UPDATE candidates SET state='NEEDS_REVIEW',reason='MEMBERSHIP_UPGRADE' WHERE state='READY';
      `);
      if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('SESSION_MIGRATION_FOREIGN_KEY_FAILED');
      db.pragma('user_version = 7');
    }).immediate();
  } finally {db.pragma('foreign_keys = '+(foreignKeys?'ON':'OFF'));}
}
