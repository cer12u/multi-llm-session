import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,legacySchemaV1} from '../packages/storage-sqlite/index.js';
import {SessionService} from '../packages/session-service/index.js';
import {fixture} from './helpers.js';

it('migrates a populated v1 database without dropping messages, old memory, persona snapshots or replies',()=>{
  const dir=mkdtempSync(join(tmpdir(),'schema-migration-')),file=join(dir,'db.sqlite'),f=fixture();
  const config=f.config;f.close();const session=randomUUID(),agent=randomUUID(),root=randomUUID();
  const old=new Database(file);old.exec(legacySchemaV1);
  const settings={...config.defaults,maxDurationMs:900000,selfWakeMinMs:900000,selfWakeMaxMs:2700000} as Record<string,unknown>;delete settings.selfWakeEnabled;
  old.prepare('INSERT INTO sessions(id,title,lifecycle,created_at,last_activity_at,settings_json,revision) VALUES(?,?,?,?,?,?,?)').run(session,'既存セッション','DRAFT',1000,1000,JSON.stringify(settings),260);
  old.prepare('INSERT INTO workers(slot) VALUES(?)').run('worker-0');
  old.prepare('INSERT INTO agent_instances(id,session_id,slot,character_json,profile_json,next_self_at) VALUES(?,?,?,?,?,?)').run(agent,session,'worker-0',JSON.stringify(config.characters[0]),JSON.stringify(config.profiles[0]),900000);
  const insert=old.prepare('INSERT INTO messages(id,session_id,revision,author_id,text,act,reply_to,addressed_json,episode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<260;i++)insert.run(i?randomUUID():root,session,i+1,null,'移行する発言 '+i,'comment',i?root:null,'[]',1,1000+i);
  const memory=old.prepare('INSERT INTO memories(id,agent_id,text,sources_json,created_at) VALUES(?,?,?,?,?)');
  for(let i=0;i<60;i++)memory.run(randomUUID(),agent,'残す記憶 '+i,JSON.stringify([root]),1000+i);
  old.close();
  let db:Store|undefined;
  try{
    db=new Store(file);const service=new SessionService(db,config,()=>1000000);
    expect(db.db.pragma('user_version',{simple:true})).toBe(2);
    expect((service.exportSession(session).transcript as unknown[])).toHaveLength(260);
    expect(service.workerMemories('worker-0',agent)).toHaveLength(60);
    expect(service.pages.thread(session,root,{limit:200}).items).toHaveLength(200);
    expect(service.snapshot(session).session.settings.maxDurationMs).toBe(900000);
    expect(service.snapshot(session).session.settings.selfWakeEnabled).toBe(false);
    const last=service.humanMessage(session,{text:'移行後の新着'},randomUUID());expect(last.sequence).toBe(261);
    expect(service.snapshot(session).agents[0].characterVersion).toBe(1);
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
