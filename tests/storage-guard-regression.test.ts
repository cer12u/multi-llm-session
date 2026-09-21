import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage-sqlite/index.js';

it.each([
  "CREATE TABLE foreign_data(id INTEGER PRIMARY KEY,text TEXT); INSERT INTO foreign_data VALUES(1,'retained');",
  "CREATE TABLE sqlitex_rows(text TEXT); INSERT INTO sqlitex_rows VALUES('retained');",
  "CREATE VIEW unrelated_view AS SELECT 'retained' AS text;",
])('R10-STORAGE-001: unrelated user_version=0 schema is not silently initialized: %s',schema=>{
  const dir=mkdtempSync(join(tmpdir(),'storage-foreign-')),path=join(dir,'foreign.sqlite');let opened:Store|undefined;
  try{
    const foreign=new Database(path);foreign.exec(schema);
    const before=foreign.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();foreign.close();
    expect(()=>{opened=new Store(path);}).toThrow('INVALID_APPLICATION_DATABASE');
    const check=new Database(path,{readonly:true,fileMustExist:true});
    try{
      expect(check.pragma('user_version',{simple:true})).toBe(0);
      expect(check.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeUndefined();
    }finally{check.close();}
  }finally{opened?.close();rmSync(dir,{recursive:true,force:true});}
});
