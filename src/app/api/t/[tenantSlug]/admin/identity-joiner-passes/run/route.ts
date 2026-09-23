/**
 * POST /api/t/:tenantSlug/admin/identity-joiner-passes/run
 *   Body: { "provider": "entra-id" | "active-directory" }
 *   Enqueues ONE joiner pass for (this tenant, that directory), now, off the
 *   04:30 schedule. 202 + the BullMQ job id.
 *
 * ═══ WHY THIS EXISTS — THE PROVING RUN HAD NO TRIGGER ═══
 *
 * `runIdentityJoinerPass` had exactly one caller: the 04:30
 * `identity-joiner-dispatch` fan-out. That fan-out enqueues with a jobId
 * floored to the UTC DAY (`dispatchJobId(..., DAILY_BUCKET_MS)` in
 * `jobs/identity-joiner.ts:126-129`), which is right for a dispatcher — it
 * stops a retry or a redeploy replaying the schedule from writing a second
 * artefact for the same morning.
 *
 * It also meant re-firing the dispatcher the same day was a SILENT NO-OP.
 * BullMQ dedupes against the id it already holds: nothing enqueued, nothing
 * thrown, no refusal row, no log line saying "already ran today". From outside
 * that is indistinguishable from a dead worker.
 *
 * #2687 asks for two DRY_RUN proving runs and names this route as item 4 —
 * "so a proving run does not have to wait for a cron tick". Without it the
 * only way to exercise the joiner is to wait for 04:30 and hope, and the
 * morning you most want a re-run is the morning after an operator has just
 * fixed the cause of a refusal — `NO_DEPARTMENT_MAP` until #2713, and a
 * missing fallback group after it.
 *
 * ═══ THE MINUTE BUCKET IS THE WHOLE POINT ═══
 *
 * The id here is minted from `MINUTE_MS`, not `DAILY_BUCKET_MS`. A deliberate
 * re-run must not be swallowed by the dedupe key of the run it is re-running —
 * that is the defect, and inheriting the daily bucket would reproduce it
 * exactly while looking like a working button.
 *
 * A bucket is still used rather than no `jobId`, for a reason that is the
 * JOINER's rather than the leaver's. `JOB_DEFAULTS['identity-joiner-pass']`
 * pins `attempts: 1` because each run inserts ONE `IntegrationExecution` row
 * holding a decision per starter, and the seven-day DRY_RUN window is read by
 * counting and comparing those rows. Two passes a minute apart put two rows on
 * one morning, and an observation window that cannot tell a run from a
 * double-click is not an observation window. One minute collapses a
 * double-click while still giving an operator who just changed something a
 * real run on their next click.
 *
 * ═══ ITS OWN JOB-NAME PREFIX ═══
 *
 * `identity-joiner-pass-manual`, not the job's own name. The enqueued JOB is
 * still `identity-joiner-pass` — executor, payload and `JOB_DEFAULTS` are the
 * scheduled path's, deliberately, because a manual run that behaved
 * differently from the 04:30 one would be proving something other than the
 * thing that runs at 04:30. Only the dedupe NAMESPACE differs, so a manual id
 * can never land on a scheduled one.
 *
 * ═══ AUTHORISATION — OWNER, AND ITS OWN MAP RULE ═══
 *
 * `admin.tenant_lifecycle`, which `src/lib/permissions.ts` denies ADMIN.
 *
 * The leaver's equivalent justifies this key by saying the button "makes the
 * product write to a system we do not own". THAT ARGUMENT DOES NOT HOLD HERE
 * AND IS NOT BORROWED: `JOINER_MAX_MODE` is `DRY_RUN`, the snapshot
 * provisioner refuses every mutating verb, and the pass writes no directory
 * and no HRIS. The key is the same for a DIFFERENT reason — the artefact this
 * produces names which of a customer's people the product would create an
 * account for and at what address, which is the same authority as reading the
 * report (the subtree rule below) and the same class as granting the create.
 *
 * `ROUTE_PERMISSIONS` carries an exact-anchored rule for THIS path, ordered
 * BEFORE the `identity-joiner-passes(/...)` subtree rule that already covers
 * it. Matching is first-match-wins, and the subtree rule is about READING a
 * report; if that read surface is ever given a weaker key, this trigger must
 * not inherit it.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { parseJsonBody } from '@/lib/validation/route';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { logEvent } from '@/app-layer/events/audit';
import prisma from '@/lib/prisma';
import { enqueue } from '@/app-layer/jobs/queue';
import { dispatchJobId, MINUTE_MS } from '@/app-layer/jobs/fan-out';
import { WRITABLE_IDENTITY_PROVIDERS } from '@/app-layer/integrations/identity-writable-providers';

type JoinerPassRunParams = { tenantSlug: string };

export const MANUAL_JOINER_PASS_JOB_KEY = 'identity-joiner-pass-manual';

const RunJoinerPassSchema = z
    .object({
        provider: z.enum(WRITABLE_IDENTITY_PROVIDERS),
    })
    .strict();

export const POST = withApiErrorHandling(
    requirePermission<JoinerPassRunParams>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, _routeArgs, ctx) => {
            const { provider } = await parseJsonBody(req, RunJoinerPassSchema);

            const jobId = dispatchJobId(
                MANUAL_JOINER_PASS_JOB_KEY,
                `${ctx.tenantId}:${provider}`,
                MINUTE_MS,
            );

            // Through the typed `enqueue()` wrapper, never a raw `queue.add`:
            // the wrapper is what applies `JOB_DEFAULTS['identity-joiner-pass']`,
            // and `attempts: 1` there is a constraint on the ARTEFACT — three
            // retries would put three rows on one morning.
            const job = await enqueue(
                'identity-joiner-pass',
                { tenantId: ctx.tenantId, provider },
                { jobId },
            );

            // The record that somebody ASKED, written before the worker has
            // done anything. The pass writes its own execution row, but only if
            // it is picked up; this row survives a worker that never runs and
            // BullMQ's removeOnComplete horizon.
            await logEvent(prisma, ctx, {
                action: 'IDENTITY_JOINER_PASS_REQUESTED',
                entityType: 'Tenant',
                entityId: ctx.tenantId,
                details:
                    `Off-schedule identity joiner pass requested for ${provider} ` +
                    `by user ${ctx.userId}`,
                detailsJson: {
                    category: 'custom',
                    event: 'identity_joiner_pass_requested',
                    summary: `Off-schedule joiner pass queued for ${provider}`,
                },
                metadata: { provider, jobId, trigger: 'manual' },
            });

            return jsonResponse(
                { status: 'queued', jobId: job.id, provider },
                { status: 202 },
            );
        },
    ),
    {
        rateLimit: {
            config: API_KEY_CREATE_LIMIT,
        },
    },
);
