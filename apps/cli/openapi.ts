import {loadConfig} from '../../packages/config/index.js';
import {Store} from '../../packages/storage-sqlite/index.js';
import {SessionService} from '../../packages/session-service/index.js';
import {buildServer} from '../core/server.js';
import {openApiDocument} from '../core/openapi.js';

/** Offline specification export uses the real route registration, no listening port,
 * production configuration, model keys, Worker processes or persistent user database. */
export async function exportOpenApi(){
  const config=loadConfig({ADMIN_TOKEN:'offline-api-schema-admin-000000000000',WORKER_A_TOKEN:'offline-api-schema-worker-a-000000000',WORKER_B_TOKEN:'offline-api-schema-worker-b-000000000',WORKER_C_TOKEN:'offline-api-schema-worker-c-000000000',ALLOW_LIVE_MODELS:'0',DB_PATH:':memory:'});
  const store=new Store(':memory:');let app:ReturnType<typeof buildServer>|undefined;
  try{app=buildServer(new SessionService(store,config),{timers:false});await app.ready();return openApiDocument(app);}
  finally{if(app)await app.close();store.close();}
}
