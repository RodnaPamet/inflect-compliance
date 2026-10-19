/**
 * DRAW THE AUDITOR'S WORKPAPERS FOR INTERNAL AUDIT, AND ASSIGN EACH (#3677,
 * step 3d). Scheduled DAILY (owner decision, 2026-10-19), so an UNASSIGNED
 * item is assigned within a day of somebody becoming eligible — `schedules.ts`
 * says why daily cannot enlarge the sample.
 *
 * The rules live in `src/lib/agentic/workpaper-review-sampling.ts` — read that
 * first; this file is the plumbing around them. Three passes, each over every
 * tenant at once (one read per kind, grouped in memory: a per-tenant read
 * inside the tenant loop is the D1 query-shape guardrail's N+1):
 *
 *   1. DRAW. Every workpaper with no review row is decided by its keyed score
 *      against the tenant's rate (100% in the pilot). Each drawn one gets ONE
 *      row, PENDING, assigned by a keyed draw from the same epoch to an ACTIVE
 *      third-line member who does not own the auditor agent — or UNASSIGNED
 *      with a named reason when there is nobody. Never dropped, never handed
 *      to somebody ineligible.
 *   2. RE-ASSIGN. A PENDING row that nobody can answer — UNASSIGNED, or whose
 *      assignee is no longer eligible — is re-drawn over the pool as it now
 *      stands. A valid assignment is never moved.
 *   3. HEAL. A DISSENTED review whose finding proposal was not raised (the
 *      answer committed and the raise failed) is raised now, once
 *      (`raiseDissentFindingProposal` is idempotent per review).
 *
 * ── THIS IS THE ONLY WRITE SEAM that creates or re-assigns a review ──
 *
 * A person cannot open a review on a workpaper of their choosing or pick who
 * answers it: the selection would stop being a sample and the rate would
 * describe the choice. The answer is the review usecase's; nothing else writes
 * the table (`tests/guards/sample-audit-single-draw-seam.test.ts`).
 *
 * ── Fail closed, never silently ─────────────────────────────────────
 *
 * A tenant whose writes are refused (a membership changed between the read and
 * the insert, so the trigger refused an assignee) is skipped for this run and
 * counted as errored; the next run draws it. The run's outcome metric says
 * `partial` rather than `completed`, and a run that found no workpaper at all
 * says `no_workpapers` rather than a green zero.
 */
import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry } from '@/lib/audit';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { recordWorkpaperReviewSweep } from '@/lib/observability/integration-metrics';
import { deriveSubkey } from '@/lib/security/encryption';
import {
    assignReviewer,
    drawWorkpapersForReview,
    effectiveSamplePercent,
    isEligibleReviewer,
    workpaperReviewEpoch,
    workpaperReviewSeedFingerprint,
    workpaperReviewSeedPurpose,
    WORKPAPER_REVIEWER_LINE,
    type MemberFacts,
    type ReviewerAssignment,
} from '@/lib/agentic/workpaper-review-sampling';
import { buildSystemContext } from '../context-system';
import { raiseDissentFindingProposal } from '../usecases/audit-workpaper-sample-review';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import type { AuditWorkpaperSampleReviewPayload, JobRunResult } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far back a workpaper is a candidate, by its creation. Every workpaper is
 * seen by the first daily sweep after it is written, so this bound only stops a
 * workpaper that a rate below 100 passed over from being re-read, and
 * re-decided the same way, every day for ever. It is also how far back a RAISED
 * rate reaches: the next sweep draws the not-yet-drawn workpapers of this window
 * that the higher rate selects.
 */
export const CANDIDATE_LOOKBACK_DAYS = 400;

export interface AuditWorkpaperSampleReviewOptions {
    /** Scope to one tenant. Omitted = system-wide, which is how it is scheduled. */
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /**
     * Override the per-tenant HMAC seed — TEST-ONLY, so a test can assert the
     * draw is reproducible without holding the deployment's key. The executor
     * passes none, so the derivation below is the only path a real run takes.
     */
    seed?: string;
}

export interface AuditWorkpaperSampleReviewResult {
    /** Workpapers with no review row, read this run. */
    candidates: number;
    /** Of those, drawn and given a row. */
    drawn: number;
    /** Of the drawn, assigned to a reviewer. */
    assigned: number;
    /** Of the drawn, UNASSIGNED with a named reason. */
    unassigned: number;
    /** Pending rows whose reviewer this run re-drew. */
    reassigned: number;
    /** Dissent finding proposals this run raised (heal). */
    proposalsRaised: number;
    /** Tenants whose writes this run were refused; the next run retries them. */
    tenantsErrored: number;
}

/** The per-tenant seed. Derived, never stored, never logged. */
function seedForTenant(tenantId: string): string {
    return deriveSubkey(workpaperReviewSeedPurpose(tenantId)).toString('hex');
}

function sameAssignment(
    row: { assignedToUserId: string | null; unassignedReason: string | null },
    next: ReviewerAssignment,
): boolean {
    return row.assignedToUserId === next.assignedToUserId && row.unassignedReason === next.unassignedReason;
}

export async function runAuditWorkpaperSampleReview(
    db: PrismaClient,
    options: AuditWorkpaperSampleReviewOptions = {},
): Promise<AuditWorkpaperSampleReviewResult> {
    const now = options.now ?? new Date();
    const tenantScope = options.tenantId ? { tenantId: options.tenantId } : {};
    const result: AuditWorkpaperSampleReviewResult = {
        candidates: 0,
        drawn: 0,
        assigned: 0,
        unassigned: 0,
        reassigned: 0,
        proposalsRaised: 0,
        tenantsErrored: 0,
    };
    // Rows of any kind this run had in scope: a run with none is a run that
    // found nothing to do, which the metric must not report as a green pass.
    let inScope = 0;

    logger.info('audit workpaper sample review starting', {
        component: 'audit-workpaper-sample-review',
        scope: options.tenantId ? 'tenant-scoped' : 'system-wide',
        tenantId: options.tenantId ?? null,
    });

    try {
        // ── 1. Everything the three passes read, once each. ──
        const [candidates, pending] = await Promise.all([
            drainPages((cursor) =>
                db.auditWorkpaper.findMany({
                    where: {
                        ...tenantScope,
                        createdAt: { gte: new Date(now.getTime() - CANDIDATE_LOOKBACK_DAYS * MS_PER_DAY) },
                        sampleReviews: { none: {} },
                    },
                    select: { id: true, tenantId: true, periodLabel: true, auditorAgentId: true },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            ),
            drainPages((cursor) =>
                db.auditWorkpaperSampleReview.findMany({
                    where: { ...tenantScope, outcome: 'PENDING' },
                    select: {
                        id: true,
                        tenantId: true,
                        workpaperId: true,
                        samplingEpoch: true,
                        assignedToUserId: true,
                        unassignedReason: true,
                        workpaper: { select: { auditorAgentId: true } },
                    },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            ),
        ]);
        result.candidates = candidates.length;
        inScope += candidates.length + pending.length;

        const tenantIds = [...new Set([...candidates, ...pending].map((r) => r.tenantId))];
        const auditorIds = [
            ...new Set([
                ...candidates.map((c) => c.auditorAgentId),
                ...pending.map((p) => p.workpaper.auditorAgentId),
            ]),
        ];
        const [settings, members, auditors] = tenantIds.length === 0
            ? [[], [], []]
            : await Promise.all([
                  db.tenantSecuritySettings.findMany({
                      where: { tenantId: { in: tenantIds } },
                      select: { tenantId: true, workpaperReviewSamplePercent: true },
                      take: tenantIds.length,
                  }),
                  // Only internal audit can ever be eligible, so only it is read.
                  drainPages((cursor) =>
                      db.tenantMembership.findMany({
                          where: { tenantId: { in: tenantIds }, status: 'ACTIVE', lineOfDefence: WORKPAPER_REVIEWER_LINE },
                          select: { id: true, tenantId: true, userId: true, status: true, lineOfDefence: true },
                          orderBy: { id: 'asc' },
                          take: DRAIN_PAGE_SIZE,
                          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                      }),
                  ),
                  db.registeredAgent.findMany({
                      where: { id: { in: auditorIds } },
                      select: { id: true, tenantId: true, ownerUserId: true },
                      take: auditorIds.length,
                  }),
              ]);

        const percentOf = new Map(settings.map((s) => [s.tenantId, s.workpaperReviewSamplePercent]));
        const membersOf = new Map<string, MemberFacts[]>();
        for (const m of members) {
            const list = membersOf.get(m.tenantId) ?? [];
            list.push({ userId: m.userId, status: String(m.status), lineOfDefence: m.lineOfDefence });
            membersOf.set(m.tenantId, list);
        }
        // Keyed by tenant AND id: an auditor id is only ever an auditor of its
        // own tenant (the workpaper insert guard binds it), and the key says so.
        const ownerOf = new Map(auditors.map((a) => [`${a.tenantId}:${a.id}`, a.ownerUserId]));
        const seedOf = new Map(tenantIds.map((t) => [t, options.seed ?? seedForTenant(t)]));

        // ── 2. DRAW, per tenant, one createMany each. ──
        const candidatesOf = new Map<string, typeof candidates>();
        for (const c of candidates) {
            const list = candidatesOf.get(c.tenantId) ?? [];
            list.push(c);
            candidatesOf.set(c.tenantId, list);
        }
        for (const [tenantId, list] of candidatesOf) {
            const seed = seedOf.get(tenantId) as string;
            const samplePercent = effectiveSamplePercent(percentOf.get(tenantId));
            const fingerprint = workpaperReviewSeedFingerprint(seed);
            const rows = drawWorkpapersForReview(list, { seed, samplePercent }).map((w) => {
                const epoch = workpaperReviewEpoch(w.periodLabel);
                const assignment = assignReviewer({
                    seed,
                    epoch,
                    workpaperId: w.id,
                    auditorOwnerUserId: ownerOf.get(`${tenantId}:${w.auditorAgentId}`) ?? null,
                    members: membersOf.get(tenantId) ?? [],
                });
                return {
                    tenantId,
                    workpaperId: w.id,
                    samplingEpoch: epoch,
                    seedFingerprint: fingerprint,
                    samplePercent,
                    sampledAt: now,
                    assignedAt: now,
                    assignedToUserId: assignment.assignedToUserId,
                    unassignedReason: assignment.unassignedReason,
                    assignmentPoolSize: assignment.poolSize,
                    assignmentPoolDigest: assignment.poolDigest,
                };
            });
            if (rows.length === 0) continue;
            try {
                // `skipDuplicates` leans on the unique (tenantId, workpaperId):
                // the durable idempotency key, beyond BullMQ's jobId window.
                await db.auditWorkpaperSampleReview.createMany({ data: rows, skipDuplicates: true });
            } catch (err) {
                result.tenantsErrored += 1;
                logger.warn('audit workpaper sample review: draw refused for a tenant; the next run retries it', {
                    component: 'audit-workpaper-sample-review',
                    tenantId,
                    error: err instanceof Error ? err.name : 'unknown',
                });
                continue;
            }
            result.drawn += rows.length;
            result.assigned += rows.filter((r) => r.assignedToUserId !== null).length;
            result.unassigned += rows.filter((r) => r.assignedToUserId === null).length;
        }

        // ── 3. One read back for the ids, then one audit row each. ──
        const drawnIds = candidates.map((c) => c.id);
        const created = drawnIds.length === 0
            ? []
            : await db.auditWorkpaperSampleReview.findMany({
                  where: { workpaperId: { in: drawnIds }, sampledAt: now },
                  select: {
                      id: true,
                      tenantId: true,
                      workpaperId: true,
                      samplingEpoch: true,
                      samplePercent: true,
                      assignedToUserId: true,
                      unassignedReason: true,
                      assignmentPoolSize: true,
                  },
                  take: drawnIds.length,
              });
        for (const row of created) {
            await appendAuditEntry({
                tenantId: row.tenantId,
                // Nobody chose this row — the sampler did. Naming an actor
                // would suggest a person picked which workpaper to re-examine.
                userId: null,
                actorType: 'SYSTEM',
                entity: 'AuditWorkpaperSampleReview',
                entityId: row.id,
                action: 'AUDIT_WORKPAPER_SAMPLED',
                // Ids, codes and counts. The seed is absent by construction.
                detailsJson: {
                    category: 'access',
                    workpaperId: row.workpaperId,
                    samplingEpoch: row.samplingEpoch,
                    samplePercent: row.samplePercent,
                    assignedToUserId: row.assignedToUserId,
                    unassignedReason: row.unassignedReason,
                    assignmentPoolSize: row.assignmentPoolSize,
                },
                metadataJson: { workpaperId: row.workpaperId, samplingEpoch: row.samplingEpoch },
            }).catch(() => undefined);
        }

        // ── 4. RE-ASSIGN what nobody can answer. ──
        for (const row of pending) {
            const owner = ownerOf.get(`${row.tenantId}:${row.workpaper.auditorAgentId}`) ?? null;
            const tenantMembers = membersOf.get(row.tenantId) ?? [];
            const current = row.assignedToUserId
                ? (tenantMembers.find((m) => m.userId === row.assignedToUserId) ?? null)
                : null;
            if (row.assignedToUserId !== null && isEligibleReviewer(current, owner)) continue;

            const next = assignReviewer({
                seed: seedOf.get(row.tenantId) as string,
                epoch: row.samplingEpoch,
                workpaperId: row.workpaperId,
                auditorOwnerUserId: owner,
                members: tenantMembers,
            });
            if (sameAssignment(row, next)) continue;
            try {
                const moved = await db.auditWorkpaperSampleReview.updateMany({
                    where: {
                        id: row.id,
                        outcome: 'PENDING',
                        assignedToUserId: row.assignedToUserId,
                        unassignedReason: row.unassignedReason,
                    },
                    data: {
                        assignedToUserId: next.assignedToUserId,
                        unassignedReason: next.unassignedReason,
                        assignmentPoolSize: next.poolSize,
                        assignmentPoolDigest: next.poolDigest,
                        assignedAt: now,
                    },
                });
                if (moved.count === 0) continue;
            } catch (err) {
                result.tenantsErrored += 1;
                logger.warn('audit workpaper sample review: re-assignment refused; the next run retries it', {
                    component: 'audit-workpaper-sample-review',
                    tenantId: row.tenantId,
                    reviewId: row.id,
                    error: err instanceof Error ? err.name : 'unknown',
                });
                continue;
            }
            result.reassigned += 1;
            await appendAuditEntry({
                tenantId: row.tenantId,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'AuditWorkpaperSampleReview',
                entityId: row.id,
                action: 'AUDIT_WORKPAPER_SAMPLE_REASSIGNED',
                detailsJson: {
                    category: 'access',
                    workpaperId: row.workpaperId,
                    samplingEpoch: row.samplingEpoch,
                    fromUserId: row.assignedToUserId,
                    fromUnassignedReason: row.unassignedReason,
                    toUserId: next.assignedToUserId,
                    toUnassignedReason: next.unassignedReason,
                    assignmentPoolSize: next.poolSize,
                },
                metadataJson: { workpaperId: row.workpaperId, samplingEpoch: row.samplingEpoch },
            }).catch(() => undefined);
        }

        // ── 5. HEAL a dissent whose proposal was never raised. ──
        const unraised = await drainPages((cursor) =>
            db.auditWorkpaperSampleReview.findMany({
                where: { ...tenantScope, outcome: 'DISSENTED', findingProposalId: null },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        );
        inScope += unraised.length;
        for (const row of unraised) {
            try {
                const raised = await raiseDissentFindingProposal(
                    buildSystemContext({ tenantId: row.tenantId, job: 'audit-workpaper-sample-review', discriminator: row.id }),
                    row.id,
                );
                if (raised.raised) result.proposalsRaised += 1;
            } catch (err) {
                result.tenantsErrored += 1;
                logger.warn('audit workpaper sample review: dissent proposal still not raised', {
                    component: 'audit-workpaper-sample-review',
                    tenantId: row.tenantId,
                    reviewId: row.id,
                    error: err instanceof Error ? err.name : 'unknown',
                });
            }
        }
    } catch (err) {
        recordWorkpaperReviewSweep({ outcome: 'error', ...result });
        throw err;
    }

    recordWorkpaperReviewSweep({
        outcome:
            result.tenantsErrored > 0
                ? 'partial'
                : inScope === 0
                  ? 'no_workpapers'
                  : 'completed',
        ...result,
    });
    logger.info('audit workpaper sample review complete', {
        component: 'audit-workpaper-sample-review',
        candidates: result.candidates,
        drawn: result.drawn,
        assigned: result.assigned,
        unassigned: result.unassigned,
        reassigned: result.reassigned,
        proposalsRaised: result.proposalsRaised,
        tenantsErrored: result.tenantsErrored,
    });
    return result;
}

/**
 * BullMQ executor body. The run's counts are the result; a tenant whose writes
 * were refused is `itemsSkipped` here and `partial` on the outcome metric, and
 * the next run retries it — a refusal is reported, not swallowed into a pass.
 */
export async function runAuditWorkpaperSampleReviewJob(
    payload: AuditWorkpaperSampleReviewPayload,
): Promise<JobRunResult> {
    return runJob(
        'audit-workpaper-sample-review',
        async () => {
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const { prisma } = await import('@/lib/prisma');
            const r = await runAuditWorkpaperSampleReview(prisma, { tenantId: payload.tenantId });
            return {
                jobName: 'audit-workpaper-sample-review',
                jobRunId: crypto.randomUUID(),
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: r.candidates,
                itemsActioned: r.drawn + r.reassigned + r.proposalsRaised,
                itemsSkipped: r.tenantsErrored,
                details: {
                    drawn: r.drawn,
                    assigned: r.assigned,
                    unassigned: r.unassigned,
                    reassigned: r.reassigned,
                    proposalsRaised: r.proposalsRaised,
                    tenantsErrored: r.tenantsErrored,
                },
            };
        },
        { tenantId: payload.tenantId },
    );
}
