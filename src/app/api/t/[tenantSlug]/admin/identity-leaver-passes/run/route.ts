/**
 * POST /api/t/:tenantSlug/admin/identity-leaver-passes/run
 *   Body: { "provider": "entra-id" | "active-directory" }
 *   Enqueues ONE leaver pass for (this tenant, that directory), now, off the
 *   05:00 schedule. 202 + the BullMQ job id.
 *
 * ═══ WHY THIS EXISTS — THE PASS COULD NOT BE RE-RUN ═══
 *
 * `runIdentityLeaverPass` had exactly one production caller: the 05:00
 * `identity-leaver-dispatch` fan-out. That fan-out enqueues with a jobId
 * floored to the UTC DAY (`dispatchJobId(..., DAILY_BUCKET_MS)` in
 * `jobs/identity-leaver.ts`), which is correct for a dispatcher — it stops a
 * retry or a redeploy replaying the schedule from minting a second set of
 * journal rows for the same day.
 *
 * It also meant re-firing the dispatcher the same day was a SILENT NO-OP.
 * BullMQ dedupes against the id it already holds, so nothing is enqueued,
 * nothing errors, no refusal row is written, and there is no log line saying
 * "already ran today". From inside the product that is indistinguishable from a
 * dead worker — and the morning you need to tell those apart is the morning
 * after a wrong disable, or after an operator has just fixed the cause of a
 * refusal and wants the pass to see the fix.
 *
 * The read-only `identity-sync` direction has had a "Sync now" since P1. The
 * direction that WRITES to a customer's own directory did not, so the risk
 * ordering was inverted: the safest job was re-runnable on demand and the most
 * dangerous one was reachable only over SSH.
 *
 * ═══ THE MINUTE BUCKET IS THE WHOLE POINT ═══
 *
 * The id here is minted from `MINUTE_MS`, not `DAILY_BUCKET_MS`. A deliberate
 * re-run must not be swallowed by the dedupe key of the run it is re-running —
 * that is the defect, and inheriting the daily bucket would reproduce it
 * exactly while looking like a working button.
 *
 * A bucket is still used rather than no `jobId` at all, and the reason is the
 * same one that pins `attempts: 1` on this job: two passes running concurrently
 * each mint a fresh journal row per candidate, and the second cannot tell its
 * own predecessor's unsettled row from a genuinely INDETERMINATE write. A
 * double-click must therefore collapse. One minute is the window that collapses
 * a double-click while still letting an operator who has just changed something
 * get a real run out of their next click — the same trade the SharePoint
 * "Sync now" route makes for the same reason.
 *
 * ═══ ITS OWN JOB-NAME PREFIX ═══
 *
 * `identity-leaver-pass-manual`, not the job's own name. The enqueued JOB is
 * still `identity-leaver-pass` — the executor, the payload and `JOB_DEFAULTS`
 * (including `attempts: 1`) are the scheduled path's, deliberately, because a
 * manual run that behaved differently from the nightly one would be testing
 * something other than the thing that runs at 05:00.
 *
 * Only the dedupe NAMESPACE differs, so a manual id can never land on a
 * scheduled id. Today the arithmetic already separates them — a minute-bucket
 * index is ~1440× a day-bucket index, so a collision would need the epoch to be
 * back in 1970 — but that is arithmetic nobody re-checks when a bucket constant
 * changes, and the consequence of it failing is the manual run silently
 * cancelling itself against the morning's scheduled one.
 *
 * ═══ AUTHORISATION — OWNER, AND ITS OWN MAP RULE ═══
 *
 * `admin.tenant_lifecycle`, which `src/lib/permissions.ts` denies ADMIN. This
 * is the button that makes the product write to a system we do not own, off
 * schedule, at a moment of the caller's choosing. It is the same key as the
 * write policy that decides whether such a write is permitted at all: being
 * able to fire the pass and being able to authorise the pass are one authority.
 *
 * `ROUTE_PERMISSIONS` carries a rule for THIS path specifically, ordered before
 * the `admin/identity-leaver-passes(/...)` subtree rule that would otherwise
 * cover it. The subtree rule is about READING the pass report, and a future
 * edit softening it ("it is only a report") would otherwise silently take the
 * write trigger down with it. Two rules cost one regex; sharing one costs the
 * gate on the only endpoint here that changes anybody's directory.
 *
 * ═══ THE DIRECTORY IS NAMED BY THE CALLER, AND VALIDATED ═══
 *
 * A pass is scoped to (tenant, provider) — `ConnectedIdentityAccount` carries
 * no connection, so the writer is resolved per directory. The provider is
 * required rather than defaulted: an operator firing an off-schedule directory
 * write should have to say which directory, and a tenant with both a cloud and
 * an on-prem connection has no defensible default.
 *
 * It is checked against `WRITABLE_IDENTITY_PROVIDERS` — imported rather than
 * restated, so the accepted set cannot drift from the set that resolves a
 * writer. The import is the LEAF module rather than the writer factory that
 * re-exports it: the factory loads both provider writers at module scope and,
 * through the Active Directory index, `undici`, none of which belongs in a
 * request path that only needs to know whether a string names a directory.
 *
 * A typo would otherwise enqueue a pass that refuses `UNSUPPORTED_PROVIDER`
 * into an execution row, which is a slow and confusing way to learn you
 * misspelled `entra-id`.
 *
 * NO PRE-FLIGHT CONNECTION CHECK, deliberately. Whether this tenant can write
 * to that directory — no enabled connection, two of them, a disabled write
 * policy, a tenant still on DRY_RUN — is decided inside the pass, which records
 * its reason. Re-deciding any of it here would be a second implementation of
 * the same question in a second place, and the two would drift. The provider
 * check above is not that: it is a check on the SHAPE of the request, against a
 * constant, with no tenant state in it.
 *
 * ═══ WHAT THIS ROUTE DOES NOT DO ═══
 *
 * No GET. The outcome surface already exists and is its immediate parent:
 * `GET …/admin/identity-leaver-passes` lists every pass with its per-candidate
 * decisions, and #2490's journal routes resolve what each write replaced. A
 * second polling endpoint would be a third place to read the same run.
 *
 * A second run on a correct day is cheap rather than dangerous: `ALREADY_DISABLED`
 * returns before any write, and the blast-radius breaker sees the same batch it
 * saw at 05:00. That is what makes this safe to expose at all — but it is a
 * property of the pass, not a licence to fire it casually, hence the rate limit.
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

type LeaverPassRunParams = { tenantSlug: string };

/**
 * The dedupe namespace for manually-triggered passes.
 *
 * Exported so a test can assert the id this route mints WITHOUT restating the
 * string — a test that hard-codes the prefix keeps passing after a rename and
 * stops proving the two paths are separated.
 */
export const MANUAL_LEAVER_PASS_JOB_KEY = 'identity-leaver-pass-manual';

/**
 * `.strict()` on purpose. `tenantId` is taken from the resolved request
 * context and never from the body; a non-strict schema would STRIP a
 * caller-supplied `tenantId` silently, which reads to that caller exactly like
 * being honoured. A 400 says the true thing.
 */
const RunLeaverPassSchema = z
    .object({
        provider: z.enum(WRITABLE_IDENTITY_PROVIDERS),
    })
    .strict();

export const POST = withApiErrorHandling(
    requirePermission<LeaverPassRunParams>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, _routeArgs, ctx) => {
            const { provider } = await parseJsonBody(req, RunLeaverPassSchema);

            const jobId = dispatchJobId(
                MANUAL_LEAVER_PASS_JOB_KEY,
                `${ctx.tenantId}:${provider}`,
                MINUTE_MS,
            );

            // Through the typed `enqueue()` wrapper, never a raw `queue.add`:
            // the wrapper is what applies `JOB_DEFAULTS['identity-leaver-pass']`,
            // and `attempts: 1` there is a correctness constraint on the journal
            // rather than rate-limit courtesy.
            const job = await enqueue(
                'identity-leaver-pass',
                { tenantId: ctx.tenantId, provider },
                { jobId },
            );

            // The record that somebody ASKED, written before the worker has
            // done anything. The pass writes its own execution row and its own
            // per-write journal rows, but only if it is picked up — and a
            // manual directory write with no trace of who triggered it is the
            // gap this whole subsystem exists to close. This row survives a
            // worker that never runs and BullMQ's removeOnComplete horizon.
            await logEvent(prisma, ctx, {
                action: 'IDENTITY_LEAVER_PASS_REQUESTED',
                entityType: 'Tenant',
                entityId: ctx.tenantId,
                details:
                    `Off-schedule identity leaver pass requested for ${provider} ` +
                    `by user ${ctx.userId}`,
                detailsJson: {
                    category: 'custom',
                    event: 'identity_leaver_pass_requested',
                    summary: `Off-schedule leaver pass queued for ${provider}`,
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
            scope: 'identity-leaver-pass-run',
        },
    },
);
