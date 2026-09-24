import type Database from 'better-sqlite3';
import { legacySchemaV1 } from '../packages/storage-sqlite/index.js';

/** Test-only creation of a genuine pre-V7 fixture. Never use this as an operational downgrade. */
export function stripSessionV7(db: Database.Database): void {
  if (db.pragma('user_version', { simple: true }) !== 7 || db.inTransaction) throw new Error('FIXTURE_REQUIRES_V7');
  if ((db.prepare('SELECT COUNT(*) n FROM agent_instances WHERE retired_at IS NOT NULL').get() as { n: number }).n) throw new Error('FIXTURE_CANNOT_DISCARD_RETIRED_OWNER');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`DROP TRIGGER retired_identity_immutable; DROP TRIGGER agent_joined_time;
        DROP TRIGGER message_author_snapshot; DROP TRIGGER message_episode_range; DROP TRIGGER session_first_episode;
        DROP TABLE message_authors; DROP TABLE session_episodes;`);
      const sql = legacySchemaV1.match(/CREATE TABLE agent_instances\([\s\S]*?\);/)![0].replace('agent_instances(', 'agent_instances_v6(');
      db.exec(sql);
      db.exec(`ALTER TABLE agent_instances_v6 ADD COLUMN retry_at INTEGER;
        ALTER TABLE agent_instances_v6 ADD COLUMN last_error TEXT;
        ALTER TABLE agent_instances_v6 ADD COLUMN memory_seq INTEGER NOT NULL DEFAULT 0;`);
      const columns = (db.prepare('PRAGMA table_info(agent_instances_v6)').all() as { name: string }[]).map(c => '"' + c.name + '"').join(',');
      db.exec(`INSERT INTO agent_instances_v6(rowid,${columns}) SELECT rowid,${columns} FROM agent_instances;
        DROP TABLE agent_instances; ALTER TABLE agent_instances_v6 RENAME TO agent_instances; PRAGMA user_version=6;`);
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('FIXTURE_FOREIGN_KEY_FAILED');
    }).immediate();
  } finally { db.pragma('foreign_keys = ON'); }
}
