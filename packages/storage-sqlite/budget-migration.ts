import type Database from 'better-sqlite3';
import {diagnosticProjection,installDiagnosticTriggers} from './diagnostic-migration.js';

/** New tables only: old run/state/history columns and V9 journal frames are unchanged. */
export function migrateBudgets(db:Database.Database):void{
  if(db.pragma('user_version',{simple:true})!==9)throw new Error('BUDGET_MIGRATION_REQUIRES_V9');
  db.transaction(()=>{
    db.exec(`CREATE TABLE budget_windows(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),
      started_at INTEGER NOT NULL,ends_at INTEGER,ended_at INTEGER,reason TEXT NOT NULL,
      policy_json TEXT,call_start INTEGER NOT NULL,post_start INTEGER NOT NULL,call_boundary INTEGER NOT NULL);
      CREATE UNIQUE INDEX budget_current_window ON budget_windows(session_id) WHERE ended_at IS NULL;
      CREATE INDEX budget_session_windows ON budget_windows(session_id,started_at);
      CREATE TABLE call_budgets(
      call_id TEXT PRIMARY KEY REFERENCES llm_calls(id),session_id TEXT NOT NULL REFERENCES sessions(id),
      window_id TEXT NOT NULL REFERENCES budget_windows(id),scope TEXT NOT NULL,started_at INTEGER NOT NULL,
      estimated_input INTEGER NOT NULL CHECK(estimated_input>=0),reserved_output INTEGER NOT NULL CHECK(reserved_output>=0),
      charged_tokens INTEGER NOT NULL CHECK(charged_tokens>=0),usage_kind TEXT NOT NULL CHECK(usage_kind IN ('reserved','reported','estimated')));
      CREATE INDEX budget_scope_calls ON call_budgets(scope,started_at);
      CREATE INDEX budget_window_calls ON call_budgets(window_id);`);
    const projection=diagnosticProjection(db);
    // New tables are empty: their first real mutation is INSERT, not fabricated historical usage.
    installDiagnosticTriggers(db,projection.filter(p=>p.table==='budget_windows'||p.table==='call_budgets'));
    db.prepare('UPDATE diagnostic_projection SET definition_json=? WHERE version=1').run(JSON.stringify(projection));
    db.pragma('user_version=10');
  }).immediate();
}
