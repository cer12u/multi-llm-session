import {expect,it} from 'vitest';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {inspectDatabase,restoreDatabase} from '../packages/storage-sqlite/maintenance.js';

it.each([
  ['DROP TRIGGER input_source_revision','STORAGE_SCHEMA_INCOMPLETE'],
  ["UPDATE source_versions SET text='mismatched original'",'STORAGE_SOURCE_HISTORY_INCOMPLETE'],
] as const)('R10-SOURCE-005: malformed V8 source storage (%s) is refused before creating a restored database',async(sql,code)=>{
  const dir=mkdtempSync(join(tmpdir(),'source-integrity-')),path=join(dir,'bad.sqlite'),f=fixture(3,{selfWakeEnabled:false},path);
  try{
    f.service.injectSource(f.id,{title:'original',text:'must retain its version'},randomUUID());
    expect(inspectDatabase(path).schemaVersion).toBe(8);f.store.db.exec(sql);
    expect(()=>inspectDatabase(path)).toThrow(code);
    const target=join(dir,'must-not-exist.sqlite');await expect(restoreDatabase(path,target)).rejects.toThrow(code);
    expect(existsSync(target)).toBe(false);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
