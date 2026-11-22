import { getTenantCtx } from '@/app-layer/context';
import { saveAiGovAnswer } from '@/app-layer/usecases/ai-gov-self-assessment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

const AnswerBodySchema = z
    .object({
        answer: z.enum(['NA', 'NO', 'PARTIALLY', 'YES']),
        note: z.string().max(4000).nullish(),
    })
    .strip();

// PUT → autosave one answer. questionId from the path. Mutation-tier
// rate-limited (withApiErrorHandling default on PUT).
export const PUT = withApiErrorHandling(
    withValidatedBody(
        AnswerBodySchema,
        async (
            req,
            { params }: { params: Promise<{ tenantSlug: string; questionId: string }> },
            body,
        ) => {
            const { questionId, ...rest } = await params;
            const ctx = await getTenantCtx(rest, req);
            const saved = await saveAiGovAnswer(ctx, {
                questionId,
                answer: body.answer,
                // Absent leaves the stored note; null clears it (#5128).
                note: body.note,
            });
            return jsonResponse({ id: saved.id, questionId, answer: saved.answer });
        },
    ),
);
