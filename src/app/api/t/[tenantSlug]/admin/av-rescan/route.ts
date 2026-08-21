/**
 * Admin API for triggering the bounded AV catch-up rescan.
 *
 *   POST /api/t/:tenantSlug/admin/av-rescan
 *     Body (optional): { "limit": 1..AV_RESCAN_MAX_LIMIT }
 *     Enqueues one `av-rescan` run for THIS tenant. Returns 202 with
 *     the BullMQ job id.
 *
 *   GET  /api/t/:tenantSlug/admin/av-rescan?jobId=<id>
 *     Reports the state + counters of a previously-enqueued run.
 *
 * ## Why this file exists
 *
 * `av-rescan` was registered in the executor registry and enqueued by
 * nothing — no route, no schedule, no script. Its own docblock says
 * "re-run it until `scanned` comes back zero", which was an instruction
 * with no mechanism: the only way to start a run was a hand-written
 * `queue.add` inside the worker container, which needs VM access, the
 * queue name, a real userId for the audit actor, and a manual copy of
 * the job's `JOB_DEFAULTS` (a raw `queue.add` bypasses the wrapper that
 * normally applies them). The rescan is the remediation for a whole
 * class of evidence stuck at `scanStatus: PENDING`, so "reachable only
 * over SSH" was the wrong place for it.
 *
 * Modelled on `admin/key-rotation/route.ts` — the closest precedent and
 * the same shape: enqueue a bounded per-tenant job, audit the
 * initiation, hand back the job id, and offer a GET so the operator can
 * read the outcome without a shell.
 *
 * ## Authorisation — `admin.tenant_lifecycle` (OWNER-only)
 *
 * The same key as the AV subsystem's only other admin route,
 * `admin/files/:fileId/clear-quarantine`, and for the same reason: both
 * decide what the download gate will serve. A PENDING row is refused in
 * `strict` mode; a run of this job turns some number of them into CLEAN,
 * which `isDownloadAllowed` serves in every mode from then on. That is
 * clear-quarantine's authority applied in BULK rather than one file at a
 * time, so gating it one tier lower than the single-file case would be
 * incoherent. ADMIN is explicitly denied `tenant_lifecycle` by the role
 * model in `src/lib/permissions.ts`. Do not weaken this to `admin.manage`.
 *
 * ## The caller cannot widen the blast radius
 *
 * `tenantId` and `initiatedByUserId` are taken from the resolved request
 * context and NEVER from the body — the schema is `.strict()`, so a
 * caller that tries to name either gets a 400 instead of having the
 * field silently stripped. `limit` is bounded by the schema at the job's
 * own `AV_RESCAN_MAX_LIMIT`, imported rather than restated so the two
 * cannot drift; over-cap is a 400 rather than a silent clamp, because an
 * operator who asks for 5,000 should learn the ceiling exists.
 *
 * ## Rate limit
 *
 * `API_KEY_CREATE_LIMIT` (5/hr), same as key-rotation and
 * clear-quarantine. Deliberately NOT loosened for the "re-run until
 * zero" loop: a max-size run is 1,000 object reads plus 1,000 clamd
 * round trips, so five queued runs is already more work than the worker
 * will get through in the hour. The binding constraint on drain rate is
 * the worker, not this endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { enqueue, getQueue } from '@/app-layer/jobs/queue';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { badRequest, conflict } from '@/lib/errors/types';
import { logEvent } from '@/app-layer/events/audit';
import { prisma } from '@/lib/prisma';
import { env } from '@/env';
import {
    AV_RESCAN_DEFAULT_LIMIT,
    AV_RESCAN_MAX_LIMIT,
} from '@/app-layer/jobs/av-rescan';

/**
 * `.strict()` on purpose. The two fields that decide who gets scanned and
 * who is recorded as having decided it — `tenantId`, `initiatedByUserId`
 * — come from `ctx`. A non-strict schema would strip them silently, which
 * reads to a caller exactly like being honoured.
 */
const AvRescanRequestSchema = z
    .object({
        limit: z.number().int().min(1).max(AV_RESCAN_MAX_LIMIT).optional(),
    })
    .strict();

/**
 * The body is optional — `POST` with no body at all means "one run at
 * the job's default limit". An absent body and a malformed one are kept
 * distinct: the first is `{}`, the second is a 400. Collapsing them
 * would turn a typo'd payload into a silently-defaulted run.
 */
async function readOptionalJsonBody(req: NextRequest): Promise<unknown> {
    const raw = await req.text();
    if (raw.trim().length === 0) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw badRequest('Request body is not valid JSON');
    }
}

// ─── POST — enqueue a run ───────────────────────────────────────────

export const POST = withApiErrorHandling(
    requirePermission('admin.tenant_lifecycle', async (req: NextRequest, _routeArgs, ctx) => {
        const body = AvRescanRequestSchema.parse(await readOptionalJsonBody(req));

        // Pre-flight, not a substitute for the job's own guard.
        //
        // In `disabled` mode `scanBuffer` fabricates a CLEAN, so the job
        // refuses to enumerate a single row — correctly. But it does that
        // by logging a warning and returning all-zero counters, and from
        // this side of the wire zeros are ambiguous: they read exactly
        // like "the backlog is already drained", which is the one answer
        // that would stop an operator re-running. Refusing here turns a
        // silent no-op into a stated reason, which is the whole point of
        // the endpoint existing. The job keeps its own check — that one
        // runs in the worker, whose env is the env that actually governs
        // the scan.
        if (env.AV_SCAN_MODE === 'disabled') {
            throw conflict(
                'AV_SCAN_MODE is disabled — a rescan would have no scanner to ask. ' +
                    'Set AV_SCAN_MODE to strict or permissive and retry.',
            );
        }

        const job = await enqueue('av-rescan', {
            tenantId: ctx.tenantId,
            initiatedByUserId: ctx.userId,
            ...(body.limit !== undefined ? { limit: body.limit } : {}),
            requestId: ctx.requestId,
        });

        // The job writes a per-file audit row for every verdict it lands,
        // but only for the files it reaches. This row is the record that
        // somebody ASKED — it survives a worker that never picks the job
        // up, and it survives BullMQ's `removeOnComplete` horizon.
        await logEvent(prisma, ctx, {
            action: 'AV_RESCAN_INITIATED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `AV rescan initiated by admin user ${ctx.userId}`,
            metadata: {
                jobId: job.id,
                limit: body.limit ?? AV_RESCAN_DEFAULT_LIMIT,
                limitExplicit: body.limit !== undefined,
            },
        });

        return NextResponse.json(
            {
                status: 'queued',
                jobId: job.id,
                tenantId: ctx.tenantId,
                initiatedByUserId: ctx.userId,
                limit: body.limit ?? AV_RESCAN_DEFAULT_LIMIT,
                maxLimit: AV_RESCAN_MAX_LIMIT,
            },
            { status: 202 },
        );
    }),
    {
        rateLimit: {
            config: API_KEY_CREATE_LIMIT,
            scope: 'av-rescan-initiate',
        },
    },
);

// ─── GET — poll a run ───────────────────────────────────────────────

export const GET = withApiErrorHandling(
    requirePermission('admin.tenant_lifecycle', async (req: NextRequest, _routeArgs, ctx) => {
        const jobId = new URL(req.url).searchParams.get('jobId');
        if (!jobId) {
            return NextResponse.json(
                { error: { code: 'BAD_REQUEST', message: 'jobId required' } },
                { status: 400 },
            );
        }

        const job = await getQueue().getJob(jobId);

        // A job id belonging to another tenant is reported as absent
        // rather than as forbidden — the same shape key-rotation uses, so
        // the response cannot be used to probe which ids exist elsewhere.
        const payload = job?.data as { tenantId?: string } | undefined;
        if (!job || (payload?.tenantId && payload.tenantId !== ctx.tenantId)) {
            return NextResponse.json(
                { error: { code: 'NOT_FOUND', message: `No job with id ${jobId}` } },
                { status: 404 },
            );
        }

        return NextResponse.json({
            jobId,
            state: await job.getState(),
            progress: job.progress,
            // `result.itemsScanned` is the `scanned` counter the job's
            // docblock tells the operator to watch: re-run until it is 0.
            result: job.returnvalue ?? null,
            failedReason: job.failedReason ?? null,
        });
    }),
);
