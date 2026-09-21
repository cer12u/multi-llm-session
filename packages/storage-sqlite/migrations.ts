import type Database from 'better-sqlite3';

/** Additive, transactional migration: never discard conversation or private-memory rows. */
export function migrate(db: Database.Database): void {
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
    // Keep previously authorized caps. Do not silently extend any old live experiment.
    for (const row of db.prepare('SELECT id,settings_json FROM sessions').all() as {id:string;settings_json:string}[]) {
      const s = JSON.parse(row.settings_json);
      if (s.selfWakeEnabled === undefined) s.selfWakeEnabled = s.selfWakeMaxMs < s.maxDurationMs;
      db.prepare('UPDATE sessions SET settings_json=? WHERE id=?').run(JSON.stringify(s),row.id);
    }
    db.pragma('user_version = 2');
  }).immediate();
}
