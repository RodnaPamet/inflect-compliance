/**
 * POST /api/t/:tenantSlug/admin/identity-joiner-passes/run
 *   Body: { "provider": "entra-id" | "active-directory" }
 *   Enqueues ONE joiner pass for (this tenant, that directory), now, off the
 *   04:30 schedule. 202 + the BullMQ job id.
 *
 * ═══ WHY THIS EXISTS — A PROVING RUN MUST NOT WAIT FOR A CRON TICK ═══
 *
 * #2687's first acceptance is a joiner DRY_RUN executed end to end against the
 * live Entra connection. Without this route the only way to get one is to wait
 * for 04:30 UTC, and then to wait another day for each thing the first run
 * teaches you — a seven-day observation window measured in days per iteration.
 *
 * The leaver learned the same lesson and left the argument written down (#2484):
 * re-firing the dispatcher inside the same day is a SILENT NO-OP, because the
 * fan-out enqueues with a jobId floored to the UTC day. BullMQ dedupes against
 * the id it already holds, so nothing is enqueued, nothing errors, no refusal
 * row is written, and no log line says "already ran today". From inside the
 * product that is indistinguishable from a dead worker.
 *
 * ═══ THE MINUTE BUCKET IS THE WHOLE POINT ═══
 *
 * The id here is minted from `MINUTE_MS`, not `DAILY_BUCKET_MS`. A deliberate
 * re-run must not be swallowed by the dedupe key of the run it is re-running —
 * inheriting the daily bucket would reproduce the defect exactly while looking
 * like a working button.
 *
 * A bucket is still used rather than no `jobId` at all. Two passes running
 * concurrently each insert an execution row for the same morning, and an
 * observation window that cannot tell one run from two is not one. A minute
 * collapses a double-click while still letting an operator who has just changed
 * something get a real run out of their next click.
 *
 * ═══ ITS OWN JOB-NAME PREFIX ═══
 *
 * `identity-joiner-pass-manual`, not the job's own name. The enqueued JOB is
 * still `identity-joiner-pass` — the executor, the payload and `JOB_DEFAULTS`
 * (including `attempts: 1`) are the scheduled path's, deliberately, because a
 * manual run that behaved differently from the nightly one would be testing
 * something other than the thing that runs at 04:30. Only the dedupe NAMESPACE
 * differs, so a manual id can never land on a scheduled id.
 *
 * ═══ AUTHORISATION — OWNER, AND ITS OWN MAP RULE ═══
 *
 * `admin.tenant_lifecycle`, which `src/lib/permissions.ts` denies ADMIN. Being
 * able to fire the pass and being able to authorise the pass are one authority,
 * so it is the same key as the write policy that decides whether the direction
 * may act at all.
 *
 * `ROUTE_PERMISSIONS` carries a rule for THIS path specifically, ordered before
 * the `admin/identity-joiner-passes(/...)` subtree rule that would otherwise
 * cover it. The subtree rule is about READING the report, and a future edit
 * softening it ("it is only a report") would otherwise silently take the trigger
 * down with it.
 *
 * ═══ THE DIRECTORY IS NAMED BY THE CALLER, AND VALIDATED ═══
 *
 * A pass is scoped to (tenant, provider): both directory-derived inputs — link
 * freshness and the account enumeration the collision read uses — are one
 * directory's. The provider is required rather than defaulted, and checked
 * against `WRITABLE_IDENTITY_PROVIDERS` — imported rather than restated, so the
 * accepted set cannot drift from the set the joiner has a story about. The
 * import is the LEAF module rather than the writer factory that re-exports it:
 * the factory loads both provider writers at module scope and, through the
 * Active Directory index, `undici`, none of which belongs in a request path that
 * only needs to know whether a string names a directory.
 *
 * NO PRE-FLIGHT POLICY CHECK, deliberately. Whether this tenant's joiner may run
 * — the rung, the ceiling, the missing entitlement map — is decided inside the
 * pass, which records its reason by name. Re-deciding any of it here would be a
 * second implementation of the same question, and the two would drift. The
 * provider check is not that: it is a check on the SHAPE of the request, against
 * a constant, with no tenant state in it.
 *
 * ═══ WHAT THIS ROUTE DOES NOT DO ═══
 *
 * No GET. The outcome surface is its immediate parent:
 * `GET …/admin/identity-joiner-passes` lists every pass with its per-starter
 * decisions and the `predictionLimits` that bound them.
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

/**
 * The dedupe namespace for manually-triggered joiner passes.
 *
 * Exported and pinned LITERALLY in exactly one test, imported everywhere else —
 * the arrangement the leaver's equivalent constant had to learn. A literal is
 * what notices a rename; an imported constant keeps the other assertions from
 * restating it. Spelling it at every assertion would let the whole suite mint
 * its expectation from the value under test and stay green through a collapse
 * onto the scheduled job's own name.
 */
export const MANUAL_JOINER_PASS_JOB_KEY = 'identity-joiner-pass-manual';

/**
 * `.strict()` on purpose. `tenantId` is taken from the resolved request context
 * and never from the body; a non-strict schema would STRIP a caller-supplied
 * `tenantId` silently, which reads to that caller exactly like being honoured.
 * A 400 says the true thing.
 */
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
            // and `attempts: 1` there is what keeps one morning's observation
            // from becoming three artefacts.
            const job = await enqueue(
                'identity-joiner-pass',
                { tenantId: ctx.tenantId, provider },
                { jobId },
            );

            // The record that somebody ASKED, written before the worker has done
            // anything. The pass writes its own execution row, but only if it is
            // picked up — and this row survives a worker that never runs and
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

            return jsonResponse({ status: 'queued', jobId: job.id, provider }, { status: 202 });
        },
    ),
    {
        rateLimit: {
            config: API_KEY_CREATE_LIMIT,
            scope: 'identity-joiner-pass-run',
        },
    },
);
