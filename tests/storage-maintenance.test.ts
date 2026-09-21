import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { backupDatabase, inspectDatabase, maintainDatabase, restoreDatabase } from '../packages/storage-sqlite/maintenance.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { ModelProfileSchema, type PublicMessage } from '../packages/contracts/index.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function directory(){const dir=mkdtempSync(join(tmpdir(),'storage-acceptance-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(settings:Parameters<typeof fixture>[1]={}){const dir=directory(),f=fixture(3,settings,join(dir,'live','session.sqlite'));cleanup.push(()=>{if(f.store.db.open)f.close();});return {...f,dir};}

it('R10-STORAGE-002: online SQLite backup includes committed WAL, restores every current owner/state/cursor/agenda/circuit and preserves pause',async()=>{
  const f=setup({memoryEvery:3});const key=randomUUID();
  const original=f.service.humanMessage(f.id,{text:'復元する原文'},key);f.say('二つ目');f.say('三つ目');f.start();
  const r=f.claim()!,s=r.context.self.privateState!;
  f.finish(r,{action:{decision:'ABSTAIN',reason:'黙って予定を保持'},statePatch:{agentId:s.agentId,sessionId:f.id,expectedVersion:s.version,observationId:r.context.observation!.id,
    upsert:[{id:'restore-intention',kind:'intention',text:'本人だけの復元対象',evidence:[{kind:'message',id:original.id,version:original.revision}],resume:{kind:'time',agentId:null,topic:null,notBefore:f.now()+60000}}],remove:[]}});
  const memory=f.claim()!;expect(memory.kind).toBe('memory');
  f.finish(memory,{notes:[{text:'復元後に検索する記憶',sourceMessageIds:[original.id]}]});
  const provider=ModelProfileSchema.parse({id:'backup-provider',provider:'openai',model:'synthetic',baseUrl:'https://synthetic.invalid/v1',apiKeyEnv:'SYNTHETIC_BACKUP_KEY'});
  f.service.putModelProfile(provider);f.service.providers.finish(provider,'synthetic-failure','AUTH_ERROR');
  f.service.lifecycle(f.id,'pause',randomUUID());
  const state=f.store.get('SELECT * FROM agent_private_states WHERE agent_id=?',s.agentId);
  const cursor=f.store.get('SELECT * FROM agent_input_cursors WHERE agent_id=?',s.agentId);
  const agenda=f.store.all('SELECT * FROM agent_agenda WHERE agent_id=?',s.agentId);
  const origins=f.store.all('SELECT * FROM memory_input_origins');
  const backup=join(f.dir,'backups','consistent.sqlite'),restored=join(f.dir,'restored','session.sqlite');
  const promise=backupDatabase(f.config.dbPath,backup);
  // The writer remains open and may commit while backup runs; target must be a complete valid snapshot, not a raw main-file copy.
  f.say('オンラインbackup中の独立した確定');const recorded=await promise;
  expect(recorded.integrity).toBe('ok');expect(recorded.rows.messages).toBeGreaterThanOrEqual(3);expect(recorded.rows.messages).toBeLessThanOrEqual(4);
  expect(statSync(backup).mode&0o077).toBe(0);
  await restoreDatabase(backup,restored);
  const db=new Store(restored);cleanup.push(()=>db.close());const service=new SessionService(db,{...f.config,dbPath:restored},f.now);service.recover();
  expect(service.session(f.id).lifecycle).toBe('PAUSED');expect(service.session(f.id).stop_reason).toBe('USER_PAUSED');
  expect(db.get('SELECT * FROM agent_private_states WHERE agent_id=?',s.agentId)).toEqual(state);
  expect(db.get('SELECT * FROM agent_input_cursors WHERE agent_id=?',s.agentId)).toEqual(cursor);
  expect(db.all('SELECT * FROM agent_agenda WHERE agent_id=?',s.agentId)).toEqual(agenda);
  expect(db.all('SELECT * FROM memory_input_origins')).toEqual(origins);
  expect(service.pages.memories(s.agentId,'復元後').items).toHaveLength(1);
  expect(service.providers.status(provider).state).toBe('BLOCKED');
  expect(service.humanMessage(f.id,{text:'復元する原文'},key).id).toBe(original.id);
  const transcript=service.exportSession(f.id).transcript as PublicMessage[];
  expect(transcript.filter(m=>m.id===original.id)).toHaveLength(1);
  expect(transcript.map(m=>m.sequence)).toEqual([...transcript.map(m=>m.sequence)].sort((a,b)=>a-b));
  const epoch=service.registerWorker('worker-0').epoch;expect(service.claim('worker-0',epoch)).toBeNull();
  expect(service.session(f.id).call_count).toBe(2);
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/storage-restore-summary.json',JSON.stringify({mode:'synthetic',snapshot:recorded,restored:inspectDatabase(restored)},null,2));
});

it('R10-STORAGE-003: absent, corrupt, unrelated or incomplete backups never replace an existing destination or initialize a source',async()=>{
  const f=setup(),target=join(f.dir,'existing.sqlite');writeFileSync(target,'KEEP EXISTING DESTINATION');
  await expect(backupDatabase(f.config.dbPath,target)).rejects.toThrow('STORAGE_DESTINATION_EXISTS');
  expect(readFileSync(target,'utf8')).toBe('KEEP EXISTING DESTINATION');
  const absent=join(f.dir,'absent.sqlite');await expect(backupDatabase(absent,join(f.dir,'not-created.sqlite'))).rejects.toThrow('STORAGE_SOURCE_NOT_FILE');expect(existsSync(absent)).toBe(false);
  const corrupt=join(f.dir,'corrupt.sqlite');writeFileSync(corrupt,'not a sqlite database');const output=join(f.dir,'must-not-exist.sqlite');
  await expect(restoreDatabase(corrupt,output)).rejects.toThrow();expect(existsSync(output)).toBe(false);expect(readFileSync(corrupt,'utf8')).toBe('not a sqlite database');
  const foreign=join(f.dir,'foreign.sqlite'),db=new Database(foreign);db.exec('CREATE TABLE keep(id TEXT); PRAGMA user_version=5;');db.close();
  await expect(restoreDatabase(foreign,output)).rejects.toThrow('STORAGE_SCHEMA_INCOMPLETE');expect(existsSync(output)).toBe(false);
  await expect(backupDatabase(f.config.dbPath,f.config.dbPath)).rejects.toThrow('STORAGE_DESTINATION_EXISTS');
});

it('R10-STORAGE-004: reindex and VACUUM preserve stable message identities, owner data and old memory without changing budget or retention',()=>{
  const f=setup();const messages=Array.from({length:1205},(_,i)=>f.say('索引復旧の原文 '+i)),agent=f.service.agents(f.id)[0];
  for(let i=0;i<300;i++)f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',randomUUID(),agent.id,'保持する旧記憶 '+i,JSON.stringify([messages[0].id]),f.now(),i+1);
  f.store.run('UPDATE agent_instances SET memory_seq=300 WHERE id=?',agent.id);
  for(let i=0;i<1000;i++)f.store.run('INSERT INTO traces(session_id,code,detail,created_at) VALUES(?,?,?,?)',f.id,'SYNTHETIC_STORAGE_VOLUME','{}',f.now());
  const before=f.service.exportSession(f.id),memory=f.service.workerMemories(agent.slot,agent.id);
  f.store.run('DELETE FROM messages_fts');expect(f.service.searchArchive(f.id,'索引復旧')).toHaveLength(0);f.close();
  expect(()=>maintainDatabase(f.config.dbPath,false)).toThrow('STORAGE_OFFLINE_ACK_REQUIRED');
  const report=maintainDatabase(f.config.dbPath,true);
  const db=new Store(f.config.dbPath);cleanup.push(()=>db.close());const service=new SessionService(db,f.config,f.now);
  expect(service.exportSession(f.id)).toEqual(before);expect(service.workerMemories(agent.slot,agent.id)).toEqual(memory);
  expect(service.searchArchive(f.id,'索引復旧')).toHaveLength(50);expect(service.pages.memories(agent.id,'保持する旧記憶 0').items).toHaveLength(1);
  expect(report.rows.messages).toBe(1205);expect(report.rows.memories).toBe(300);expect(report.rows.traces).toBe(1000);expect(report.pageBytes).toBeGreaterThan(0);
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/storage-volume-summary.json',JSON.stringify({mode:'synthetic',report,liveLLM:false,longDurationClaim:false},null,2));
});

it('R10-STORAGE-005: SQLite capacity failure rolls back the transaction and never silently recreates the database',()=>{
  const f=setup();const original=f.say('容量不足でも保持する');
  const oldMaximum=f.store.db.pragma('max_page_count',{simple:true}) as number;
  const pages=f.store.db.pragma('page_count',{simple:true}) as number;f.store.db.pragma('max_page_count = '+(pages+2));
  expect(()=>f.store.tx(()=>f.store.run('INSERT INTO traces(session_id,code,detail,created_at) VALUES(?,?,?,?)',f.id,'MUST_ROLL_BACK','x'.repeat(2000000),f.now()))).toThrow();
  expect(f.store.all("SELECT * FROM traces WHERE code='MUST_ROLL_BACK'")).toHaveLength(0);
  expect(f.service.snapshot(f.id).messages[0].id).toBe(original.id);
  f.store.db.pragma('max_page_count = '+oldMaximum);f.say('容量回復後');expect(f.service.snapshot(f.id).messages).toHaveLength(2);
  expect(f.store.db.pragma('user_version',{simple:true})).toBe(5);
});

it('R10-STORAGE-006: a failed populated V2 migration leaves its committed schema and records intact for explicit repair',()=>{
  const f=setup();const original=f.say('移行失敗でも保持');
  f.store.db.exec(`DROP TABLE agent_agenda_bindings; DROP TABLE agent_agenda_clock; DROP TABLE agent_agenda;
    DROP TRIGGER input_message_insert; DROP TRIGGER input_message_update; DROP TRIGGER input_source_insert;
    DROP TABLE memory_input_origins; DROP TABLE candidate_state_bindings; DROP TABLE agent_input_receipts;
    DROP TABLE agent_input_cursors; DROP TABLE agent_input_log; DROP TABLE agent_state_updates; DROP TABLE agent_private_states;
    CREATE TABLE agent_private_states(conflict TEXT); PRAGMA user_version=2;`);f.close();
  expect(()=>new Store(f.config.dbPath)).toThrow();
  const db=new Database(f.config.dbPath,{fileMustExist:true});
  try{
    expect(db.pragma('user_version',{simple:true})).toBe(2);
    expect(db.prepare('SELECT id,text FROM messages WHERE id=?').get(original.id)).toEqual({id:original.id,text:original.text});
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='agent_state_updates'").get()).toBeUndefined();
    // Repair only this synthetic conflicting object, then exercise the normal upgrade again.
    db.exec('DROP TABLE agent_private_states;');
  }finally{db.close();}
  const restored=new Store(f.config.dbPath);cleanup.push(()=>restored.close());
  expect(restored.db.pragma('user_version',{simple:true})).toBe(5);
  expect(restored.get<{id:string}>('SELECT id FROM messages WHERE id=?',original.id)!.id).toBe(original.id);
});
