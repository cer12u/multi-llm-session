import type Database from 'better-sqlite3';

/** Synthetic test fixture only; never use as an operational downgrade. */
export function asV7Fixture(db:Database.Database):void {
  if(db.inTransaction||db.pragma('user_version',{simple:true})!==8)throw new Error('EXPECTED_ISOLATED_V8_FIXTURE');
  for(const table of ['source_items','source_versions','source_feeds','source_feed_versions','source_feed_jobs'])
    if(db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())throw new Error('V8_SOURCE_DATA_CANNOT_BE_DOWNGRADED');
  db.transaction(()=>{
    db.exec(`DROP TRIGGER input_source_revision; DROP TRIGGER input_source_insert;
      DROP TABLE source_feed_jobs; DROP TABLE source_feed_versions; DROP TABLE source_feeds; DROP TABLE source_versions;
      ALTER TABLE source_items DROP COLUMN audience_json; ALTER TABLE source_items DROP COLUMN enabled;
      ALTER TABLE source_items DROP COLUMN version;
      CREATE TRIGGER input_source_insert AFTER INSERT ON source_items BEGIN
        INSERT INTO agent_input_log(session_id,kind,entity_id,version,created_at)
        VALUES(NEW.session_id,'source',NEW.id,NEW.fetched_at,NEW.fetched_at); END;
      PRAGMA user_version=7;`);
  }).immediate();
}
