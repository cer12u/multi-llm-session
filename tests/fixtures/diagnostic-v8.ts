import type Database from 'better-sqlite3';
import {diagnosticTables,budgetDiagnosticTables} from '../../packages/storage-sqlite/diagnostic-migration.js';
/** Isolated synthetic downgrade fixture only. Never import into runtime or restoration code. */
export function asV8Fixture(db:Database.Database):void {
  if(db.inTransaction||Number(db.pragma('user_version',{simple:true}))<9)throw new Error('EXPECTED_ISOLATED_V9_FIXTURE');
  db.transaction(()=>{
    if(Number(db.pragma('user_version',{simple:true}))>=10){
      for(const table of budgetDiagnosticTables)for(const suffix of ['i','u','d'])db.exec(`DROP TRIGGER diagnostic_${table}_${suffix}`);
      db.exec('DROP TABLE call_budgets; DROP TABLE budget_windows;');
    }
    for(const table of diagnosticTables)for(const suffix of ['i','u','d'])db.exec(`DROP TRIGGER diagnostic_${table}_${suffix}`);
    db.exec('DROP TABLE diagnostic_journal; DROP TABLE diagnostic_projection; PRAGMA user_version=8;');
  }).immediate();
}
