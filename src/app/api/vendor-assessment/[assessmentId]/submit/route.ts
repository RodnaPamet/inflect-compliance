/**
 * POST /api/vendor-assessment/[assessmentId]/submit
 *
 * Body:
 *   {
 *     token: string,                  // raw token from the URL
 *     answers: [
 *       { questionId, answerJson, evidenceId? }
 *     ]
 *   }
 *
 * Public, token-gated. Validates required-field presence and per-
 * answer-type shape, persists answers in a transaction, transitions
 * status to SUBMITTED.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
    submitResponse,
    ExternalAccessDenied,
    ResponseValidationError,
} from '@/app-layer/usecases/vendor-assessment-response';

const SubmitBodySchema = z
    .object({
        token: z.string().min(16).max(512),
        answers: z
            .array(
                z.object({
                    questionId: z.string().min(1).max(120),
                    answerJson: z.unknown(),
                    evidenceId: z.string().nullable().optional(),
                }),
            )
            .max(500),
    })
    .strip();

export async function POST(
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ assessmentId: string }> },
) {
    const params = await paramsPromise;
    let body: z.infer<typeof SubmitBodySchema>;
    try {
        body = SubmitBodySchema.parse(await req.json());
    } catch (err) {
        return NextResponse.json(
            { error: 'invalid_body', issues: (err as { issues?: unknown }).issues },
            { status: 400 },
        );
    }

    try {
        const result = await submitResponse(
            body.token,
            params.assessmentId,
            body.answers,
        );
        return NextResponse.json({
            status: result.status,
            submittedAt: result.submittedAt.toISOString(),
            provisionalScore: result.provisionalScore,
        });
    } catch (err) {
        if (err instanceof ExternalAccessDenied) {
            const statusCode =
                err.reason === 'expired' ||
                err.reason === 'revoked' ||
                err.reason === 'wrong_status'
                    ? 410
                    : 401;
            return NextResponse.json(
                { error: 'access_denied', reason: err.reason },
                { status: statusCode },
            );
        }
        if (err instanceof ResponseValidationError) {
            return NextResponse.json(
                {
                    error: 'validation_failed',
                    fieldErrors: err.fieldErrors,
                },
                { status: 400 },
            );
        }
        throw err;
    }
}
