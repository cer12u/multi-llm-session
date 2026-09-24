import type Database from 'better-sqlite3';

/** Replace only the slot uniqueness constraint, retaining every original identity/rowid and dependent row. */
export function migrateSessions(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 7) return;
  if (version !== 6 || db.inTransaction) throw new Error('SESSION_MIGRATION_REQUIRES_V6_OUTSIDE_TRANSACTION');
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const original = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_instances'").get() as { sql: string }).sql;
      const constraint = /,\s*UNIQUE\s*\(\s*session_id\s*,\s*slot\s*\)/gi;
      if ([...original.matchAll(constraint)].length !== 1) throw new Error('SESSION_MIGRATION_UNKNOWN_AGENT_SCHEMA');
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='agent_instances' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
      const columns = (db.prepare('PRAGMA table_info(agent_instances)').all() as { name: string }[]).map(c => '"' + c.name.replaceAll('"', '""') + '"').join(',');
      const replacement = original.replace(constraint, '').replace(/^CREATE TABLE\s+["`\[]?agent_instances["`\]]?/i, 'CREATE TABLE agent_instances_next');
      if (replacement === original) throw new Error('SESSION_MIGRATION_UNKNOWN_AGENT_SCHEMA');
      db.exec(replacement);
      db.exec(`INSERT INTO agent_instances_next(rowid,${columns}) SELECT rowid,${columns} FROM agent_instances;
        DROP TABLE agent_instances;
        ALTER TABLE agent_instances_next RENAME TO agent_instances;`);
      for (const object of objects) db.exec(object.sql);
      db.exec(`
        ALTER TABLE agent_instances ADD COLUMN retired_at INTEGER CHECK(retired_at IS NULL OR enabled=0);
        ALTER TABLE agent_instances ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0;
        UPDATE agent_instances SET joined_at=(SELECT created_at FROM sessions WHERE id=session_id);
        CREATE UNIQUE INDEX present_agent_slot ON agent_instances(session_id,slot) WHERE retired_at IS NULL;
        CREATE TRIGGER retired_identity_immutable BEFORE UPDATE OF retired_at,slot,character_json,profile_json ON agent_instances
          WHEN OLD.retired_at IS NOT NULL AND
            (NEW.retired_at IS NOT OLD.retired_at OR NEW.slot IS NOT OLD.slot OR NEW.character_json IS NOT OLD.character_json OR NEW.profile_json IS NOT OLD.profile_json)
          BEGIN SELECT RAISE(ABORT,'RETIRED_IDENTITY_IMMUTABLE'); END;
        CREATE TRIGGER agent_joined_time AFTER INSERT ON agent_instances WHEN NEW.joined_at=0
          BEGIN UPDATE agent_instances SET joined_at=(SELECT created_at FROM sessions WHERE id=NEW.session_id) WHERE id=NEW.id; END;

        CREATE TABLE message_authors(message_id TEXT PRIMARY KEY REFERENCES messages(id),
          character_id TEXT NOT NULL,character_version INTEGER NOT NULL,author_name TEXT NOT NULL);
        INSERT INTO message_authors SELECT m.id,json_extract(a.character_json,'$.id'),json_extract(a.character_json,'$.version'),json_extract(a.character_json,'$.name')
          FROM messages m JOIN agent_instances a ON a.id=m.author_id;
        CREATE TRIGGER message_author_snapshot AFTER INSERT ON messages WHEN NEW.author_id IS NOT NULL
          BEGIN INSERT INTO message_authors SELECT NEW.id,json_extract(character_json,'$.id'),json_extract(character_json,'$.version'),json_extract(character_json,'$.name')
            FROM agent_instances WHERE id=NEW.author_id; END;

        CREATE TABLE session_episodes(session_id TEXT NOT NULL REFERENCES sessions(id),number INTEGER NOT NULL,
          started_at INTEGER NOT NULL,closed_at INTEGER,from_sequence INTEGER NOT NULL,through_sequence INTEGER NOT NULL,
          origin TEXT NOT NULL,PRIMARY KEY(session_id,number));
        INSERT INTO session_episodes SELECT session_id,episode,MIN(created_at),NULL,MIN(sequence),MAX(sequence),'legacy-message-index'
          FROM messages GROUP BY session_id,episode;
        UPDATE session_episodes SET closed_at=(SELECT MIN(e.started_at) FROM session_episodes e
          WHERE e.session_id=session_episodes.session_id AND e.number>session_episodes.number);
        INSERT OR IGNORE INTO session_episodes SELECT id,episode,last_activity_at,NULL,message_seq+1,message_seq,'legacy-empty' FROM sessions;
        UPDATE session_episodes SET closed_at=MAX(started_at,(SELECT last_activity_at FROM sessions WHERE id=session_id))
          WHERE closed_at IS NULL AND session_id IN (SELECT id FROM sessions WHERE lifecycle='ENDED');
        CREATE TRIGGER session_first_episode AFTER INSERT ON sessions
          BEGIN INSERT INTO session_episodes VALUES(NEW.id,NEW.episode,NEW.created_at,NULL,1,0,'runtime'); END;
        CREATE TRIGGER message_episode_range AFTER INSERT ON messages
          BEGIN
            UPDATE session_episodes SET closed_at=NEW.created_at WHERE session_id=NEW.session_id AND number<NEW.episode AND closed_at IS NULL;
            INSERT INTO session_episodes VALUES(NEW.session_id,NEW.episode,NEW.created_at,NULL,NEW.sequence,NEW.sequence,'runtime')
              ON CONFLICT(session_id,number) DO UPDATE SET through_sequence=MAX(through_sequence,NEW.sequence);
          END;
        UPDATE runs SET state='CANCELLED' WHERE state='ACTIVE';
        UPDATE llm_calls SET status='ABANDONED' WHERE status='RESERVED';
        UPDATE candidates SET state='NEEDS_REVIEW',reason='MEMBERSHIP_UPGRADE' WHERE state='READY';
        PRAGMA user_version=7;
      `);
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SESSION_MIGRATION_FOREIGN_KEY_FAILED');
    }).immediate();
  } finally { db.pragma('foreign_keys = ' + (foreignKeys ? 'ON' : 'OFF')); }
}
