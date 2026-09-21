import { readServiceTokenFiles } from '../../packages/config/service-token-files.js';

try{
  Object.assign(process.env,readServiceTokenFiles());
  const mode=process.argv[2];
  if(mode==='core')await import('../core/main.js');
  else if(mode==='worker')await import('../agent-worker/main.js');
  else throw new Error('INVALID_SERVICE_ROLE');
}catch(error){
  const value=error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.message:'';
  const code=/^[A-Z][A-Z0-9_]{2,79}$/.test(value)?value:'INVALID_SERVICE_CONFIGURATION';
  // Only an error code crosses this boundary; never output paths, keys, config or a stack.
  console.error('SERVICE_START_FAILED: '+code);process.exitCode=1;
}
