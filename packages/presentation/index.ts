import { z } from 'zod';

const Uuid = z.string().uuid();
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Status = z.enum(['thinking','reviewing','remembering','observing','listening','idle','ready','deferred','waiting','retrying','error','disabled','paused','ended']);
/** Presentation DTOs deliberately exclude persona, working state, candidates and provider configuration. */
export const PresentationMessageSchema = z.object({
  id: Uuid, sessionId: Uuid, sequence: Counter, revision: Counter,
  authorId: Uuid.nullable(), authorName: z.string().max(80),
  characterId: z.string().max(64).nullable(), characterVersion: Counter.nullable(),
  text: z.string().max(8000), deleted: z.boolean(), createdAt: Counter,
  replyTo: Uuid.nullable(), threadRootId: Uuid,
}).transform(message => ({ ...message, text: message.deleted ? '' : message.text }));
export const PresentationEventSchema = z.object({
  schemaVersion: z.literal(1).default(1), id: z.string().max(100), sessionId: Uuid,
  kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), revision: Counter, createdAt: Counter,
  message: PresentationMessageSchema.optional(),
  data: z.object({ agentId: Uuid.optional(), status: Status.optional() }).default({}),
}).refine(event => cursorSequence(event.id, event.sessionId) !== null, 'Invalid session cursor')
  .refine(event => !event.message || event.message.sessionId === event.sessionId, 'Message belongs to another session')
  .refine(event => !event.kind.startsWith('message.') || !!event.message, 'Message event needs its public message');
export type PresentationEvent = z.infer<typeof PresentationEventSchema>;
export interface PresentationAdapter { handle(event: PresentationEvent): void | Promise<void>; }

export function cursorSequence(cursor: string, sessionId: string): number | null {
  const prefix = sessionId + ':';
  if (!cursor.startsWith(prefix)) return null;
  const value = cursor.slice(prefix.length);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value); return Number.isSafeInteger(number) ? number : null;
}
export function publicPresentationEvent(input: unknown): PresentationEvent | null {
  const parsed = PresentationEventSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** One session/connection only. Text is primary; an optional enhancement can never acknowledge a Core command. */
export class PresentationDispatcher {
  private position: number;
  private closed = false;
  private busy = false;
  private disabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly sessionId: string, private readonly text: PresentationAdapter,
    private readonly enhancement?: PresentationAdapter, cursor = sessionId + ':0', private readonly timeoutMs = 1000) {
    this.position = cursorSequence(cursor, sessionId) ?? 0;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new Error('INVALID_PRESENTATION_TIMEOUT');
  }
  get cursor(): string { return this.sessionId + ':' + this.position; }
  get enhancementDisabled(): boolean { return this.disabled; }
  receive(input: unknown): boolean {
    if (this.closed) return false;
    const event = publicPresentationEvent(input);
    if (!event || event.sessionId !== this.sessionId) return false;
    const position = cursorSequence(event.id, this.sessionId)!;
    if (position <= this.position) return false;
    this.position = position;
    // Each consumer receives its own sanitized copy. Neither mutation nor a rejected promise affects the other.
    try { void Promise.resolve(this.text.handle(structuredClone(event))).catch(() => {}); } catch { /* UI recovery is independent. */ }
    if (!this.enhancement || this.disabled || this.busy) return true;
    this.busy = true;
    this.timer = setTimeout(() => { this.disabled = true; this.timer = null; }, this.timeoutMs);
    try {
      void Promise.resolve(this.enhancement.handle(structuredClone(event))).catch(() => { this.disabled = true; }).finally(() => {
        this.busy = false; if (this.timer) clearTimeout(this.timer); this.timer = null;
      });
    } catch { this.disabled = true; this.busy = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
    return true;
  }
  dispose(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
