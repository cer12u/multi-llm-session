import { z } from 'zod';

/** One owner's interpretation, never a globally certified answer or a delivery rule. */
export const QuestionAssessmentSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['open', 'partial', 'awaiting_confirmation', 'resolved', 'deferred']),
  addressing: z.enum(['explicit', 'inferred', 'unknown']),
  addressedTo: z.array(z.string().uuid()).max(16),
  replyIds: z.array(z.string().uuid()).max(7),
  topics: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
}).strict().refine(value => new Set(value.addressedTo).size === value.addressedTo.length &&
  new Set(value.replyIds).size === value.replyIds.length && new Set(value.topics).size === value.topics.length,
  'Question links and topics must be distinct')
  .refine(value => value.addressing === 'unknown' ? value.addressedTo.length === 0 : value.addressedTo.length > 0,
    'Unknown addressees are empty; explicit or inferred addressees must be identified')
  .refine(value => !['partial', 'awaiting_confirmation', 'resolved'].includes(value.status) || value.replyIds.length > 0,
    'An answer interpretation requires an observed reply')
  .refine(value => !value.replyIds.includes(value.messageId), 'A question is not its own answer');
export type QuestionAssessment = z.infer<typeof QuestionAssessmentSchema>;
export type QuestionHint = {
  messageId: string; text: string; from: string | null;
  revision?: number; addressedTo?: string[]; inferredAddressees?: string[];
  addressing?: QuestionAssessment['addressing'];
  status?: QuestionAssessment['status'] | 'unassessed';
  classification?: 'declared-question' | 'owner-interpreted';
  topics?: string[]; excerpt?: boolean;
};
