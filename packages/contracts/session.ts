import { z } from 'zod';
import type { PublicAgent, Lifecycle } from './index.js';

const Id = z.string().uuid(), Slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
export const DefinitionVersionSchema = z.object({ id: Slug, version: z.number().int().positive() }).strict();
export const MemberChangeSchema = z.object({
  expectedEpoch: z.number().int().nonnegative(),
  change: z.discriminatedUnion('action', [
    z.object({ action: z.literal('add'), slot: Slug, character: DefinitionVersionSchema, profile: DefinitionVersionSchema }).strict(),
    z.object({ action: z.literal('replace'), agentId: Id, character: DefinitionVersionSchema, profile: DefinitionVersionSchema }).strict(),
    z.object({ action: z.literal('apply'), agentId: Id, character: DefinitionVersionSchema, profile: DefinitionVersionSchema }).strict(),
    z.object({ action: z.literal('retire'), agentId: Id }).strict(),
    z.object({ action: z.literal('set_enabled'), agentId: Id, enabled: z.boolean() }).strict(),
  ]),
}).strict();
export type MemberChange = z.infer<typeof MemberChangeSchema>;
export type MemberCatalog = {
  characters: { id: string; version: number; name: string }[];
  profiles: { id: string; version: number; model: string; provider: string }[];
  slots: string[];
};
export type SessionContinuity = {
  schemaVersion: 1; sessionId: string; epoch: number; lifecycle: Lifecycle;
  counts: { present: number; enabled: number; online: number };
  members: { agent: PublicAgent; joinedAt: number; retiredAt: number | null;
    character: { id: string; version: number }; profile: { id: string; version: number } }[];
  episodes: { number: number; startedAt: number; closedAt: number | null; fromSequence: number; throughSequence: number; origin: string }[];
  copyPolicy: 'new-session-new-identities-no-history-or-private-copy';
};
