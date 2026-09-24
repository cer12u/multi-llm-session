import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA_VERSION } from './schema-version.js';

const coreTables=['characters','workers','sessions','agent_instances','candidates','runs','messages','events','command_receipts','traces','llm_calls','memories','pending_questions','source_items','messages_fts'];
const versionTables:Record<number,string[]>={
  8:['source_versions','source_feeds','source_feed_versions','source_feed_jobs'],
  2:['provider_health','model_profiles'],3:['agent_private_states','agent_state_updates'],
  4:['agent_input_log','agent_input_cursors','agent_input_receipts','memory_input_origins','candidate_state_bindings'],
  5:['agent_agenda','agent_agenda_bindings','agent_agenda_clock'],
  6:['memory_metadata','memory_edges','memory_changes'],
  7:['session_member_changes','message_author_snapshots','session_episodes'],
};
export type StorageReport={schemaVersion:number;sqliteVersion:string;integrity:'ok';foreignKeyViolations:0;
  pageBytes:number;freeBytes:number;fileBytes:number;walBytes:number;rows:Record<string,number>};
function existing(path:string):string {
  const file=resolve(path);
  if(!existsSync(file)||!statSync(file).isFile())throw new Error('STORAGE_SOURCE_NOT_FILE');return file;
}
function openExisting(path:string,readonly=true):Database.Database {
  return new Database(existing(path),{readonly,fileMustExist:true,timeout:5000});
}
function check(db:Database.Database):number {
  const version=db.pragma('user_version',{simple:true}) as number;
  if(!Number.isSafeInteger(version)||version<1||version>CURRENT_SCHEMA_VERSION)throw new Error('STORAGE_SCHEMA_UNSUPPORTED');
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
  const required=[...coreTables,...Object.entries(versionTables).filter(([v])=>Number(v)<=version).flatMap(([,names])=>names)];
  if(required.some(name=>!tables.has(name)))throw new Error('STORAGE_SCHEMA_INCOMPLETE');
  if(version>=7){
    const columns=db.prepare('PRAGMA table_info(agent_instances)').all() as {name:string}[];
    const objects=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')").all() as {name:string}[]).map(x=>x.name));
    if(!columns.some(c=>c.name==='retired_at')||['current_session_worker','message_author_insert','session_episode_create','session_episode_message'].some(name=>!objects.has(name)))throw new Error('STORAGE_SCHEMA_INCOMPLETE');
    if(db.prepare('SELECT m.id FROM messages m LEFT JOIN message_author_snapshots a ON a.message_id=m.id WHERE m.author_id IS NOT NULL AND (a.message_id IS NULL OR a.author_id<>m.author_id) LIMIT 1').get())throw new Error('STORAGE_AUTHOR_SNAPSHOT_INCOMPLETE');
  }
  const integrity=db.pragma('integrity_check') as {integrity_check:string}[];
  if(integrity.length!==1||integrity[0].integrity_check!=='ok')throw new Error('STORAGE_INTEGRITY_FAILED');
  const violations=db.pragma('foreign_key_check');
  if(!Array.isArray(violations)||violations.length)throw new Error('STORAGE_FOREIGN_KEY_FAILED');return version;
}
function size(path:string):number{return existsSync(path)?statSync(path).size:0;}
function report(db:Database.Database,path:string):StorageReport {
  return db.transaction(()=>{
    const version=check(db),rows:Record<string,number>={};
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'messages_fts*' ORDER BY name").all() as {name:string}[]){
      rows[name]=(db.prepare('SELECT COUNT(*) n FROM "'+name.replaceAll('"','""')+'"').get() as {n:number}).n;
    }
    const pageSize=db.pragma('page_size',{simple:true}) as number;
    return {schemaVersion:version,sqliteVersion:(db.prepare('SELECT sqlite_version() version').get() as {version:string}).version,
      integrity:'ok' as const,foreignKeyViolations:0 as const,pageBytes:(db.pragma('page_count',{simple:true}) as number)*pageSize,
      freeBytes:(db.pragma('freelist_count',{simple:true}) as number)*pageSize,fileBytes:size(path),walBytes:size(path+'-wal'),rows};
  }).deferred();
}
export function inspectDatabase(source:string):StorageReport {
  const path=existing(source),db=openExisting(path);try{return report(db,path);}finally{db.close();}
}
/** SQLite backup API includes committed WAL data; never copy only the live .sqlite file. Destination is create-only. */
export async function backupDatabase(source:string,destination:string):Promise<StorageReport>{
  const src=existing(source),target=resolve(destination);
  if(src===target||existsSync(target))throw new Error('STORAGE_DESTINATION_EXISTS');
  const db=openExisting(src);let temporary:string|undefined;
  try{
    check(db);mkdirSync(dirname(target),{recursive:true});temporary=target+'.partial-'+randomUUID();
    closeSync(openSync(temporary,'wx',0o600));await db.backup(temporary);
    const completed=openExisting(temporary,false);
    try{completed.pragma('journal_mode = DELETE');check(completed);}finally{completed.close();}
    chmodSync(temporary,0o600);const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    linkSync(temporary,target);unlinkSync(temporary);temporary=undefined;
    const dir=openSync(dirname(target),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
    return inspectDatabase(target);
  }finally{
    db.close();if(temporary){for(const suffix of ['', '-wal', '-shm','-journal'])if(existsSync(temporary+suffix))unlinkSync(temporary+suffix);}
  }
}
/** Restore to a new path. Existing operational DB/WAL files are never replaced automatically. */
export async function restoreDatabase(backup:string,destination:string):Promise<StorageReport>{return backupDatabase(backup,destination);}
/** Explicit offline operation, not an additional long-running DB writer. Caller must stop Core and workers first. */
export function maintainDatabase(source:string,acknowledgeOffline:boolean):StorageReport {
  if(!acknowledgeOffline)throw new Error('STORAGE_OFFLINE_ACK_REQUIRED');
  const path=existing(source),db=openExisting(path,false);
  try{
    if(check(db)!==CURRENT_SCHEMA_VERSION)throw new Error('STORAGE_UPGRADE_REQUIRED');
    db.pragma('foreign_keys = ON');
    db.transaction(()=>{
      db.exec('DELETE FROM messages_fts; INSERT INTO messages_fts(message_id,session_id,text) SELECT id,session_id,text FROM messages WHERE deleted=0; REINDEX;');
    }).immediate();
    db.exec('VACUUM');return report(db,path);
  }finally{db.close();}
}
