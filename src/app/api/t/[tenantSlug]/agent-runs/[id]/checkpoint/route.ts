import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getRunCheckpointReview } from '@/app-layer/usecases/run-checkpoint-review';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET — one run's OPEN HUMAN CHECKPOINT: its status, and every PENDING
 * proposal it queued with a freshly-computed diff (#3472, plan point 08).
 *
 * This drives the canvas's inline approve/reject. It is a READ ONLY: the
 * decision itself posts to `/agent-proposals/:id/approve|reject`, because the
 * plan's constraint is "approve/reject from the canvas goes through the SAME
 * usecase as /agents/proposals — no second approval path". There is therefore
 * no POST here, and `tests/guards/vr6-execution-overlay.test.ts` asserts that
 * this file declares none.
 *
 * ## Why `requirePermission` on `admin.view` and not the usecase's assertCanRead
 *
 * Every `/agent-runs` route now takes this same gate (#3710). This one took it
 * first, because of what it reaches. A proposal diff carries the
 * CURRENT VALUES of a risk, control, policy or finding beside what an agent
 * proposes to change them to, and the only surface that has ever shown those
 * is `/agents/proposals`, whose page gates on `admin.view` OR, since #3710,
 * `admin.agent_registry_view` (`mayReadAgentActivity`) before it loads
 * anything. The canvas is not an admin surface. Serving the review queue from
 * it under a weaker gate would be a permissions change disguised as a UI
 * feature — so the gate is the one the review surface already applies, both
 * keys, spelled as the middleware so a denial writes the hash-chained
 * `AUTHZ_DENIED` row that a usecase-level assert would not.
 *
 * Tenant scope stays the usecase's predicate, so a run in another tenant is
 * `notFound` rather than `forbidden` — the anti-enumeration posture the rest
 * of the `/agent-runs` family takes.
 */
/*
    BOTH WRAPPERS, in the documented order. `requirePermission`'s own header
    spells this composition out: a denial THROWS `forbidden(...)`, and it is the
    surrounding error wrapper that turns that into a 403 carrying the standard
    `ApiErrorResponse` envelope. Without the outer wrapper the throw escapes as
    a 500 — the denial would be audited correctly and reported as an outage.

    Its sibling `/stream` is exempt from this wrapper and is the exception that
    shows the rule: an SSE `ReadableStream` has no JSON body to put an error
    envelope into. This route returns JSON, so it takes the contract.
*/
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (_req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            return jsonResponse(await getRunCheckpointReview(ctx, params.id));
        },
    ),
);
