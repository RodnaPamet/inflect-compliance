import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { enqueue } from '@/app-layer/jobs/queue';
import { dispatchJobId, MINUTE_MS } from '@/app-layer/jobs/fan-out';

/**
 * SP-3 — on-demand delta sync for a SharePoint connection. Enqueues the
 * `sharepoint-delta-sync` job and returns its id for polling. Gated by
 * `evidence.upload` (re-imports write evidence).
 */
/**
 * `connectionId` is bounded in CHARSET and LENGTH, not merely non-empty.
 *
 * It is interpolated into the BullMQ job id below, which becomes a Redis key —
 * and it reaches that interpolation before anything verifies the connection
 * exists. `z.string().min(1)` therefore let a tenant member put arbitrary
 * content of arbitrary length into a key: newlines, control characters, ten
 * kilobytes of text, and whatever indexes or logs that key flows into.
 *
 * Bounded to the shape every id in this system actually has (cuid, and uuid or
 * nanoid if that ever changes) rather than pinned to `cuid()` specifically, so
 * an id-format migration does not silently start rejecting valid requests.
 *
 * It also removes a latent ambiguity: the job id nests this value inside a
 * `:`-joined composite which `dispatchJobId` then `:`-joins again. That is not
 * exploitable today — the other component is the authenticated tenant id, and
 * cuids carry no colon — but the claim held only as long as no component was
 * user-supplied, and this route was the first to make one so.
 */
const Body = z.object({
    connectionId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/, 'connectionId must be an opaque identifier'),
});

export const POST = withApiErrorHandling(
    requirePermission('evidence.upload', async (req: NextRequest, _routeArgs, ctx) => {
        const { connectionId } = Body.parse(await req.json());
        // A deterministic id per (connection, minute). This route had none and
        // sits on the default 60/min mutation tier, so double-clicking "Sync
        // now" queued two concurrent delta syncs for the same connection —
        // which each create a fresh Evidence row for every changed file.
        //
        // The MINUTE bucket is right here, not the 4h one the scheduled
        // dispatcher uses: an operator who fixes a permission and clicks again
        // must get a real run, not a silent dedupe against their own last
        // click. The per-connection lock is the backstop that makes manual and
        // scheduled runs safe against each other.
        const job = await enqueue(
            'sharepoint-delta-sync',
            {
                tenantId: ctx.tenantId,
                connectionId,
                actorUserId: ctx.userId,
                triggeredBy: 'manual',
                requestId: ctx.requestId,
            },
            {
                jobId: dispatchJobId(
                    'sharepoint-delta-sync-manual',
                    `${ctx.tenantId}:${connectionId}`,
                    MINUTE_MS,
                ),
            },
        );
        return jsonResponse({ jobId: job.id }, { status: 202 });
    }),
);
