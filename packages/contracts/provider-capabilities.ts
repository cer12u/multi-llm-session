import { z } from 'zod';

/** Operator declarations, not a claim that a real Provider was probed or verified. */
export const ProviderCapabilitiesSchema = z.object({
  jsonModes: z.array(z.enum(['none','json','schema'])).min(1).max(3),
  outputTokenParameter: z.enum(['max_tokens','max_completion_tokens','num_predict']),
  temperatureSupported: z.boolean(),
  usage: z.enum(['unknown','reported','unavailable']),
}).strict().refine(v=>new Set(v.jsonModes).size===v.jsonModes.length,'Duplicate JSON modes');
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
