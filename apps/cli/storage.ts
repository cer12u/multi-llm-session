import { backupDatabase, inspectDatabase, maintainDatabase, restoreDatabase } from '../../packages/storage-sqlite/maintenance.js';
const [action,source,target]=process.argv.slice(2);
try {
  if(!source)throw new Error('STORAGE_SOURCE_REQUIRED');
  let result;
  if(action==='inspect')result=inspectDatabase(source);
  else if(action==='backup'&&target)result=await backupDatabase(source,target);
  else if(action==='restore'&&target)result=await restoreDatabase(source,target);
  else if(action==='maintain')result=maintainDatabase(source,target==='--offline');
  else throw new Error('STORAGE_COMMAND_INVALID');
  console.log(JSON.stringify(result,null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  console.error(/^STORAGE_[A-Z_]+$/.test(message)?message:'STORAGE_OPERATION_FAILED');
  process.exitCode=1;
}
