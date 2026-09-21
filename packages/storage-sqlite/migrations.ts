import type Database from 'better-sqlite3';
import { migrateMemory } from './memory-migration.js';

/** Additive, transactional migration: never discard conversation or private-memory rows. */
function migrateV2(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 2) return;
  if (version !== 1) throw new Error('Unsupported migration source: ' + version);
  db.transaction(() => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN thread_root TEXT NOT NULL DEFAULT '';
      UPDATE messages SET sequence=rowid;
      WITH RECURSIVE roots(id,root) AS (
        SELECT id,id FROM messages WHERE reply_to IS NULL
        UNION ALL SELECT m.id,r.root FROM messages m JOIN roots r ON m.reply_to=r.id
      ) UPDATE messages SET thread_root=COALESCE((SELECT root FROM roots WHERE roots.id=messages.id),id);
      CREATE UNIQUE INDEX message_sequence ON messages(session_id,sequence);
      CREATE INDEX thread_sequence ON messages(session_id,thread_root,sequence);
      ALTER TABLE workers ADD COLUMN last_seen_at INTEGER;
      ALTER TABLE agent_instances ADD COLUMN retry_at INTEGER;
      ALTER TABLE agent_instances ADD COLUMN last_error TEXT;
      ALTER TABLE runs ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE llm_calls ADD COLUMN context_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN active_elapsed_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN active_since INTEGER;
      ALTER TABLE sessions ADD COLUMN window_call_start INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN window_post_start INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET active_since=started_at WHERE started_at IS NOT NULL AND lifecycle='RUNNING';
      UPDATE sessions SET active_elapsed_ms=MAX(0,unixepoch()*1000-started_at) WHERE started_at IS NOT NULL AND lifecycle!='RUNNING';
      CREATE TABLE provider_health(scope TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
        open_until INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        probe_call TEXT, probe_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE model_profiles(id TEXT NOT NULL,version INTEGER NOT NULL,definition TEXT NOT NULL,
        hash TEXT NOT NULL,PRIMARY KEY(id,version));
      ALTER TABLE sessions ADD COLUMN edit_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN message_seq INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET message_seq=COALESCE((SELECT MAX(sequence) FROM messages WHERE session_id=sessions.id),0);
      ALTER TABLE memories ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
      UPDATE memories SET sequence=rowid;
      ALTER TABLE agent_instances ADD COLUMN memory_seq INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_instances SET memory_seq=COALESCE((SELECT MAX(sequence) FROM memories WHERE agent_id=agent_instances.id),0);
      CREATE UNIQUE INDEX memory_owner_order ON memories(agent_id,sequence);
      UPDATE candidates SET state='NEEDS_REVIEW',reviewed_revision=0,reason='UPGRADE_REVIEW_REQUIRED'
        WHERE state IN ('READY','NEEDS_REVIEW') AND text IS NOT NULL;
    `);
    for (const row of db.prepare('SELECT id,settings_json FROM sessions').all() as {id:string;settings_json:string}[]) {
      const s = JSON.parse(row.settings_json);
      if (s.selfWakeEnabled === undefined) s.selfWakeEnabled = s.selfWakeMaxMs < s.maxDurationMs;
      db.prepare('UPDATE sessions SET settings_json=? WHERE id=?').run(JSON.stringify(s),row.id);
    }
    db.pragma('user_version = 2');
  }).immediate();
}

function migrateV3(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 3) return;
  if (version === 1) migrateV2(db);
  else if (version !== 2) throw new Error('Unsupported migration source: ' + version);
  db.transaction(() => {
    db.exec(`
      CREATE TABLE agent_private_states(
        agent_id TEXT PRIMARY KEY REFERENCES agent_instances(id),
        version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
        entries_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
      CREATE TABLE agent_state_updates(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agent_instances(id),
        run_id TEXT UNIQUE REFERENCES runs(id), kind TEXT NOT NULL,
        from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
        observation_json TEXT, patch_json TEXT NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX state_update_owner ON agent_state_updates(agent_id,id);
      INSERT INTO agent_private_states(agent_id,updated_at) SELECT id,0 FROM agent_instances;
      UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
      UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
      UPDATE candidates SET state='NEEDS_REVIEW',reason='PRIVATE_STATE_UPGRADE' WHERE state='READY';
      PRAGMA user_version=3;
    `);
  }).immediate();
}

/** Ordered notification log; old cursors are not assumed to prove past coverage. */
function migrateV4(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 4) return;
  if (version < 3) migrateV3(db);
  else if (version !== 3) throw new Error('Unsupported migration source: ' + version);
  db.transaction(() => {
    db.exec(`
      CREATE TABLE agent_input_log(id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL,
        entity_id TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX input_session_order ON agent_input_log(session_id,id);
      INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
        SELECT session_id,'message',id,revision,created_at FROM messages ORDER BY session_id,sequence;
      INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
        SELECT session_id,'source',id,fetched_at,fetched_at FROM source_items ORDER BY fetched_at,rowid;
      CREATE TRIGGER input_message_insert AFTER INSERT ON messages BEGIN
        INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
          VALUES(NEW.session_id,'message',NEW.id,NEW.revision,NEW.created_at); END;
      CREATE TRIGGER input_message_update AFTER UPDATE OF text,deleted,revision ON messages BEGIN
        INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
          VALUES(NEW.session_id,'message',NEW.id,NEW.revision,
            MAX(NEW.created_at,COALESCE((SELECT MAX(created_at) FROM agent_input_log WHERE session_id=NEW.session_id),NEW.created_at))); END;
      CREATE TRIGGER input_source_insert AFTER INSERT ON source_items BEGIN
        INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
          VALUES(NEW.session_id,'source',NEW.id,NEW.fetched_at,NEW.fetched_at); END;
      CREATE TABLE agent_input_cursors(agent_id TEXT PRIMARY KEY REFERENCES agent_instances(id),
        observed_input INTEGER NOT NULL DEFAULT 0, memory_input INTEGER NOT NULL DEFAULT 0,
        memory_target INTEGER NOT NULL DEFAULT 0, foreground_runs INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_input_receipts(run_id TEXT PRIMARY KEY REFERENCES runs(id),
        agent_id TEXT NOT NULL REFERENCES agent_instances(id), purpose TEXT NOT NULL,
        from_input INTEGER NOT NULL, through_input INTEGER NOT NULL, target_input INTEGER NOT NULL,
        window_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX input_receipt_owner ON agent_input_receipts(agent_id,purpose,through_input);
      CREATE TABLE candidate_state_bindings(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),state_version INTEGER NOT NULL);
      CREATE TABLE memory_input_origins(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id),evidence_json TEXT NOT NULL);
      INSERT INTO agent_input_cursors(agent_id) SELECT id FROM agent_instances;
      UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
      UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
      UPDATE candidates SET state='NEEDS_REVIEW',reason='INPUT_CURSOR_UPGRADE' WHERE state='READY';
      PRAGMA user_version=4;
    `);
  }).immediate();
}

/** Retain one-shot, owner-selected agenda identity across changes and process restarts. */
function migrateV5(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 5) return;
  if (version < 4) migrateV4(db);
  else if (version !== 4) throw new Error('Unsupported migration source: ' + version);
  db.transaction(() => {
    db.exec(`
      CREATE TABLE agent_agenda(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_instances(id),
        entry_id TEXT NOT NULL, condition_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK(status IN ('PENDING','TRIGGERED','CONSUMED','CANCELLED')),
        checked_input INTEGER NOT NULL, effective_at INTEGER, matched_input INTEGER, matched_version INTEGER,
        notified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, triggered_at INTEGER,
        consumed_run TEXT REFERENCES runs(id), ended_at INTEGER, reason TEXT);
      CREATE INDEX agenda_owner_status ON agent_agenda(agent_id,status);
      CREATE TABLE agent_agenda_bindings(agent_id TEXT NOT NULL REFERENCES agent_instances(id),
        entry_id TEXT NOT NULL, plan_id TEXT UNIQUE NOT NULL REFERENCES agent_agenda(id), PRIMARY KEY(agent_id,entry_id));
      CREATE TABLE agent_agenda_clock(agent_id TEXT PRIMARY KEY REFERENCES agent_instances(id),last_wake_at INTEGER NOT NULL);
      UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
      UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
      UPDATE candidates SET state='NEEDS_REVIEW',reason='AGENDA_UPGRADE' WHERE state='READY';
      PRAGMA user_version=5;
    `);
  }).immediate();
}

export function migrate(db:Database.Database):void {
  const version=db.pragma('user_version',{simple:true}) as number;
  if(version===6)return;
  if(version>6)throw new Error('Unsupported migration source: '+version);
  migrateV5(db);migrateMemory(db);
}
