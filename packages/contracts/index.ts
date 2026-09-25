import {OperationalBudgetSchema} from './budget.js';
export * from './budget.js';
import { z } from 'zod';
export * from './source.js';
import type { SourceChunk } from './source.js';
import { StatePatchSchema, type PrivateState, type ObservationManifest } from './agent-state.js';
export * from './agent-state.js';
import type { InputWindow, InputProgress, InputSelection } from './input-window.js';
export * from './input-window.js';
import type { AgendaContext } from './agenda.js';
export * from './agenda.js';
import { MemoryChangeSchema, type MemoryProvenance } from './memory.js';
export * from './memory.js';
import { ProviderCapabilitiesSchema } from './provider-capabilities.js';
export * from './provider-capabilities.js';
import type { QuestionHint } from './conversation.js';
export * from './conversation.js';
import type { ConversationFlow } from './participation.js';
export * from './participation.js';

export const Id = z.string().uuid();
export const Slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
export const Text = z.string().trim().min(1).max(8000).refine(v => [...v].length <= 4000, 'At most 4000 Unicode code points');
export const CharacterSchema = z.object({
  schemaVersion: z.literal(1), id: Slug, version: z.number().int().positive(),
  name: z.string().trim().min(1).max(80), persona: z.string().trim().min(1).max(6000),
  presentationRef: z.string().max(256).nullable().default(null),
}).strict();
export type Character = z.infer<typeof CharacterSchema>;
export const ModelProfileSchema = z.object({
  id: Slug, version: z.number().int().positive().default(1), provider: z.enum(['mock', 'ollama', 'openai']), model: z.string().min(1).max(200),
  baseUrl: z.string().url().optional(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  jsonMode: z.enum(['none', 'json', 'schema']).default('none'),
  maxOutputTokens: z.number().int().min(128).max(4096).default(768),
  temperature: z.number().min(0).max(2).default(0.8),
  limitGroup: Slug.optional(), maxConcurrent: z.number().int().min(1).max(32).default(3),
  failureThreshold: z.number().int().min(1).max(10).default(3),
  circuitCooldownMs: z.number().int().min(1000).max(3600000).default(60000),
  allowLocalHttp: z.boolean().default(false), authRequired: z.boolean().default(true),
  contextWindowTokens: z.number().int().min(2048).max(2097152).optional(),
  // No default: parsing a legacy immutable profile must not change its stored hash.
  capabilities: ProviderCapabilitiesSchema.optional(),
}).strict().refine(p=>!p.capabilities||p.capabilities.jsonModes.includes(p.jsonMode),'Selected JSON mode is not declared supported')
  .refine(p=>!p.capabilities||p.provider==='mock'||(p.provider==='ollama')===(p.capabilities.outputTokenParameter==='num_predict'),'Token parameter does not match Provider API');
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const SettingsSchema = z.object({
  operationalBudget:OperationalBudgetSchema.optional(),
  debounceMs: z.number().int().min(0).max(10000).default(800),
  maxCoalesceMs: z.number().int().min(0).max(30000).default(2000),
  directedDebounceMs: z.number().int().min(0).max(10000).default(200),
  idleMs: z.number().int().min(100).max(86400000).default(60000),
  selfWakeEnabled: z.boolean().default(true),
  selfWakeMinMs: z.number().int().min(100).max(86400000).default(900000),
  selfWakeMaxMs: z.number().int().min(100).max(86400000).default(2700000),
  episodeGapMs: z.number().int().min(100).max(86400000).default(1800000),
  arbitrationMs: z.number().int().min(0).max(10000).default(300),
  postGapMs: z.number().int().min(0).max(60000).default(2000),
  agentCooldownMs: z.number().int().min(0).max(60000).default(8000),
  replyGraceMs: z.number().int().min(0).max(30000).default(6000),
  agingMs: z.number().int().min(0).max(300000).default(30000),
  reviewTtlMs: z.number().int().min(100).max(300000).default(30000),
  maxCalls: z.number().int().min(1).max(10000).default(120),
  maxMessages: z.number().int().min(1).max(1000).default(30),
  maxDurationMs: z.number().int().min(1000).max(21600000).default(3600000),
  contextMessages: z.number().int().min(5).max(100).default(40),
  contextChars: z.number().int().min(4000).max(100000).default(24000),
  contextTokens: z.number().int().min(2048).max(2097152).default(65536),
  agendaMinIntervalMs: z.number().int().min(100).max(86400000).default(30000),
  memoryShareEvery: z.number().int().min(1).max(32).default(3),
  memoryFlushMs: z.number().int().min(100).max(86400000).default(60000),
  memoryEvery: z.number().int().min(3).max(1000).default(12),
  requestTimeoutMs: z.number().int().min(1000).max(180000).default(90000),
  leaseMs: z.number().int().min(5000).max(180000).default(30000),
  maxRetries: z.number().int().min(0).max(5).default(2),
}).strict().refine(v => v.selfWakeMaxMs >= v.selfWakeMinMs, 'selfWakeMaxMs must not be smaller').refine(v => !v.selfWakeEnabled || v.selfWakeMaxMs < v.maxDurationMs, 'Autonomous wakes must fit inside the execution budget; disable selfWakeEnabled for shorter experiments');
export type Settings = z.infer<typeof SettingsSchema>;
export const SessionCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  participants: z.array(z.object({ characterId: Slug, profileId: Slug, slot: Slug }).strict()).min(3).max(16),
  settings: SettingsSchema.default(() => SettingsSchema.parse({})),
}).strict().refine(v => new Set(v.participants.map(p => p.slot)).size === v.participants.length, 'Use distinct worker slots');
export type SessionCreate = z.infer<typeof SessionCreateSchema>;
export const ActSchema = z.enum(['answer', 'question', 'comment', 'agreement', 'joke', 'correction', 'topic']);
export const MessageInputSchema = z.object({
  text: Text, replyTo: Id.nullable().default(null), addressedTo: z.array(Id).max(16).default([]),
  act: ActSchema.optional(),
}).strict();
export const IntentSchema = z.object({
  act: ActSchema, intent: z.string().trim().min(1).max(500),
  replyTo: Id.nullable(), addressedTo: z.array(Id).max(16),
}).strict();
export type Intent = z.infer<typeof IntentSchema>;
export const DeferSchema = z.object({
  kind: z.enum(['time', 'new_message', 'answer_from']),
  afterMs: z.number().int().min(100).max(300000), agentId: Id.nullable(),
}).strict().refine(v => v.kind !== 'answer_from' || v.agentId !== null, 'answer_from needs agentId');
export type Deferral = z.infer<typeof DeferSchema>;
export const DecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('SPEAK'), intent: IntentSchema }).strict(),
  z.object({ decision: z.literal('DEFER'), reason: z.string().max(160), defer: DeferSchema }).strict(),
  z.object({ decision: z.literal('ABSTAIN'), reason: z.string().max(160) }).strict(),
]);
export const DraftSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('DRAFT'), text: Text }).strict(),
  z.object({ decision: z.literal('DROP'), reason: z.string().max(160) }).strict(),
]);
export const ReviewSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('KEEP') }).strict(),
  z.object({ decision: z.literal('REWRITE'), text: Text, intent: IntentSchema }).strict(),
  z.object({ decision: z.literal('DEFER'), reason: z.string().max(160), defer: DeferSchema }).strict(),
  z.object({ decision: z.literal('DROP'), reason: z.string().max(160) }).strict(),
]);
export const MemorySchema = z.object({ notes: z.array(z.object({
  text: z.string().trim().min(1).max(1000), sourceMessageIds: z.array(Id).min(1).max(8),
}).strict()).max(4), changes:z.array(MemoryChangeSchema).max(4).optional() }).strict()
  .refine(x=>x.notes.length+(x.changes?.length??0)<=4,'At most four memory changes per result');
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
}).strict();
export type Usage = z.infer<typeof UsageSchema>;
export const ErrorCodeSchema = z.enum(['API_ERROR', 'AUTH_ERROR', 'RATE_LIMIT', 'TIMEOUT', 'FORMAT_ERROR', 'CONTEXT_LIMIT', 'CANCELLED', 'CONFIG_ERROR', 'OUTPUT_TRUNCATED', 'EMPTY_RESPONSE', 'OUTPUT_TOO_LARGE', 'RESPONSE_REFUSED', 'DELIVERY_UNKNOWN']);
export type ModelErrorCode = z.infer<typeof ErrorCodeSchema>;
export type RunKind = 'decide' | 'draft' | 'review' | 'memory' | 'observe';
export const ObserveSchema = z.object({ decision: z.literal('ABSTAIN'), reason: z.string().max(160) }).strict();
export const StatefulOutputSchemas = {
  observe: z.object({ action: ObserveSchema, statePatch: StatePatchSchema.nullable() }).strict(),
  decide: z.object({ action: DecisionSchema, statePatch: StatePatchSchema.nullable() }).strict(),
  draft: z.object({ action: DraftSchema, statePatch: StatePatchSchema.nullable() }).strict(),
  review: z.object({ action: ReviewSchema, statePatch: StatePatchSchema.nullable() }).strict(),
  memory: z.object({ action: MemorySchema, statePatch: StatePatchSchema.nullable() }).strict(),
};
export const OutputSchemas = {
  observe: z.union([ObserveSchema, StatefulOutputSchemas.observe]),
  decide: z.union([DecisionSchema, StatefulOutputSchemas.decide]),
  draft: z.union([DraftSchema, StatefulOutputSchemas.draft]),
  review: z.union([ReviewSchema, StatefulOutputSchemas.review]),
  memory: z.union([MemorySchema, StatefulOutputSchemas.memory]),
};
export type RunOutput = z.infer<typeof OutputSchemas.observe> | z.infer<typeof OutputSchemas.decide> | z.infer<typeof OutputSchemas.draft> | z.infer<typeof OutputSchemas.review> | z.infer<typeof OutputSchemas.memory>;
export type Lifecycle = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'ENDED';
export type Activity = 'ACTIVE' | 'QUIET' | 'DEGRADED' | 'BUDGET_PAUSED';
export type PublicMessage = {
  id: string; sessionId: string; sequence: number; threadRootId: string; revision: number; authorId: string | null; authorName: string;
  characterId: string | null; characterVersion: number | null; text: string; act: string;
  replyTo: string | null; addressedTo: string[]; deleted: boolean; episode: number; createdAt: number;
};
export type PublicAgent = { id: string; slot: string; characterId: string; characterVersion: number; name: string;
  presentationRef: string | null; profileId: string; enabled: boolean; status: string; workerOnline: boolean; lastSeenAt: number | null; nextRetryAt: number | null };
export type PublicSession = { id: string; title: string; lifecycle: Lifecycle; activity: Activity; revision: number;
  epoch: number; createdAt: number; startedAt: number | null; stopReason: string | null;
  calls: number; botMessages: number; budget: { callsUsed: number; messagesUsed: number; activeMs: number }; settings: Settings; mode: 'mock' | 'live' };
export type Snapshot = { session: PublicSession; agents: PublicAgent[]; messages: PublicMessage[]; cursor: string; historyCursor: string | null };
export type PublicEvent = { id: string; sessionId: string; kind: string; revision: number;
  createdAt: number; message?: PublicMessage; data: Record<string, unknown> };
export type Context = {
  self: { id: string; character: Character; profileHash?: string; privateState?: PrivateState }; observation?: ObservationManifest; participants: PublicAgent[]; revision: number; trigger: string;
  messages: PublicMessage[]; delta: PublicMessage[]; historyTruncated: boolean;
  agenda?: AgendaContext;
  conversation?: ConversationFlow;
  delivery?: InputWindow; progress?: InputProgress; selection?: InputSelection;
  recall?: { algorithm: 'local-word-evidence-v1' | 'owner-meaning-v2'; selected: {id:string;score:number;provenance:string}[]; omittedForBudget: string[]; elapsedMs?:number; candidates?:number; additionalCalls?:number };
  inputBudget?: {method:'utf8-upper-bound';maxTokens:number;reservedOutputTokens:number;estimatedInputTokens:number;tokenizer:'unknown'};
  coverage?: { fromRevision: number; throughRevision: number; targetRevision: number; complete: boolean };
  retrieved?: RetrievalResult[];
  memories: MemoryNote[];
  questions: QuestionHint[];
  sources: { id: string; title: string; text: string; url: string | null; publishedAt: string | null; fetchedAt: number; version?:number; offset?:number; totalChars?:number; nextCursor?:string|null }[];
  candidate: { id: string; version: number; intent: Intent; text: string | null; reviewedRevision: number } | null;
};
export type ClaimedRun = { id: string; token: string; kind: RunKind; workerEpoch: number; sessionEpoch: number;
  leaseMs: number; timeoutMs: number; contextChars: number; profile: ModelProfile; context: Context };

export class AppError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); }
}
export function ensure(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new AppError(status, code);
}

export const LookupRequestSchema = z.object({
  kind: z.enum(['messages', 'memories', 'message', 'source']), query: z.string().trim().min(1).max(200),
  cursor: z.string().max(2048).nullable().default(null),
}).strict();
export const LookupSchema = z.object({ decision: z.literal('LOOKUP'), requests: z.array(LookupRequestSchema).min(1).max(3) }).strict();
export type LookupRequest = z.infer<typeof LookupSchema>['requests'][number];
export const WireOutputSchemas = {
  observe: z.union([OutputSchemas.observe, LookupSchema]),
  decide: z.union([OutputSchemas.decide, LookupSchema]), draft: z.union([OutputSchemas.draft, LookupSchema]),
  review: z.union([OutputSchemas.review, LookupSchema]), memory: OutputSchemas.memory,
};
export type MemoryNote = { id: string; text: string; sourceMessageIds: string[]; provenance?:MemoryProvenance };
export type Page<T> = { items: T[]; nextCursor: string | null; highWater: number };
export type RetrievalResult = { request: LookupRequest; messages: PublicMessage[]; memories: MemoryNote[]; sources?: SourceChunk[]; nextCursor: string | null };
