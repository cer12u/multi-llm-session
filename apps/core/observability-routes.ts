import {HttpQuery} from '../../packages/contracts/http.js';
import {continuityFingerprint} from '../../packages/observability/continuity.js';
import {Readable} from 'node:stream';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {Id} from '../../packages/contracts/index.js';
import type {SessionService} from '../../packages/session-service/index.js';
import {diagnosticExport,diagnosticRun,diagnosticRuns,publicTranscript} from '../../packages/observability/index.js';

/** Public and private artifacts have separate routes and grants; no GET changes the Agent lifecycle. */
export function registerObservabilityRoutes(app:FastifyInstance,service:SessionService,authorize:(req:FastifyRequest,operator:boolean)=>void):void{
  const params=z.object({id:Id});
  app.get('/v1/sessions/:id/transcript',async(req,reply)=>{
    authorize(req,false);const {id}=params.parse(req.params);
    reply.header('content-disposition',`attachment; filename="transcript-${id}.json"`);
    return publicTranscript(service,id);
  });
  app.get('/v1/sessions/:id/continuity-fingerprint',async req=>{
    authorize(req,true);const {id}=params.parse(req.params);return continuityFingerprint(service,id);
  });
  app.get('/v1/sessions/:id/diagnostic-runs',async req=>{
    authorize(req,true);const {id}=params.parse(req.params),options=HttpQuery.diagnosticRuns.parse(req.query);
    return diagnosticRuns(service,id,options);
  });
  app.get('/v1/sessions/:id/diagnostic-runs/:run',async req=>{
    authorize(req,true);const {id,run}=params.extend({run:Id}).parse(req.params);return diagnosticRun(service,id,run);
  });
  app.get('/v1/sessions/:id/diagnostic-export',async(req,reply)=>{
    authorize(req,true);const {id}=params.parse(req.params),snapshot=diagnosticExport(service,id);
    reply.header('content-disposition',`attachment; filename="PRIVATE-diagnostic-${id}.ndjson"`).type('application/x-ndjson; charset=utf-8');
    const authorized=async function*(){for await(const line of snapshot.lines()){authorize(req,true);yield line;}};
    return reply.send(Readable.from(authorized()));
  });
}
