import { readFileSync } from 'node:fs';
import { generateDeployment } from '../../packages/config/deployment.js';

try{
  const [source,target,optIn]=process.argv.slice(2);
  if(!source||!target||optIn!=='--allow-live')throw new Error('EXPLICIT_LIVE_CONFIGURATION_REQUIRED');
  const result=generateDeployment(JSON.parse(readFileSync(source,'utf8')),target);
  console.log(JSON.stringify(result,null,2));
}catch{
  console.error('DEPLOY_CONFIG_FAILED: check schema, unique workers/profile IDs, credential files, opt-in and a new destination outside the repository.');process.exitCode=1;
}
