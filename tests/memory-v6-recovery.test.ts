import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {Store} from '../packages/storage-sqlite/index.js';
import {SessionService} from '../packages/session-service/index.js';
import {backupDatabase,restoreDatabase,inspectDatabase} from '../packages/storage-sqlite/maintenance.js';

const removeV6='DROP TABLE memory_changes; DROP TABLE memory_edges; DROP TABLE memory_metadata; PRAGMA user_version=5;';
const retained=['messages','memories','memory_input_origins','agent_private_states','agent_input_cursors','agent_input_receipts','agent_agenda'] as const;
it('R5-MIGRATION-040: populated V5 upgrades preserve originals, versions and cursors while fencing active work',()=>{
  const dir=mkdtempSync(join(tmpdir(),'memory-v5-upgrade-')),path=join(dir,'state.sqlite');
  const f=fixture(3,{memoryEvery:3},path);let reopened:Store|undefined;
  try{
    const source=f.say('移行前の原文');f.say('二番目');f.say('三番目');f.start();
    f.finish(f.claim()!,{decision:'ABSTAIN',reason:'synthetic'});
    const memory=f.claim()!;expect(memory.kind).toBe('memory');
    f.finish(memory,{notes:[{text:'移行前の出典付き記憶',sourceMessageIds:[source.id]}]});
    f.say('移行前に開始する次の入力');const active=f.claim()!;
    const call=f.service.reserveCall('worker-0',active.workerEpoch,active.id,active.token,randomUUID(),'primary');
    const before=Object.fromEntries(retained.map(table=>[table,f.store.all('SELECT * FROM '+table+' ORDER BY rowid')]));
    const settings=f.service.session(f.id).settings_json;
    // Isolated synthetic V5 fixture only. This is never an operational downgrade procedure.
    f.store.tx(()=>f.store.db.exec(removeV6));f.close();reopened=new Store(path);
    expect(inspectDatabase(path).schemaVersion).toBe(6);
    for(const table of retained)expect(reopened.all('SELECT * FROM '+table+' ORDER BY rowid'),table).toEqual(before[table]);
    expect(reopened.get<{settings_json:string}>('SELECT settings_json FROM sessions WHERE id=?',f.id)!.settings_json).toBe(settings);
    expect(reopened.get<{state:string}>('SELECT state FROM runs WHERE id=?',active.id)!.state).toBe('CANCELLED');
    expect(reopened.get<{status:string}>('SELECT status FROM llm_calls WHERE id=?',call.id)!.status).toBe('ABANDONED');
    const service=new SessionService(reopened,f.config,f.now),notes=service.workerMemories('worker-0',memory.context.self.id);
    expect(notes).toHaveLength(1);expect(notes[0].provenance).toMatchObject({verified:false,meaning:null,evidence:[{kind:'message',id:source.id,version:source.revision}]});
    expect(()=>service.completeRun('worker-0',active.workerEpoch,active.id,active.token,{decision:'ABSTAIN',reason:'obsolete'})).toThrow('STALE_RUN');
  }finally{reopened?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R5-MIGRATION-041: failed V5-to-V6 migration rolls back newly created tables and never replaces the original database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'memory-v6-failure-')),path=join(dir,'state.sqlite'),f=fixture(3,{},path);
  try{
    const source=f.say('移行失敗でも残す原文');
    f.store.tx(()=>f.store.db.exec(removeV6+' CREATE TABLE memory_edges(sentinel TEXT); INSERT INTO memory_edges VALUES (\'preserve\');'));
    f.close();expect(()=>new Store(path)).toThrow();
    const raw=new Database(path);
    try{
      expect(raw.pragma('user_version',{simple:true})).toBe(5);
      expect(raw.prepare('SELECT text FROM messages WHERE id=?').get(source.id)).toEqual({text:source.text});
      expect(raw.prepare('SELECT sentinel FROM memory_edges').get()).toEqual({sentinel:'preserve'});
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_metadata','memory_changes')").all()).toEqual([]);
      raw.exec('DROP TABLE memory_edges;');
    }finally{raw.close();}
    const recovered=new Store(path);try{expect(recovered.get('SELECT text FROM messages WHERE id=?',source.id)).toEqual({text:source.text});expect(inspectDatabase(path).schemaVersion).toBe(6);}finally{recovered.close();}
  }finally{if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R5-MIGRATION-042: an online V6 snapshot restores populated status, dependency edges and audit history exactly',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'memory-v6-backup-')),path=join(dir,'state.sqlite'),f=fixture(3,{},path);let restored:Store|undefined;
  try{
    const source=f.say('保存試験の合成根拠'),owner=f.service.agents(f.id)[0].id,ids=Array.from({length:4},()=>randomUUID());
    const statuses=['ACTIVE','SUPERSEDED','CONFLICT','INVALID'];
    // Storage-layer fixture: semantic operations are covered separately through real run results.
    f.store.tx(()=>{
      ids.forEach((id,i)=>{
        f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',id,owner,'保存対象 '+i,JSON.stringify([source.id]),f.now(),i+1);
        f.store.run('INSERT INTO memory_metadata(memory_id,status,evidence_json,reason) VALUES(?,?,?,?)',id,statuses[i],JSON.stringify([{kind:'message',id:source.id,version:source.revision}]),'SYNTHETIC_STORAGE_FIXTURE');
        f.store.run('INSERT INTO memory_changes(agent_id,kind,old_ids_json,new_id,created_at) VALUES(?,?,?,?,?)',owner,'SYNTHETIC',JSON.stringify(i?[ids[i-1]]:[]),id,f.now());
        if(i)f.store.run('INSERT INTO memory_edges(parent_id,child_id) VALUES(?,?)',ids[i-1],id);
      });
      f.store.run('UPDATE agent_instances SET memory_seq=4 WHERE id=?',owner);
    });
    const tables=[...retained,'memory_metadata','memory_edges','memory_changes'];
    const before=Object.fromEntries(tables.map(table=>[table,f.store.all('SELECT * FROM '+table+' ORDER BY rowid')]));
    const backup=join(dir,'backup.sqlite'),destination=join(dir,'restored.sqlite');
    expect((await backupDatabase(path,backup)).schemaVersion).toBe(6);expect((await restoreDatabase(backup,destination)).integrity).toBe('ok');
    restored=new Store(destination);for(const table of tables)expect(restored.all('SELECT * FROM '+table+' ORDER BY rowid'),table).toEqual(before[table]);
    const service=new SessionService(restored,f.config,f.now);expect(service.workerMemories('worker-0',owner).map(m=>m.id)).toEqual([ids[0],ids[2]]);
  }finally{restored?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});
