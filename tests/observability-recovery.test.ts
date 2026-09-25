import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './helpers.js';
import {asV8Fixture} from './fixtures/diagnostic-v8.js';
import {Store} from '../packages/storage-sqlite/index.js';
import {SessionService} from '../packages/session-service/index.js';
import {migrateDiagnostics,checkDiagnosticStructure} from '../packages/storage-sqlite/diagnostic-migration.js';
import {diagnosticExport,diagnosticSnapshot} from '../packages/observability/index.js';
import {ReplayStream} from '../packages/observability/replay.js';
import {backupDatabase,restoreDatabase,inspectDatabase} from '../packages/storage-sqlite/maintenance.js';

async function reconstruct(service:SessionService,id:string){const replay=new ReplayStream();for await(const line of diagnosticExport(service,id).lines())replay.push(line.trimEnd());return replay.finish();}

it('R10-DIAG-006: populated V8 migration is a truthful baseline, preserving owners, originals and active runs before normal restart fencing',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diagnostic-migration-')),path=join(dir,'live.sqlite'),f=fixture(3,{selfWakeEnabled:false},path);let db:Store|undefined;
  try{
    const original=f.say('retained V8 original');f.service.injectSource(f.id,{title:'PRIVATE_V8_SOURCE',text:'private retained material',audience:[f.service.agents(f.id)[0].id]},randomUUID());
    f.start();const run=f.claim()!;asV8Fixture(f.store.db);const expected=[...diagnosticSnapshot(f.store,f.id),{table:'budget_windows',rows:[]},{table:'call_budgets',rows:[]}];f.close();
    db=new Store(path);checkDiagnosticStructure(db.db);
    expect(diagnosticSnapshot(db,f.id)).toEqual(expected);
    expect(db.all<{kind:string}>('SELECT kind FROM diagnostic_journal').every(row=>row.kind==='BASELINE')).toBe(true);
    const service=new SessionService(db,f.config,f.now,()=>0);let result=await reconstruct(service,f.id);
    expect(result.state).toEqual(expected);expect(result.header.baselineRecords).toBe(result.records);expect(result.records).toBeGreaterThan(0);
    service.recover();const epoch=service.registerWorker('worker-0').epoch,next=service.claim('worker-0',epoch)!;
    expect(next.id).not.toBe(run.id);expect(service.archiveMessage(f.id,original.id).text).toBe('retained V8 original');
    expect(()=>service.completeRun('worker-0',run.workerEpoch,run.id,run.token,{decision:'ABSTAIN',reason:'old'})).toThrow();
    result=await reconstruct(service,f.id);expect(result.state).toEqual(diagnosticSnapshot(db,f.id));expect(result.records).toBeGreaterThan(result.header.baselineRecords);
  }finally{db?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R10-DIAG-007: diagnostic migration failure rolls back baseline, triggers and version; retry preserves originals',()=>{
  const f=fixture();try{
    const message=f.say('do not lose this');asV8Fixture(f.store.db);const before=diagnosticSnapshot(f.store,f.id);
    f.store.db.exec("CREATE INDEX diagnostic_session_seq ON messages(session_id,sequence);");
    expect(()=>migrateDiagnostics(f.store.db)).toThrow();expect(f.store.db.pragma('user_version',{simple:true})).toBe(8);
    expect(diagnosticSnapshot(f.store,f.id)).toEqual(before);
    expect(f.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('diagnostic_projection','diagnostic_journal')")).toEqual([]);
    expect(f.store.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'diagnostic_%'")).toEqual([]);
    f.store.db.exec('DROP INDEX diagnostic_session_seq');migrateDiagnostics(f.store.db);checkDiagnosticStructure(f.store.db);
    expect(f.service.archiveMessage(f.id,message.id).text).toBe('do not lose this');expect(f.store.db.pragma('user_version',{simple:true})).toBe(9);
  }finally{f.close();}
});

it('R10-DIAG-008: exact online backup/restore includes committed journal and restart transitions; incomplete audit structure is refused',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'diagnostic-restore-')),path=join(dir,'live.sqlite'),f=fixture(3,{selfWakeEnabled:false},path);let db:Store|undefined;
  try{
    f.say('source');f.start();const run=f.claim()!;f.finish(run,{decision:'ABSTAIN',reason:'quiet'});f.service.lifecycle(f.id,'pause',randomUUID());
    const before=diagnosticSnapshot(f.store,f.id),journal=f.store.all('SELECT * FROM diagnostic_journal ORDER BY seq');
    const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored.sqlite');expect((await backupDatabase(path,backup)).schemaVersion).toBe(10);
    await restoreDatabase(backup,restored);db=new Store(restored);
    expect(diagnosticSnapshot(db,f.id)).toEqual(before);expect(db.all('SELECT * FROM diagnostic_journal ORDER BY seq')).toEqual(journal);
    const service=new SessionService(db,{...f.config,dbPath:restored},f.now,()=>0);service.recover();
    expect((await reconstruct(service,f.id)).state).toEqual(diagnosticSnapshot(db,f.id));expect(service.session(f.id).lifecycle).toBe('PAUSED');
    db.db.exec('DROP TRIGGER diagnostic_runs_i');expect(()=>inspectDatabase(restored)).toThrow('STORAGE_SCHEMA_INCOMPLETE');
    const rejected=join(dir,'rejected.sqlite');await expect(restoreDatabase(restored,rejected)).rejects.toThrow('STORAGE_SCHEMA_INCOMPLETE');expect(existsSync(rejected)).toBe(false);
  }finally{db?.close();f.close();rmSync(dir,{recursive:true,force:true});}
});
