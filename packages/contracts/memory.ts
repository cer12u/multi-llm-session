import { z } from 'zod';
const Id=z.string().uuid();
const Time=z.number().int().nonnegative().nullable();
/** Model-authored interpretation of observed statements; never a shared or verified fact. */
export const MemoryMeaningSchema=z.object({
  subjectId:Id.nullable(),topic:z.string().trim().min(1).max(120),
  key:z.string().trim().min(1).max(160),value:z.string().trim().min(1).max(240),
  epistemic:z.enum(['self_report','hearsay','inference','uncertain']),
  validFrom:Time,validTo:Time,aliases:z.array(z.string().trim().min(1).max(80)).max(8),
}).strict().refine(x=>x.validFrom===null||x.validTo===null||x.validTo>x.validFrom,'Validity interval must increase');
export type MemoryMeaning=z.infer<typeof MemoryMeaningSchema>;
export const MemoryChangeSchema=z.object({
  operation:z.enum(['add','merge','correct','conflict']),text:z.string().trim().min(1).max(1000),
  sourceMessageIds:z.array(Id).min(1).max(8),meaning:MemoryMeaningSchema,
  targets:z.array(Id).max(8),parents:z.array(Id).max(8),
}).strict().refine(x=>x.operation==='add'||x.targets.length>0,'This operation needs an observed target');
export type MemoryChange=z.infer<typeof MemoryChangeSchema>;
export type MemoryStatus='ACTIVE'|'SUPERSEDED'|'CONFLICT'|'INVALID';
export type MemoryProvenance={
  status:MemoryStatus;meaning:MemoryMeaning|null;verified:false;
  evidence:{kind:'message';id:string;version:number}[]|null;
  parents:string[];independentSupport:null;
};
