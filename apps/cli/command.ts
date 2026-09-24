import { operatorCommand } from './operator-client.js';
try {
  const result=await operatorCommand(process.argv.slice(2));
  console.log(result.body);if(!result.ok)process.exitCode=1;
}catch(error){
  // Do not print request headers, environment, provider bodies or a stack containing private input.
  console.error(error instanceof Error&&error.message.startsWith('Usage:')?error.message:'Command failed; check arguments, authentication and Core connectivity.');
  process.exitCode=1;
}
