import { z } from 'zod';

/** Private scheduling metadata, never a public message or an executable tool command. */
export const AgendaSignalSchema = z.object({
  planId: z.string().uuid(), entryId: z.string().min(1).max(64),
  kind: z.enum(['time', 'new_message', 'answer_from', 'related_topic']),
  status: z.enum(['PENDING', 'TRIGGERED']),
  requestedAt: z.number().int().nonnegative().nullable(), effectiveAt: z.number().int().nonnegative().nullable(),
  matchedInput: z.number().int().positive().nullable(), matchedVersion: z.number().int().nonnegative().nullable(),
  reason: z.enum(['AWAITING_INPUT', 'AWAITING_TIME', 'TIME_WAKE_DISABLED', 'OUTSIDE_CURRENT_BUDGET', 'MINIMUM_INTERVAL', 'TRIGGERED']),
}).strict();
export type AgendaSignal = z.infer<typeof AgendaSignalSchema>;
export const AgendaContextSchema = z.object({
  now: z.number().int().nonnegative(), minimumIntervalMs: z.number().int().positive(),
  timeWakeEnabled: z.boolean(), nextAutonomousAt: z.number().int().nonnegative(),
  pending: z.array(AgendaSignalSchema).max(16), triggered: z.array(AgendaSignalSchema).max(16),
}).strict();
export type AgendaContext = z.infer<typeof AgendaContextSchema>;
