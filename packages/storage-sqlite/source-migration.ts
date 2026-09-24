import type Database from 'better-sqlite3';

/** V7 originals remain originals. Evidence versions and acquisition time become independent. */
export function migrateSources(db: Database.Database): void {
  if (db.pragma('user_version', { simple: true }) !== 7) throw new Error('SOURCE_MIGRATION_REQUIRES_V7');
  db.transaction(() => {
    db.exec(`
      ALTER TABLE source_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE source_items ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE source_items ADD COLUMN audience_json TEXT NOT NULL DEFAULT 'null';
      UPDATE source_items SET version=fetched_at;
      CREATE TABLE source_versions(
        source_id TEXT NOT NULL REFERENCES source_items(id),version INTEGER NOT NULL,
        title TEXT NOT NULL,text TEXT NOT NULL,url TEXT,published_at TEXT,fetched_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL,audience_json TEXT NOT NULL,
        PRIMARY KEY(source_id,version));
      INSERT INTO source_versions SELECT id,version,title,text,url,published_at,fetched_at,enabled,audience_json FROM source_items;
      DROP TRIGGER input_source_insert;
      CREATE TRIGGER input_source_insert AFTER INSERT ON source_items BEGIN
        INSERT INTO source_versions VALUES(NEW.id,NEW.version,NEW.title,NEW.text,NEW.url,NEW.published_at,NEW.fetched_at,NEW.enabled,NEW.audience_json);
        INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
          VALUES(NEW.session_id,'source',NEW.id,NEW.version,NEW.fetched_at);
      END;
      CREATE TRIGGER input_source_revision AFTER UPDATE OF version ON source_items WHEN NEW.version<>OLD.version BEGIN
        INSERT INTO source_versions VALUES(NEW.id,NEW.version,NEW.title,NEW.text,NEW.url,NEW.published_at,NEW.fetched_at,NEW.enabled,NEW.audience_json);
        INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
          VALUES(NEW.session_id,'source',NEW.id,NEW.version,NEW.fetched_at);
      END;
      CREATE TABLE source_feeds(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),config_id TEXT NOT NULL,
        version INTEGER NOT NULL,definition_json TEXT NOT NULL,enabled INTEGER NOT NULL,
        next_at INTEGER NOT NULL,last_success_at INTEGER,last_error TEXT,failures INTEGER NOT NULL DEFAULT 0,
        job_token TEXT,lease_until INTEGER,UNIQUE(session_id,config_id));
      CREATE TABLE source_feed_versions(
        feed_id TEXT NOT NULL REFERENCES source_feeds(id),version INTEGER NOT NULL,definition_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,PRIMARY KEY(feed_id,version));
      CREATE TABLE source_feed_jobs(
        id TEXT PRIMARY KEY,feed_id TEXT NOT NULL REFERENCES source_feeds(id),feed_version INTEGER NOT NULL,
        state TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,finished_at INTEGER,
        error_code TEXT,item_count INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX source_feed_due ON source_feeds(enabled,next_at);
      UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
      UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
      UPDATE candidates SET state='NEEDS_REVIEW',reason='SOURCE_VERSION_UPGRADE' WHERE state='READY';
      PRAGMA user_version=8;
    `);
  }).immediate();
}
