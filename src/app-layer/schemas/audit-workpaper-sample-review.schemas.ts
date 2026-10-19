/**
 * The body of `POST /api/t/:slug/audits/workpaper-reviews/:reviewId` (#3677,
 * step 3d) — internal audit's answer to one sampled workpaper.
 *
 * `.strict()`, so an undeclared key — a `note`, a `comment`, any free text —
 * is a 400 rather than silently dropped: the record has no prose, and a client
 * that believes it sent some must be told it did not land. Dissent codes come
 * from the stable vocabulary only; a DISSENTED answer names at least one, and
 * no other answer names any.
 */
import { z } from 'zod';

import {
    WORKPAPER_REVIEW_ANSWERS,
    WORKPAPER_REVIEW_DISSENT_CODES,
} from '@/lib/agentic/workpaper-review-codes';

export const RecordWorkpaperReviewSchema = z
    .object({
        outcome: z.enum(WORKPAPER_REVIEW_ANSWERS),
        dissentCodes: z
            .array(z.enum(WORKPAPER_REVIEW_DISSENT_CODES))
            .max(WORKPAPER_REVIEW_DISSENT_CODES.length)
            .optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
        const codes = v.dissentCodes ?? [];
        if (new Set(codes).size !== codes.length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dissentCodes'], message: 'a code is named at most once' });
        }
        if (v.outcome === 'DISSENTED' && codes.length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['dissentCodes'],
                message: 'DISSENT_CODES_REQUIRED: a DISSENTED answer names at least one dissent code',
            });
        }
        if (v.outcome !== 'DISSENTED' && codes.length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['dissentCodes'],
                message: 'DISSENT_CODES_ONLY_ON_DISSENT: dissent codes belong only to a DISSENTED answer',
            });
        }
    });
export type RecordWorkpaperReviewInput = z.infer<typeof RecordWorkpaperReviewSchema>;
