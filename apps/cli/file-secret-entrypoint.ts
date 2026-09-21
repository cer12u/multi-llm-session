import { readServiceTokenFiles } from '../../packages/config/service-token-files.js';

try{
  Object.assign(process.env,readServiceTokenFiles());
  const mode=process.argv[2];
  if(mode==='core')await import('../core/main.js');
  else if(mode==='worker')await import('../agent-worker/main.js');
  else throw new Error('INVALID_SERVICE_ROLE');
}catch{
  // Paths, credentials, config payloads and provider response bodies must not enter container logs.
  console.error('SERVICE_START_FAILED: verify live opt-in, configuration and mounted secret files.');process.exitCode=1;
}
