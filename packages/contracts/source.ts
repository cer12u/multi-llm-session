import { z } from 'zod';

const AudienceSchema = z.array(z.string().uuid()).min(1).max(16).nullable()
  .refine(value => value === null || new Set(value).size === value.length, 'Duplicate source audience');
const LinkSchema = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Source links must be HTTP(S) without embedded credentials');
export const SourceSchema = z.object({
  title: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(20000),
  url: LinkSchema.nullable().default(null), publishedAt: z.string().datetime().nullable().default(null),
  audience: AudienceSchema.default(null), enabled: z.boolean().default(true),
}).strict();
export const SourceUpdateSchema = SourceSchema.extend({ expectedVersion: z.number().int().nonnegative() });
export const FeedSubscriptionSchema = z.object({
  configId: z.string().regex(/^[a-z0-9-]{1,64}$/), expectedVersion: z.number().int().nonnegative(),
  audience: AudienceSchema.default(null), enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(60000).max(86400000).optional(),
}).strict();
export type SourceInput = z.infer<typeof SourceSchema>;
export type SourceChunk = {
  id: string; title: string; text: string; url: string | null; publishedAt: string | null;
  fetchedAt: number; version: number; offset: number; totalChars: number; nextCursor: string | null;
};
