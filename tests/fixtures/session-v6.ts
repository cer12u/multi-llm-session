import type Database from 'better-sqlite3';
import {asV7Fixture} from './source-v7.js';

/** Test-only: recreate the exact pre-membership schema on isolated synthetic fixtures.
 * No retired instances may exist. Never import this helper from application or deployment code.
 */
export function asV6Fixture(db:Database.Database):void{
  if(db.pragma('user_version',{simple:true})===8)asV7Fixture(db);
  if(db.inTransaction||db.pragma('user_version',{simple:true})!==7)throw new Error('EXPECTED_ISOLATED_V7_FIXTURE');
  if(db.prepare('SELECT id FROM agent_instances WHERE retired_at IS NOT NULL LIMIT 1').get())throw new Error('RETIRED_DATA_CANNOT_BE_DOWNGRADED');
  const source=(db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_instances' AND type='table'").get() as {sql:string}).sql;
  const withoutNew=source.replace(/,\s*retired_at INTEGER\s*,\s*CHECK\(retired_at IS NULL OR enabled=0\)/i,'');
  if(withoutNew===source)throw new Error('V7_FIXTURE_SCHEMA_MISMATCH');
  const create=withoutNew.replace(/^CREATE TABLE\s+["`\[]?agent_instances["`\]]?/i,'CREATE TABLE isolated_v6_agents').replace(/\)\s*$/,', UNIQUE(session_id,slot))');
  const columns=(db.prepare('PRAGMA table_info(agent_instances)').all() as {name:string}[]).filter(c=>c.name!=='retired_at').map(c=>'"'+c.name.replaceAll('"','""')+'"').join(',');
  const extras=db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='agent_instances' AND type IN ('index','trigger') AND sql IS NOT NULL AND name<>'current_session_worker'").all() as {name:string;sql:string}[];
  const foreignKeys=db.pragma('foreign_keys',{simple:true});db.pragma('foreign_keys = OFF');
  try{db.transaction(()=>{
    db.exec(`DROP TRIGGER message_author_insert; DROP TRIGGER session_episode_create; DROP TRIGGER session_episode_message;
      DROP TABLE session_member_changes; DROP TABLE message_author_snapshots; DROP TABLE session_episodes;`);
    db.exec(create);
    db.exec(`INSERT INTO isolated_v6_agents(rowid,${columns}) SELECT rowid,${columns} FROM agent_instances ORDER BY rowid;
      DROP TABLE agent_instances; ALTER TABLE isolated_v6_agents RENAME TO agent_instances;`);
    for(const extra of extras)db.exec(extra.sql);
    if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('V6_FIXTURE_FOREIGN_KEY_FAILED');
    db.pragma('user_version = 6');
  }).immediate();}finally{db.pragma('foreign_keys = '+(foreignKeys?'ON':'OFF'));}
}
