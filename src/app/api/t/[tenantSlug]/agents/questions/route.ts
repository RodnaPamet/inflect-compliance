import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { askAdHocQuestion } from '@/app-layer/usecases/ad-hoc-question';
import { AGENT_QUESTION_LIMIT } from '@/lib/security/rate-limit';
import { z } from 'zod';

/**
 * ASK THE WORKSPACE A QUESTION (#3869).
 *
 * ── THE GATE IS READER-LEVEL, FOLLOWING THE ASSISTANT'S PRECEDENT ───────────
 *
 * `controls.view`, the same key `/assistant/ask` takes, and for the reason that
 * rule records: the gate is about what the thing may READ, and proposing is
 * safe at reader level because a proposal lands in the queue as PENDING and
 * commits nothing.
 *
 * The argument is STRICTLY STRONGER here, which is why the same key is right
 * rather than merely available:
 *
 *   • `ad-hoc-question` declares `readOnly: true`, so the run is offered no
 *     propose surface at all — there is nothing to queue, let alone commit;
 *   • ADR 0004 determined BY TEST that the answer cannot reach data the asker
 *     could not reach through the UI, because a session is its own principal
 *     and the propose class authorises on it.
 *
 * So an admin key here would be wrong, not merely strict: it would make the
 * feature admin-only while the thing it protects against cannot happen.
 *
 * ── THE RATE LIMIT IS THE FIRST PER-USER ONE IN THE PRODUCT ─────────────────
 *
 * `getUserId` has been an accepted option on this wrapper all along and no
 * route has ever supplied it, so every limit in the product keys on
 * `<scope>:ip:<ip>:anon`. Supplying it makes the key
 * `<scope>:ip:<ip>:u:<userId>`.
 *
 * It resolves from the SESSION, never from the body or a header: a caller that
 * could name its own rate-limit subject would pick a fresh one per request.
 */
const AskSchema = z
    .object({
        // Bounds are enforced in `readAdHocQuestion`, not here, so ONE place
        // decides them and the usecase is safe to call from anywhere. The
        // schema's job is the shape: a body with no `question` is a 400 before
        // any of that runs.
        question: z.string(),
    })
    .strict();

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('controls.view', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, AskSchema);
        const started = await askAdHocQuestion(ctx, body.question);
        // 202, not 200: the run has STARTED and the answer is not ready. A 200
        // with a run id invites a client to treat the response as the answer.
        return jsonResponse({ runId: started.runId }, { status: 202 });
    }),
    {
        rateLimit: {
            config: AGENT_QUESTION_LIMIT,
            scope: 'agent-question',
            // THE PER-USER KEY. From the session only.
            getUserId: async (request) => {
                const { getToken } = await import('next-auth/jwt');
                const token = await getToken({ req: request, secret: process.env.AUTH_SECRET });
                return typeof token?.sub === 'string' ? token.sub : null;
            },
        },
    },
);
