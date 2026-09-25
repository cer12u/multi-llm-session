import {z} from 'zod';

/** Optional additions: old settings retain their exact previously authorized caps. No automatic renewal. */
export const BudgetLimitsSchema=z.object({
  maxWindowTokens:z.number().int().min(1).max(1000000000000).optional(),
  maxWallDurationMs:z.number().int().min(1000).max(604800000).optional(),
}).strict();
export type BudgetLimits=z.infer<typeof BudgetLimitsSchema>;
