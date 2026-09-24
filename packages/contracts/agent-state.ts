import { z } from 'zod';
import { ParticipationAssessmentSchema } from './participation.js';
import { QuestionAssessmentSchema } from './conversation.js';

const EntityId = z.string().uuid();
const EntryId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
/** References identify the version actually supplied, not an inferred fact. */
export const EvidenceRefSchema = z.object({
  kind: z.enum(['message', 'source']), id: EntityId,
  version: z.number().int().nonnegative(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Stored conditions are intentions, not commands or an automatic publication schedule. */
export const ResumeConditionSchema = z.object({
  kind: z.enum(['new_message', 'answer_from', 'time', 'related_topic']),
  agentId: EntityId.nullable(), notBefore: z.number().int().nonnegative().nullable(),
  topic: z.string().trim().min(1).max(120).nullable(),
}).strict().refine(v => v.kind !== 'answer_from' || v.agentId !== null, 'answer_from needs agentId')
  .refine(v => v.kind !== 'time' || v.notBefore !== null, 'time needs notBefore')
  .refine(v => v.kind !== 'related_topic' || v.topic !== null, 'related_topic needs topic')
  .refine(v => (v.kind === 'answer_from') === (v.agentId !== null) &&
    (v.kind === 'time') === (v.notBefore !== null) && (v.kind === 'related_topic') === (v.topic !== null), 'Use only fields belonging to the condition kind');
export const PrivateStateEntrySchema = z.object({
  id: EntryId, kind: z.enum(['understanding', 'interest', 'question', 'intention']),
  text: z.string().trim().min(1).max(500),
  evidence: z.array(EvidenceRefSchema).max(8),
  derivedFrom: z.array(EntityId).max(8).optional(),
  question: QuestionAssessmentSchema.optional(),
  participation: ParticipationAssessmentSchema.optional(),
  resume: ResumeConditionSchema.nullable(),
}).strict();
export type PrivateStateEntry = z.infer<typeof PrivateStateEntrySchema>;
export const PrivateStateSchema = z.object({
  schemaVersion: z.literal(1), agentId: EntityId, sessionId: EntityId,
  version: z.number().int().nonnegative(), entries: z.array(PrivateStateEntrySchema).max(16),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type PrivateState = z.infer<typeof PrivateStateSchema>;
export const StatePatchSchema = z.object({
  agentId: EntityId, sessionId: EntityId, expectedVersion: z.number().int().nonnegative(),
  observationId: z.string().regex(/^[a-f0-9]{64}$/),
  upsert: z.array(PrivateStateEntrySchema).max(8), remove: z.array(EntryId).max(16),
}).strict();
export type StatePatch = z.infer<typeof StatePatchSchema>;

/** An exact, possibly sparse input manifest. This is NOT a contiguous history cursor. */
export type ObservationManifest = {
  id: string; targetRevision: number; trigger: string;
  scope: 'selected-input-only'; historyTruncated: boolean;
  messages: EvidenceRef[]; sources: EvidenceRef[];
};
