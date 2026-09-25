import type Database from 'better-sqlite3';

/** A database with missing input triggers or mismatched current/history originals is not a usable backup. */
export function checkSourceStructure(db:Database.Database):void {
  const columns=new Set((db.prepare('PRAGMA table_info(source_items)').all() as {name:string}[]).map(c=>c.name));
  const objects=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','index')").all() as {name:string}[]).map(o=>o.name));
  if(['version','enabled','audience_json'].some(name=>!columns.has(name))||
    ['input_source_insert','input_source_revision','source_feed_due'].some(name=>!objects.has(name)))throw new Error('STORAGE_SCHEMA_INCOMPLETE');
  if(db.prepare(`SELECT s.id FROM source_items s LEFT JOIN source_versions v ON v.source_id=s.id AND v.version=s.version
    WHERE v.source_id IS NULL OR s.title IS NOT v.title OR s.text IS NOT v.text OR s.url IS NOT v.url
    OR s.published_at IS NOT v.published_at OR s.fetched_at IS NOT v.fetched_at
    OR s.enabled IS NOT v.enabled OR s.audience_json IS NOT v.audience_json LIMIT 1`).get())throw new Error('STORAGE_SOURCE_HISTORY_INCOMPLETE');
  if(db.prepare(`SELECT f.id FROM source_feeds f LEFT JOIN source_feed_versions v ON v.feed_id=f.id AND v.version=f.version
    WHERE v.feed_id IS NULL OR v.definition_json IS NOT f.definition_json LIMIT 1`).get())throw new Error('STORAGE_FEED_HISTORY_INCOMPLETE');
}
