import {z} from 'zod';
import {Id,UsageSchema,ErrorCodeSchema,LookupRequestSchema} from './index.js';

/** HTTP envelopes shared by the actual route parsers and the OpenAPI exporter.
 * Authorization and domain/owner/version validation still run inside the application. */
export const EmptyBody=z.object({}).strict();
export const RunAuth=z.object({epoch:z.number().int().positive(),token:Id}).strict();
export const HttpBody={
  empty:EmptyBody,
  login:z.object({token:z.string().max(500)}).strict(),
  memberEnabled:z.object({agentId:Id,enabled:z.boolean()}).strict(),
  messageEdit:z.object({text:z.string().nullable()}).strict(),
  messageLookup:z.object({ids:z.array(Id).max(200)}).strict(),
  workerClaim:z.object({epoch:z.number().int().positive()}).strict(),
  runAuth:RunAuth,
  callReserve:RunAuth.extend({requestKey:z.string().min(8).max(128),stage:z.enum(['primary','repair','lookup'])}),
  callFinish:z.object({token:Id,usage:UsageSchema,error:ErrorCodeSchema.nullable(),retryAfterMs:z.number().int().min(0).max(86400000).default(0)}).strict(),
  runLookup:RunAuth.extend({requestKey:z.string().min(8).max(128),requests:z.array(LookupRequestSchema).min(1).max(3)}),
  // completeRun subsequently validates output against the bound run kind and owner.
  runResult:RunAuth.extend({output:z.unknown()}),
  runFailure:RunAuth.extend({code:ErrorCodeSchema}),
};
export const PageQuery=z.object({cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).strict();
export const HttpQuery={
  page:PageQuery,
  searchPage:PageQuery.extend({q:z.string().min(1).max(200)}),
  memoryPage:PageQuery.extend({q:z.string().max(200).default('')}),
  search:z.object({q:z.string().min(1).max(200)}),
  events:z.object({cursor:z.string().max(100).optional()}),
  diagnosticRuns:z.object({before:z.coerce.number().int().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(50).optional()}).strict(),
};
export const ReceiptParams=z.object({id:Id,operation:z.enum(['message','lifecycle','edit','settings','membership','participants','clone']),key:z.string().max(128)});
