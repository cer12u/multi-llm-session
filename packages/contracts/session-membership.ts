import {z} from 'zod';
import type {Lifecycle,PublicAgent} from './index.js';

const Ref=z.object({id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),version:z.number().int().positive()}).strict();
export const SessionMemberSchema=z.object({
  agentId:z.string().uuid().nullable(),slot:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
  character:Ref,profile:Ref,enabled:z.boolean(),
}).strict();
export const MembershipUpdateSchema=z.object({
  expectedEpoch:z.number().int().nonnegative(),participants:z.array(SessionMemberSchema).min(3).max(16),
}).strict().refine(value=>new Set(value.participants.map(p=>p.slot)).size===value.participants.length,'Worker slots must be distinct')
  .refine(value=>{const ids=value.participants.flatMap(p=>p.agentId?[p.agentId]:[]);return new Set(ids).size===ids.length;},'Agent IDs must be distinct');
export const SessionCloneSchema=z.object({title:z.string().trim().min(1).max(120),copy:z.literal('definitions-only')}).strict();
export type MemberSelection=z.infer<typeof SessionMemberSchema>;
export type MembershipUpdate=z.infer<typeof MembershipUpdateSchema>;
export type MembershipRecord={agent:PublicAgent;character:{id:string;version:number};profile:{id:string;version:number};retiredAt:number|null};
export type EpisodeRecord={number:number;startedAt:number;lastMessageAt:number|null;firstSequence:number;lastSequence:number;closedAt:number|null;endSequence:number|null;origin:string};
export type MembershipReport={sessionId:string;epoch:number;lifecycle:Lifecycle;current:MembershipRecord[];archived:MembershipRecord[];
  counts:{current:number;enabled:number;online:number;disabled:number;offline:number;errors:number};slots:string[];
  characters:{id:string;version:number;name:string}[];profiles:{id:string;version:number;provider:string;model:string}[];episodes:EpisodeRecord[]};
