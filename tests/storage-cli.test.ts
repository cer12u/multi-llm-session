import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { backupDatabase } from '../packages/storage-sqlite/maintenance.js';

it('R10-STORAGE-010: real CLI inspect/backup/restore/maintenance works without model credentials and refuses implicit offline maintenance',()=>{
  const dir=mkdtempSync(join(tmpdir(),'storage-cli-')),f=fixture(3,{},join(dir,'live.sqlite'));
  const run=(...args:string[])=>spawnSync(process.execPath,['--import','tsx',resolve('apps/cli/storage.ts'),...args],{encoding:'utf8',timeout:15000});
  try{
    f.say('CLI復旧の原文');f.close();
    const inspect=run('inspect',f.config.dbPath);expect(inspect.status,inspect.stderr).toBe(0);expect(JSON.parse(inspect.stdout).rows.messages).toBe(1);
    const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored','session.sqlite');
    const result=run('backup',f.config.dbPath,backup);expect(result.status,result.stderr).toBe(0);
    const restore=run('restore',backup,restored);expect(restore.status,restore.stderr).toBe(0);expect(JSON.parse(restore.stdout).rows.messages).toBe(1);
    expect(run('maintain',restored).stderr).toContain('STORAGE_OFFLINE_ACK_REQUIRED');
    const maintain=run('maintain',restored,'--offline');expect(maintain.status,maintain.stderr).toBe(0);
    expect(JSON.parse(maintain.stdout).rows.messages).toBe(1);
    expect(run('restore',backup,restored).stderr).toContain('STORAGE_DESTINATION_EXISTS');
    expect(inspect.stdout).not.toContain('CLI復旧の原文');expect(result.stdout).not.toContain('token');
  }finally{if(f.store.db.open)f.close();rmSync(dir,{recursive:true,force:true});}
},20000);

it('R10-STORAGE-011: concurrent create-only backups cannot overwrite each other or leave a partially published database',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'storage-race-')),f=fixture(3,{},join(dir,'live.sqlite'));
  try{
    f.say('競合するbackup');const target=join(dir,'one.sqlite');
    const outcomes=await Promise.allSettled([backupDatabase(f.config.dbPath,target),backupDatabase(f.config.dbPath,target)]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(readFileSync(target).subarray(0,16).toString()).toBe('SQLite format 3\u0000');
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
