import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if(existsSync('.env'))throw new Error('.env already exists; refusing to overwrite credentials');
const names=['ADMIN_TOKEN','WORKER_A_TOKEN','WORKER_B_TOKEN','WORKER_C_TOKEN'];
writeFileSync('.env',names.map(n=>n+'='+randomBytes(32).toString('hex')).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('Created .env with fresh local credentials. Read ADMIN_TOKEN locally for browser login; never commit this file.');
