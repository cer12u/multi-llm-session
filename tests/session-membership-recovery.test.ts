import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {fixture} from './helpers.js';
import {saveOwnerExperience,selection,replace} from './fixtures/membership.js';
import {asV6Fixture} from './fixtures/session-v6.js';
import {Store} from '../packages/storage-sqlite/index.js';
import {SessionService} from '../packages/session-service/index.js';
import {migrateSessions} from '../packages/storage-sqlite/session-migration.js';
import {backupDatabase,restoreDatabase,inspectDatabase} from '../packages/storage-sqlite/maintenance.js';

it('R7-MEMBERS-005: populated V6 upgrade preserves owner IDs, row order, original messages and every private dependency',()=>{
  const dir=mkdtempSync(join(tmpdir(),'membership-v6-')),path=join(dir,'live.sqlite'),f=fixture(3,{memoryEvery:3},path);let reopened:Store|undefined;
  try{
    const {owner}=saveOwnerExperience(f);f.say('移行前の発言');f.speak(f.claim()!);f.finish(f.claim()!,{decision:'DRAFT',text:'作者の版を固定する原文'});
    const published=f.service.commitNext(f.id)!;expect(published.authorId).toBe(owner);
    f.say('未完了のモデル呼出し');const active=f.claim()!;
    const call=f.service.reserveCall('worker-0',active.workerEpoch,active.id,active.token,randomUUID(),'primary');
    const retained=['messages','memories','memory_metadata','memory_edges','memory_changes','memory_input_origins','agent_private_states','agent_state_updates','agent_input_cursors','agent_input_receipts','agent_agenda','agent_agenda_bindings','agent_agenda_clock','source_items','command_receipts'];
    const before=Object.fromEntries(retained.map(table=>[table,f.store.all('SELECT * FROM '+table+' ORDER BY rowid')]));
    const agents=f.store.all<{id:string;rowid:number;character_json:string;profile_json:string}>('SELECT rowid,id,character_json,profile_json FROM agent_instances ORDER BY rowid');
    asV6Fixture(f.store.db);expect(f.store.db.pragma('user_version',{simple:true})).toBe(6);
    expect(f.store.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='agent_instances'")!.sql).toContain('UNIQUE(session_id,slot)');
    f.close();reopened=new Store(path);
    expect(inspectDatabase(path).schemaVersion).toBe(7);expect(reopened.db.pragma('foreign_keys',{simple:true})).toBe(1);
    expect(reopened.all('SELECT rowid,id,character_json,profile_json FROM agent_instances ORDER BY rowid')).toEqual(agents);
    for(const table of retained)expect(reopened.all('SELECT * FROM '+table+' ORDER BY rowid'),table).toEqual(before[table]);
    expect(reopened.get<{state:string}>('SELECT state FROM runs WHERE id=?',active.id)!.state).toBe('CANCELLED');
    expect(reopened.get<{status:string}>('SELECT status FROM llm_calls WHERE id=?',call.id)!.status).toBe('ABANDONED');
    const service=new SessionService(reopened,f.config,f.now);service.recover();
    expect(service.archiveMessage(f.id,published.id)).toEqual(published);
    expect(service.membership(f.id).archived).toEqual([]);expect(service.episodes(f.id)[0].origin).toBe('existing-message-boundaries');
    expect(()=>service.completeRun('worker-0',active.workerEpoch,active.id,active.token,{decision:'ABSTAIN',reason:'old'})).toThrow();
    expect(reopened.db.pragma('foreign_key_check')).toEqual([]);
  }finally{reopened?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R7-MEMBERS-006: failure after rebuilding the Agent table rolls back all V7 mutations and restores foreign-key enforcement',()=>{
  const dir=mkdtempSync(join(tmpdir(),'membership-failure-')),path=join(dir,'live.sqlite'),f=fixture(3,{memoryEvery:3},path);
  try{
    const {owner,original}=saveOwnerExperience(f);asV6Fixture(f.store.db);
    const schema=f.store.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='agent_instances'")!.sql;
    const agents=f.store.all('SELECT rowid,* FROM agent_instances ORDER BY rowid'),memory=f.store.all('SELECT * FROM memories'),state=f.store.all('SELECT * FROM agent_private_states');
    f.store.db.exec("CREATE TABLE session_member_changes(sentinel TEXT); INSERT INTO session_member_changes VALUES('keep');");
    expect(()=>migrateSessions(f.store.db)).toThrow();
    expect(f.store.db.pragma('user_version',{simple:true})).toBe(6);expect(f.store.db.pragma('foreign_keys',{simple:true})).toBe(1);
    expect(f.store.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='agent_instances'")!.sql).toBe(schema);
    expect(f.store.all('SELECT rowid,* FROM agent_instances ORDER BY rowid')).toEqual(agents);
    expect(f.store.all('SELECT * FROM memories')).toEqual(memory);expect(f.store.all('SELECT * FROM agent_private_states')).toEqual(state);
    expect(f.store.get('SELECT sentinel FROM session_member_changes')).toEqual({sentinel:'keep'});
    expect(f.store.all("SELECT name FROM sqlite_master WHERE name IN ('agent_instances_v7','message_author_snapshots','session_episodes','current_session_worker')")).toEqual([]);
    expect(()=>f.store.run('UPDATE memories SET agent_id=? WHERE agent_id=?',randomUUID(),owner)).toThrow();
    f.store.db.exec('DROP TABLE session_member_changes;');migrateSessions(f.store.db);
    expect(f.store.db.pragma('user_version',{simple:true})).toBe(7);expect(f.service.archiveMessage(f.id,original.id).text).toBe(original.text);
    expect(f.store.db.pragma('foreign_key_check')).toEqual([]);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R7-MEMBERS-007: V7 online backup restores current/retired ownership, journals, authorship and episodes exactly across Core restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'membership-restore-')),path=join(dir,'live.sqlite'),f=fixture(3,{memoryEvery:3},path);let restored:Store|undefined;
  try{
    const {owner,original}=saveOwnerExperience(f);f.say('退出前の原文');f.speak(f.claim()!);f.finish(f.claim()!,{decision:'DRAFT',text:'退出者が投稿した記録'});
    const published=f.service.commitNext(f.id)!;f.service.lifecycle(f.id,'pause',randomUUID());
    const command=selection(f);command.participants[0]=replace(command.participants[0],{id:f.config.characters[1].id,version:1});
    const report=f.service.updateMembership(f.id,command,randomUUID());f.advance(10000);f.say('境界を越えた原文');
    const retained=['agent_instances','agent_private_states','agent_state_updates','memories','memory_metadata','memory_edges','memory_changes','agent_input_cursors','agent_agenda','agent_agenda_bindings','session_member_changes','message_author_snapshots','session_episodes'];
    const before=Object.fromEntries(retained.map(table=>[table,f.store.all('SELECT * FROM '+table+' ORDER BY rowid')]));
    const backup=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite');
    expect((await backupDatabase(path,backup)).schemaVersion).toBe(7);await restoreDatabase(backup,destination);
    restored=new Store(destination);const service=new SessionService(restored,{...f.config,dbPath:destination},f.now,()=>0);service.recover();
    for(const table of retained)expect(restored.all('SELECT * FROM '+table+' ORDER BY rowid'),table).toEqual(before[table]);
    expect(service.session(f.id).lifecycle).toBe('PAUSED');expect(service.membership(f.id).current.map(r=>r.agent.id)).toEqual(report.current.map(r=>r.agent.id));
    expect(service.membership(f.id).archived[0].agent.id).toBe(owner);expect(service.archiveMessage(f.id,published.id)).toEqual(published);
    expect(service.archiveMessage(f.id,original.id).text).toBe(original.text);expect(service.episodes(f.id)).toHaveLength(2);
    expect(()=>service.workerMemories('worker-0',owner)).toThrow('PRIVATE_STATE_FORBIDDEN');
    const epoch=service.registerWorker('worker-0').epoch;expect(service.claim('worker-0',epoch)).toBeNull();
    service.lifecycle(f.id,'resume',randomUUID());const run=service.claim('worker-0',epoch)!;
    expect(run.context.self.id).not.toBe(owner);expect(JSON.stringify(run.context)).not.toContain('OWNER_PRIVATE_');
    expect(service.session(f.id).call_count).toBe(f.service.session(f.id).call_count);
    const malformed=join(dir,'malformed.sqlite');await backupDatabase(backup,malformed);
    const raw=new Database(malformed);raw.exec('DROP TRIGGER message_author_insert;');raw.close();
    expect(()=>inspectDatabase(malformed)).toThrow('STORAGE_SCHEMA_INCOMPLETE');
    await expect(restoreDatabase(malformed,join(dir,'must-not-exist.sqlite'))).rejects.toThrow('STORAGE_SCHEMA_INCOMPLETE');
  }finally{restored?.close();f.close();rmSync(dir,{recursive:true,force:true});}
},20000);
