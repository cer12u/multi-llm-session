import Database from 'better-sqlite3';
import { migrate } from './migrations.js';
import { CURRENT_SCHEMA_VERSION } from './schema-version.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ModelProfileSchema, type Character, type ModelProfile, type Settings, type RunKind, type Intent } from '../contracts/index.js';

export type SessionRow = { id: string; title: string; lifecycle: 'DRAFT'|'RUNNING'|'PAUSED'|'ENDED';
  activity: 'ACTIVE'|'QUIET'|'DEGRADED'|'BUDGET_PAUSED'; revision: number; epoch: number;
  created_at: number; started_at: number|null; last_activity_at: number; last_post_at: number;
  settings_json: string; call_count: number; bot_count: number; stop_reason: string|null; episode: number; active_elapsed_ms: number; active_since: number|null; window_call_start: number; window_post_start: number };
export type AgentRow = { id: string; session_id: string; slot: string; character_json: string; profile_json: string;
  enabled: number; processed_revision: number; dirty_revision: number; wake_seq: number; processed_wake: number;
  pending_since: number|null; due_at: number|null; trigger: string; idle_checked: number; next_self_at: number;
  last_post_at: number; error_count: number; state: string; memory_revision: number; deferral_json: string|null; retry_at: number|null; last_error: string|null };
export type CandidateRow = { id: string; agent_id: string; session_id: string; version: number; state: string;
  intent_json: string; text: string|null; reviewed_revision: number; reviewed_wake: number; first_interested_at: number;
  not_before: number; review_due_at: number; defer_json: string|null; reason: string|null };
export type RunRow = { id: string; agent_id: string; session_id: string; slot: string; worker_epoch: number;
  session_epoch: number; kind: RunKind; token: string; state: string; snapshot_revision: number; wake_seq: number;
  candidate_id: string|null; candidate_version: number|null; created_at: number; lease_until: number;
  retrieval_count: number; context_json: string; result_hash: string|null; result_json: string|null };
export type MessageRow = { sequence: number; thread_root: string; id: string; session_id: string; revision: number; author_id: string|null; text: string;
  act: string; reply_to: string|null; addressed_json: string; candidate_id: string|null; deleted: number;
  episode: number; created_at: number };
export type CallRow = { id: string; run_id: string; request_key: string; scope: string; stage: string; status: string;
  started_at: number; expires_at: number; finished_at: number|null; input_tokens: number|null; output_tokens: number|null;
  error_code: string|null; result_hash: string|null };
export const characterOf = (a: AgentRow) => JSON.parse(a.character_json) as Character;
export const profileOf = (a: AgentRow) => ModelProfileSchema.parse(JSON.parse(a.profile_json));
export const settingsOf = (s: SessionRow) => JSON.parse(s.settings_json) as Settings;
export const intentOf = (c: CandidateRow) => JSON.parse(c.intent_json) as Intent;

export const legacySchemaV1 = `
CREATE TABLE characters(id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE workers(slot TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('DRAFT','RUNNING','PAUSED','ENDED')),
 activity TEXT NOT NULL DEFAULT 'ACTIVE', revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, started_at INTEGER, last_activity_at INTEGER NOT NULL, last_post_at INTEGER NOT NULL DEFAULT 0,
 settings_json TEXT NOT NULL, call_count INTEGER NOT NULL DEFAULT 0, bot_count INTEGER NOT NULL DEFAULT 0,
 stop_reason TEXT, episode INTEGER NOT NULL DEFAULT 1);
CREATE TABLE agent_instances(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), slot TEXT NOT NULL REFERENCES workers(slot),
 character_json TEXT NOT NULL, profile_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 processed_revision INTEGER NOT NULL DEFAULT 0, dirty_revision INTEGER NOT NULL DEFAULT 0, wake_seq INTEGER NOT NULL DEFAULT 0,
 processed_wake INTEGER NOT NULL DEFAULT 0, pending_since INTEGER, due_at INTEGER, trigger TEXT NOT NULL DEFAULT 'START',
 idle_checked INTEGER NOT NULL DEFAULT -1, next_self_at INTEGER NOT NULL, last_post_at INTEGER NOT NULL DEFAULT 0,
 error_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'listening', memory_revision INTEGER NOT NULL DEFAULT 0,
 deferral_json TEXT, UNIQUE(session_id,slot));
CREATE TABLE candidates(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_instances(id), session_id TEXT NOT NULL REFERENCES sessions(id),
 version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL, intent_json TEXT NOT NULL, text TEXT,
 reviewed_revision INTEGER NOT NULL, reviewed_wake INTEGER NOT NULL, first_interested_at INTEGER NOT NULL,
 not_before INTEGER NOT NULL, review_due_at INTEGER NOT NULL, defer_json TEXT, reason TEXT);
CREATE UNIQUE INDEX one_candidate ON candidates(agent_id) WHERE state IN ('DRAFTING','READY','NEEDS_REVIEW','DEFERRED');
CREATE TABLE runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_instances(id), session_id TEXT NOT NULL REFERENCES sessions(id),
 slot TEXT NOT NULL, worker_epoch INTEGER NOT NULL, session_epoch INTEGER NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL,
 state TEXT NOT NULL, snapshot_revision INTEGER NOT NULL, wake_seq INTEGER NOT NULL, candidate_id TEXT, candidate_version INTEGER,
 created_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, context_json TEXT NOT NULL, result_hash TEXT, result_json TEXT);
CREATE UNIQUE INDEX one_run_per_agent ON runs(agent_id) WHERE state='ACTIVE';
CREATE UNIQUE INDEX one_run_per_slot ON runs(slot) WHERE state='ACTIVE';
CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL,
 author_id TEXT REFERENCES agent_instances(id), text TEXT NOT NULL, act TEXT NOT NULL, reply_to TEXT REFERENCES messages(id),
 addressed_json TEXT NOT NULL, candidate_id TEXT UNIQUE REFERENCES candidates(id), deleted INTEGER NOT NULL DEFAULT 0,
 episode INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX message_session ON messages(session_id,revision);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL,
 revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX event_session ON events(session_id,id);
CREATE TABLE command_receipts(scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(scope,key));
CREATE TABLE traces(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT, run_id TEXT,
 code TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE llm_calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), request_key TEXT NOT NULL,
 scope TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 finished_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, error_code TEXT, result_hash TEXT, UNIQUE(run_id,request_key));
CREATE INDEX calls_active ON llm_calls(scope,status,expires_at);
CREATE TABLE memories(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_instances(id), text TEXT NOT NULL,
 sources_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE pending_questions(message_id TEXT NOT NULL REFERENCES messages(id), target TEXT NOT NULL, answered_by TEXT,
 PRIMARY KEY(message_id,target));
CREATE TABLE source_items(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), source TEXT NOT NULL,
 external_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, url TEXT, published_at TEXT, fetched_at INTEGER NOT NULL,
 UNIQUE(session_id,source,external_id));
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, text, tokenize='trigram');
PRAGMA user_version=1;
`;

export class Store {
  readonly db: Database.Database;
  readonly sqliteVersion: string;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if(version===0&&this.get("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1"))throw new Error('INVALID_APPLICATION_DATABASE');
      if(version>CURRENT_SCHEMA_VERSION)throw new Error('Unsupported database schema: '+version);
      this.sqliteVersion = this.get<{version:string}>('SELECT sqlite_version() AS version')!.version;
      const [major, minor, patch] = this.sqliteVersion.split('.').map(Number);
      if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) throw new Error('SQLite >= 3.51.3 is required; loaded ' + this.sqliteVersion);
      this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
      if (version === 0) this.tx(() => this.db.exec(legacySchemaV1));
      migrate(this.db);
    } catch(error) { this.db.close(); throw error; }
  }
  get<T>(sql: string, ...args: unknown[]): T|undefined { return this.db.prepare(sql).get(...args) as T|undefined; }
  all<T>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: unknown[]): Database.RunResult { return this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  close(): void { this.db.close(); }
  backup(path: string): Promise<Database.BackupMetadata> { return this.db.backup(path); }
}
