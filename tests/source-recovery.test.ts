import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './helpers.js';
import {asV7Fixture} from './fixtures/source-v7.js';
import {Store} from '../packages/storage-sqlite/index.js';
import {SessionService} from '../packages/session-service/index.js';
import {migrateSources} from '../packages/storage-sqlite/source-migration.js';
import {backupDatabase,restoreDatabase,inspectDatabase} from '../packages/storage-sqlite/maintenance.js';
import {FeedPoller,parseFeed} from '../packages/sources/index.js';

const xml='<rss><channel><item><guid>stable</guid><title>legacy title</title><description>legacy body</description><pubDate>2020-01-02T03:04:05Z</pubDate></item></channel></rss>';
function oldSource(f:ReturnType<typeof fixture>){
  const item=parseFeed(xml)[0],id=randomUUID();
  f.store.run('INSERT INTO source_items(id,session_id,source,external_id,title,text,url,published_at,fetched_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id,f.id,'news',item.externalId,item.title,item.text,item.url,item.publishedAt,f.now());return id;
}

it('R10-SOURCE-001: populated V7 upgrade preserves original IDs, time-based evidence, owner state and delivery receipts, while fencing old runs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-upgrade-')),path=join(dir,'live.sqlite'),f=fixture(3,{selfWakeEnabled:false},path);let reopened:Store|undefined;
  try{
    const message=f.say('original conversation');f.start();const first=f.claim()!;f.finish(first,{decision:'ABSTAIN',reason:'consumed public input'});
    f.say('pending original');const pending=f.claim()!,call=f.service.reserveCall('worker-0',pending.workerEpoch,pending.id,pending.token,randomUUID(),'primary');
    asV7Fixture(f.store.db);const id=oldSource(f),owner=f.service.agents(f.id)[0].id;
    // Isolated legacy fixture models an already persisted V7 source-grounded working entry.
    const entry={id:'legacy-interest',kind:'interest',text:'V7 owner interest',evidence:[{kind:'source',id,version:f.now()}],resume:null};
    f.store.run('UPDATE agent_private_states SET entries_json=?,version=1 WHERE agent_id=?',JSON.stringify([entry]),owner);
    const before=Object.fromEntries(['messages','agent_instances','agent_private_states','agent_input_log','agent_input_cursors','agent_input_receipts','command_receipts'].map(table=>[table,f.store.all('SELECT * FROM '+table+' ORDER BY rowid')]));
    const old=f.store.get<{fetched_at:number;text:string;published_at:string}>('SELECT fetched_at,text,published_at FROM source_items WHERE id=?',id)!;
    f.close();reopened=new Store(path);expect(inspectDatabase(path).schemaVersion).toBe(8);
    for(const [table,rows] of Object.entries(before))expect(reopened.all('SELECT * FROM '+table+' ORDER BY rowid'),table).toEqual(rows);
    expect(reopened.get('SELECT version,text,published_at,fetched_at,audience_json,enabled FROM source_items WHERE id=?',id)).toEqual({...old,version:old.fetched_at,audience_json:'null',enabled:1});
    expect(reopened.get('SELECT source_id,version,text FROM source_versions WHERE source_id=?',id)).toEqual({source_id:id,version:old.fetched_at,text:old.text});
    expect(reopened.get<{state:string}>('SELECT state FROM runs WHERE id=?',pending.id)?.state).toBe('CANCELLED');
    expect(reopened.get<{status:string}>('SELECT status FROM llm_calls WHERE id=?',call.id)?.status).toBe('ABANDONED');
    const service=new SessionService(reopened,f.config,f.now,()=>0);service.recover();
    expect(service.archiveMessage(f.id,message.id).text).toBe('original conversation');
    const epoch=service.registerWorker('worker-0').epoch,next=service.claim('worker-0',epoch)!;
    expect(next.context.self.privateState!.entries).toEqual([entry]);
    expect(next.context.sources.find(s=>s.id===id)).toMatchObject({version:old.fetched_at,fetchedAt:old.fetched_at,publishedAt:old.published_at});
    expect(()=>service.completeRun('worker-0',pending.workerEpoch,pending.id,pending.token,{decision:'ABSTAIN',reason:'old'})).toThrow();
    expect(reopened.db.pragma('foreign_key_check')).toEqual([]);
  }finally{reopened?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R10-SOURCE-002: a failed V8 migration rolls back added columns, original history, trigger changes and schema version',()=>{
  const f=fixture(3,{selfWakeEnabled:false});try{
    asV7Fixture(f.store.db);const id=oldSource(f),original=f.store.all('SELECT * FROM source_items'),log=f.store.all('SELECT * FROM agent_input_log');
    const trigger=f.store.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='input_source_insert'")!.sql;
    f.store.db.exec("CREATE TABLE source_feed_versions(sentinel TEXT); INSERT INTO source_feed_versions VALUES('retain');");
    expect(()=>migrateSources(f.store.db)).toThrow();expect(f.store.db.pragma('user_version',{simple:true})).toBe(7);
    expect(f.store.all('SELECT * FROM source_items')).toEqual(original);expect(f.store.all('SELECT * FROM agent_input_log')).toEqual(log);
    expect(f.store.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='input_source_insert'")!.sql).toBe(trigger);
    expect(f.store.all("SELECT name FROM sqlite_master WHERE name IN ('source_versions','source_feeds','input_source_revision')")).toEqual([]);
    expect(f.store.get('SELECT sentinel FROM source_feed_versions')).toEqual({sentinel:'retain'});
    expect(f.store.db.pragma('table_info(source_items)')).not.toContainEqual(expect.objectContaining({name:'version'}));
    f.store.db.exec('DROP TABLE source_feed_versions;');migrateSources(f.store.db);
    expect(f.store.get<{source_id:string}>('SELECT source_id FROM source_versions')?.source_id).toBe(id);
    expect(f.store.db.pragma('user_version',{simple:true})).toBe(8);expect(f.store.db.pragma('foreign_key_check')).toEqual([]);
  }finally{f.close();}
});

it('R10-SOURCE-003: the first post-upgrade feed acquisition adopts the old source namespace without duplicate originals or observations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-feed-upgrade-')),path=join(dir,'live.sqlite'),f=fixture(3,{selfWakeEnabled:false},path);let db:Store|undefined;
  try{
    f.config.feeds=[{id:'news',url:'https://fixture.invalid/feed',intervalMs:60000}];f.start();asV7Fixture(f.store.db);const id=oldSource(f);
    const before=f.store.all('SELECT * FROM agent_input_log');f.close();db=new Store(path);
    const service=new SessionService(db,f.config,f.now,()=>0);service.recover();
    await new FeedPoller(service,async()=>new Response(xml)).tick();
    expect(service.sources.list(f.id)).toHaveLength(1);expect(service.sources.list(f.id)[0].id).toBe(id);
    expect(service.sources.versions(f.id,id)).toHaveLength(1);expect(db.all('SELECT * FROM agent_input_log')).toEqual(before);
    expect(db.get<{source:string}>('SELECT source FROM source_items WHERE id=?',id)?.source).toBe('feed:'+service.sources.feeds(f.id)[0].id);
    expect(service.session(f.id).call_count).toBe(0);
  }finally{db?.close();if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

it('R10-SOURCE-004: V8 online backup and restore preserve all revisions, private evidence and feed jobs; lease recovery fences a delayed result',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-restore-')),path=join(dir,'live.sqlite'),f=fixture(3,{selfWakeEnabled:false},path);let db:Store|undefined;
  try{
    const owner=f.service.agents(f.id)[0];f.config.feeds=[{id:'news',url:'https://fixture.invalid/feed',intervalMs:60000}];f.start();
    const feed=f.service.sources.putFeed(f.id,{configId:'news',expectedVersion:0,audience:[owner.id]},randomUUID());
    f.service.sources.finishFeed(f.service.sources.claimFeed(feed.id)!,parseFeed(xml));const id=f.service.sources.list(f.id)[0].id;
    const {version,fetchedAt:_,id:__,...input}=f.service.sources.get(f.id,id);
    f.service.sources.update(f.id,id,{...input,text:'revised source body',expectedVersion:version},randomUUID());
    const run=f.claim()!,entry={id:'restored-source',kind:'interest',text:'OWNER_SOURCE_INTEREST',evidence:[{kind:'source',id,version:2}],resume:{kind:'related_topic',agentId:null,topic:'later',notBefore:null}};
    f.finish(run,{action:{decision:'ABSTAIN',reason:'retain owner interest'},statePatch:{agentId:owner.id,sessionId:f.id,expectedVersion:run.context.self.privateState!.version,observationId:run.context.observation!.id,upsert:[entry],remove:[]}});
    f.service.sources.retryFeed(f.id,feed.id,randomUUID());const pending=f.service.sources.claimFeed(feed.id)!;f.service.lifecycle(f.id,'pause',randomUUID());
    const tables=['source_items','source_versions','source_feeds','source_feed_versions','source_feed_jobs','agent_private_states','agent_state_updates','agent_agenda','agent_input_log','agent_input_receipts'];
    const before=Object.fromEntries(tables.map(table=>[table,f.store.all('SELECT * FROM '+table+' ORDER BY rowid')]));
    const backup=join(dir,'backup.sqlite'),restored=join(dir,'restore.sqlite');
    expect((await backupDatabase(path,backup)).schemaVersion).toBe(8);await restoreDatabase(backup,restored);
    db=new Store(restored);const service=new SessionService(db,{...f.config,dbPath:restored},f.now,()=>0);service.recover();
    for(const table of tables)expect(db.all('SELECT * FROM '+table+' ORDER BY rowid'),table).toEqual(before[table]);
    expect(service.sources.get(f.id,id,1).text).toBe('legacy body');expect(service.sources.get(f.id,id,2).text).toBe('revised source body');
    service.lifecycle(f.id,'resume',randomUUID());expect(service.sources.claimFeed(feed.id)).toBeNull();
    f.advance(30001);const replacement=service.sources.claimFeed(feed.id)!;expect(replacement.id).not.toBe(pending.id);
    expect(service.sources.finishFeed(pending,parseFeed(xml))).toBe(false);
    expect(service.sources.finishFeed(replacement,parseFeed(xml.replace('legacy body','new acquisition')))).toBe(true);
    const after=db.all('SELECT * FROM agent_input_log');expect(service.sources.finishFeed(replacement,parseFeed(xml))).toBe(true);
    expect(db.all('SELECT * FROM agent_input_log')).toEqual(after);expect(service.sources.list(f.id)).toHaveLength(1);
    expect(service.sources.get(f.id,id)).toMatchObject({version:3,audience:[owner.id],text:'new acquisition'});
    expect(service.session(f.id).call_count).toBe(1);expect(db.db.pragma('foreign_key_check')).toEqual([]);
  }finally{db?.close();f.close();rmSync(dir,{recursive:true,force:true});}
},20000);
