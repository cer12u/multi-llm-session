import { SourceSchema, type SourceInput } from '../contracts/source.js';
export type AcquiredItem={externalId:string;title:string;text:string;url:string|null;publishedAt:string|null};
export interface SourceAdapter { acquire(signal:AbortSignal):AcquiredItem[]|Promise<AcquiredItem[]> }
/** Material acquisition does not grant visibility or write conversation state. */
export class ManualSource implements SourceAdapter {
  constructor(private readonly input:unknown,private readonly externalId:string){}
  acquire(): (SourceInput & {externalId:string})[] {return [{...SourceSchema.parse(this.input),externalId:this.externalId}];}
}
