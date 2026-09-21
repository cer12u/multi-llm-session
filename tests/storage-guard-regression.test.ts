import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage-sqlite/index.js';

it('R10-STORAGE-001: a populated unrelated user_version=0 database is not silently initialized or migrated',()=>{
  const dir=mkdtempSync(join(tmpdir(),'storage-foreign-')),path=join(dir,'foreign.sqlite');let opened:Store|undefined;
  try{
    const foreign=new Database(path);foreign.exec("CREATE TABLE foreign_data(id INTEGER PRIMARY KEY,text TEXT); INSERT INTO foreign_data VALUES(1,'retained');");foreign.close();
    expect(()=>{opened=new Store(path);}).toThrow('INVALID_APPLICATION_DATABASE');
    const check=new Database(path,{readonly:true,fileMustExist:true});
    try{expect(check.pragma('user_version',{simple:true})).toBe(0);expect(check.prepare('SELECT text FROM foreign_data').get()).toEqual({text:'retained'});
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()).toBeUndefined();
    }finally{check.close();}
  }finally{opened?.close();rmSync(dir,{recursive:true,force:true});}
});
