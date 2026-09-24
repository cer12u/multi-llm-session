import { z } from 'zod';

/** The owner's assessment, not a global moderator verdict or a forced runtime stop. */
export const ParticipationAssessmentSchema = z.object({
  code: z.enum(['SATISFIED', 'CONTENT_LOOP']),
  throughInput: z.number().int().nonnegative(),
}).strict();
export type ParticipationAssessment = z.infer<typeof ParticipationAssessmentSchema>;
export type RepetitionSignal = {
  kind: 'repeated_question' | 'reciprocal_overlap' | 'self_reply';
  algorithm: 'bounded-lexical-v1';
  evidence: { id: string; version: number }[];
};
export type ConversationFlow = {
  advisoryOnly: true;
  window: { messageIds: string[]; completeHistory: false };
  signals: RepetitionSignal[];
  recentPurposes: { messageId: string; revision: number; act: string; purpose: string; excerpt: boolean }[];
  previousAssessment: { code: ParticipationAssessment['code']; current: boolean } | null;
};
