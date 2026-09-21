import { readFileSync } from 'node:fs';
import { generateDeployment } from '../../packages/config/deployment.js';

try{
  const [source,target,optIn]=process.argv.slice(2);
  if(!source||!target||optIn!=='--allow-live')throw new Error('EXPLICIT_LIVE_CONFIGURATION_REQUIRED');
  const result=generateDeployment(JSON.parse(readFileSync(source,'utf8')),target);
  console.log(JSON.stringify(result,null,2));
}catch(error){
  const value=error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.message:'';
  const code=/^[A-Z][A-Z0-9_]{2,79}$/.test(value)?value:'INVALID_DEPLOYMENT_CONFIGURATION';
  console.error('DEPLOY_CONFIG_FAILED: '+code);process.exitCode=1;
}
