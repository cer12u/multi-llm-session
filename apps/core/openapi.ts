import type {FastifyInstance,FastifyRequest} from 'fastify';
import {buildOpenApi,type RegisteredRoute} from '../../packages/contracts/openapi.js';
const inventories=new WeakMap<FastifyInstance,RegisteredRoute[]>();

/** Register before application routes. Capture metadata only; never change validation,
 * auth hooks, serializers, request handlers or the authoritative SQLite path. */
export function installOpenApi(app:FastifyInstance,authorize:(request:FastifyRequest)=>void):void{
  const routes:RegisteredRoute[]=[];inventories.set(app,routes);
  app.addHook('onRoute',options=>{for(const method of Array.isArray(options.method)?options.method:[options.method])routes.push({method,url:options.url});});
  let cached:ReturnType<typeof buildOpenApi>|undefined;
  app.get('/v1/openapi.json',async(req,reply)=>{
    authorize(req);cached??=openApiDocument(app);
    reply.header('content-disposition','attachment; filename="multi-llm-session.openapi.json"');return cached;
  });
}
export function openApiDocument(app:FastifyInstance){
  const routes=inventories.get(app);if(!routes)throw new Error('OPENAPI_NOT_INSTALLED');return buildOpenApi(routes);
}
