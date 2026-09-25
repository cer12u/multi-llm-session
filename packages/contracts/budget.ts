import {z} from 'zod';

const tokens=z.number().int().min(1).max(1_000_000_000_000).nullable();
/** Optional settings extension. Absence preserves the previously authorized manual budget. */
export const OperationalBudgetSchema=z.object({
  mode:z.enum(['experiment','continuous']),
  windowMs:z.number().int().min(1000).max(604800000),
  autoRenew:z.boolean().default(false),
  maxTokens:tokens.default(null),
  scopeMaxCalls:z.number().int().min(1).max(1000000).nullable().default(null),
  scopeMaxTokens:tokens.default(null),
}).strict().refine(p=>p.mode==='continuous'||!p.autoRenew,'An experiment never renews automatically');
export type OperationalBudget=z.infer<typeof OperationalBudgetSchema>;
export const BudgetPolicyUpdateSchema=z.object({expectedEpoch:z.number().int().nonnegative(),policy:OperationalBudgetSchema.nullable()}).strict();
