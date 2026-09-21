import { z } from 'zod';

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
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const SettingsSchema = z.object({
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
export const MessageInputSchema = z.object({
  text: Text, replyTo: Id.nullable().default(null), addressedTo: z.array(Id).max(16).default([]),
}).strict();
export const ActSchema = z.enum(['answer', 'question', 'comment', 'agreement', 'joke', 'correction', 'topic']);
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
}).strict()).max(4) }).strict();
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
}).strict();
export type Usage = z.infer<typeof UsageSchema>;
export const ErrorCodeSchema = z.enum(['API_ERROR', 'AUTH_ERROR', 'RATE_LIMIT', 'TIMEOUT', 'FORMAT_ERROR', 'CONTEXT_LIMIT', 'CANCELLED', 'CONFIG_ERROR']);
export type ModelErrorCode = z.infer<typeof ErrorCodeSchema>;
export type RunKind = 'decide' | 'draft' | 'review' | 'memory';
export const OutputSchemas = { decide: DecisionSchema, draft: DraftSchema, review: ReviewSchema, memory: MemorySchema };
export type RunOutput = z.infer<typeof DecisionSchema> | z.infer<typeof DraftSchema> | z.infer<typeof ReviewSchema> | z.infer<typeof MemorySchema>;
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
  self: { id: string; character: Character }; participants: PublicAgent[]; revision: number; trigger: string;
  messages: PublicMessage[]; delta: PublicMessage[]; historyTruncated: boolean;
  coverage?: { fromRevision: number; throughRevision: number; targetRevision: number; complete: boolean };
  retrieved?: RetrievalResult[];
  memories: { id: string; text: string; sourceMessageIds: string[] }[];
  questions: { messageId: string; text: string; from: string | null }[];
  sources: { id: string; title: string; text: string; url: string | null; publishedAt: string | null; fetchedAt: number }[];
  candidate: { id: string; version: number; intent: Intent; text: string | null; reviewedRevision: number } | null;
};
export type ClaimedRun = { id: string; token: string; kind: RunKind; workerEpoch: number; sessionEpoch: number;
  leaseMs: number; timeoutMs: number; contextChars: number; profile: ModelProfile; context: Context };
export const SourceSchema = z.object({
  title: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(20000),
  url: z.string().url().nullable().default(null), publishedAt: z.string().datetime().nullable().default(null),
}).strict();

export class AppError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); }
}
export function ensure(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new AppError(status, code);
}

// LOOKUP is a bounded worker action, never a public utterance or an arbitrary tool call.
export const LookupRequestSchema = z.object({
  kind: z.enum(['messages', 'memories', 'message']), query: z.string().trim().min(1).max(200),
  cursor: z.string().max(2048).nullable().default(null),
}).strict();
export const LookupSchema = z.object({ decision: z.literal('LOOKUP'), requests: z.array(LookupRequestSchema).min(1).max(3) }).strict();
export type LookupRequest = z.infer<typeof LookupRequestSchema>;
export const WireOutputSchemas = {
  decide: z.union([DecisionSchema, LookupSchema]), draft: z.union([DraftSchema, LookupSchema]),
  review: z.union([ReviewSchema, LookupSchema]), memory: MemorySchema,
};
export type MemoryNote = { id: string; text: string; sourceMessageIds: string[] };
export type Page<T> = { items: T[]; nextCursor: string | null; highWater: number };
export type RetrievalResult = { request: LookupRequest; messages: PublicMessage[]; memories: MemoryNote[]; nextCursor: string | null };
