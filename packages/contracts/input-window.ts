import { z } from 'zod';

/** A contiguous range of durable input notifications, distinct from public revision and model understanding. */
export const InputWindowSchema = z.object({
  purpose: z.enum(['observation', 'memory']),
  fromInput: z.number().int().nonnegative(), throughInput: z.number().int().nonnegative(),
  targetInput: z.number().int().nonnegative(), complete: z.boolean(),
  entries: z.array(z.object({
    inputId: z.number().int().positive(), kind: z.enum(['message', 'source']),
    id: z.string().uuid(), eventVersion: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(), superseded: z.boolean(), excerpt: z.boolean(),
  }).strict()).max(100),
}).strict();
export type InputWindow = z.infer<typeof InputWindowSchema>;
export type InputProgress = {
  observedInput: number; memoryInput: number; highWater: number;
  observationPending: number; memoryPending: number;
  oldestObservationAt: number | null; oldestMemoryAt: number | null;
};
export type InputSelection = { omittedRecent: number; omittedMemories: number; omittedSources: number; reason: 'bounded-before-observation-binding' };
