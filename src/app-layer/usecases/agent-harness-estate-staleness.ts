/**
 * HARNESS ESTATE STALENESS — the daily pass (#3741, the alerting follow-up of
 * step 4a).
 *
 * Owner decision, 2026-10-19: a stale estate must alert, not only show on the
 * health card. Per tenant this reads every declared estate and the scans of its
 * scanner that could keep it fresh, hands both to `computeEstateHealth` — the
 * rule the health card runs, and the only one — and reconciles one finding per
 * estate through the plan in `lib/agentic/harness-estate-staleness.ts`:
 *
 *   stale, no finding          open one
 *   stale, finding CLOSED      reopen that one
 *   stale, finding open        nothing: a second run opens nothing
 *   fresh, finding open        close it ONLY when the complete scan that made
 *                              it fresh arrived after the declaration last
 *                              changed; otherwise hold it
 *   estate removed             hold its open finding; a person closes it
 *
 * ── THE READ IS BOUNDED BY THE RULE'S OWN WINDOW ────────────────────────────
 *
 * Per estate, only the scans of its scanner whose effective moment lies inside
 * `freshnessWindowStart` — `asOf` and arrival both at or after it, which is
 * exactly `min(asOf, ingestedAt) >= start` — drained in pages, never capped.
 * Those are the only scans that could make the estate fresh, so the status is
 * the one the card would compute over every scan; the window is the health
 * module's, not a copy. One estate's scans never crowd out another's, as a
 * shared newest-N window would.
 *
 * ── WRITES ──────────────────────────────────────────────────────────────────
 *
 * Findings go through `FindingRepository` inside the tenant transaction, as the
 * harness ingest writes its own: the principal is the system, not a person with
 * general write authority. Title and description are built from identifiers
 * and the estate's sanitised name, and sanitised again; every transition is
 * audited (actor type JOB). A new finding is assigned to the scanner agent's
 * owner while that person is an ACTIVE member — the scanner is theirs.
 *
 * A per-tenant advisory lock comes first, so two passes for one tenant (a
 * scheduled run and a manual one) serialise and the second sees the first's
 * finding rather than opening another.
 *
 * ── ITS OWN RUN IS RECORDED ─────────────────────────────────────────────────
 *
 * One `IntegrationExecution` row per pass (`agentic.harness_estate_staleness`),
 * written in the same transaction as the findings it describes. A tenant with
 * no estate records NOT_APPLICABLE with `evaluated: 0` — never PASSED — and a
 * pass that threw records ERROR. PASSED means every estate was judged, whatever
 * the judgement: the findings and the metric say what was stale. The rows are
 * excluded from the control-check list by provider, as every agentic pass's are.
 *
 * Nothing here writes an estate, a scan or a source.
 *
 * @module usecases/agent-harness-estate-staleness
 */
import type { Prisma } from '@prisma/client';

import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import { recordHarnessEstateStaleness } from '@/lib/observability/integration-metrics';
import { parseStoredHarnessSources } from '@/lib/agentic/harness-contract';
import {
    computeEstateHealth,
    freshnessWindowStart,
    STALE_AFTER_CADENCES,
    type EstateScanInput,
} from '@/lib/agentic/harness-estate-health';
import {
    declarationChangedAt,
    ESTATE_STALENESS_AUTOMATION_KEY,
    MAX_REPORTED_ESTATES,
    planEstateStaleness,
    STALE_ESTATE_FINDING_SOURCE_KIND,
    STALE_ESTATE_REF_PREFIX,
    type EstateStaleReason,
    type EstateUnderEvaluation,
    type HeldReason,
} from '@/lib/agentic/harness-estate-staleness';
import { AGENTIC_PASS_PROVIDER } from '@/lib/agentic/owner-orphan';
import { buildSystemContext } from '../context-system';
import { drainPages, DRAIN_PAGE_SIZE } from '../jobs/drain-pages';
import { logEvent } from '../events/audit';
import { FindingRepository } from '../repositories/FindingRepository';

/** The pass's transaction budget: a first pass over many stale estates writes a finding and an audit row each. */
const STALENESS_TX_TIMEOUT_MS = 120_000;

export interface EstateStalenessPassResult {
    tenantId: string;
    status: 'PASSED' | 'NOT_APPLICABLE' | 'ERROR';
    refusal: 'NO_ESTATES' | null;
    /** Estates judged. Zero is nothing measured. */
    evaluated: number;
    stale: number;
    opened: number;
    reopened: number;
    /** Stale estates whose finding was already open: left alone. */
    stillOpen: number;
    resolved: number;
    held: number;
    executionId: string | null;
}

/** Run one tenant's pass and record it. Never throws: a broken pass is an ERROR row. */
export async function runHarnessEstateStaleness(input: {
    tenantId: string;
    jobRunId?: string;
    now?: Date;
}): Promise<EstateStalenessPassResult> {
    const now = input.now ?? new Date();
    const ctx = buildSystemContext({
        tenantId: input.tenantId,
        job: 'agent-harness-estate-staleness',
        ...(input.jobRunId ? { discriminator: input.jobRunId } : {}),
    });
    const zero = { tenantId: input.tenantId, evaluated: 0, stale: 0, opened: 0, reopened: 0, stillOpen: 0, resolved: 0, held: 0 };

    try {
        const outcome = await runInTenantContext(ctx, async (db) => {
            // Namespaced, so it never shares a key with the audit chain's own
            // per-tenant lock. Released at commit or rollback.
            await db.$executeRawUnsafe(
                `SELECT pg_advisory_xact_lock(hashtext($1))`,
                `harness-estate-staleness:${ctx.tenantId}`,
            );

            const estates = await drainPages((cursor) =>
                db.agentHarnessEstate.findMany({
                    where: { tenantId: ctx.tenantId },
                    select: {
                        id: true,
                        name: true,
                        scannerAgentId: true,
                        cadenceHours: true,
                        createdAt: true,
                        updatedAt: true,
                        scanner: { select: { name: true, status: true, deletedAt: true, ownerUserId: true } },
                        sources: {
                            orderBy: { kind: 'asc' },
                            select: { kind: true, ownerUserId: true, createdAt: true, updatedAt: true },
                        },
                    },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            );

            // Only the scans that could keep each estate fresh: `asOf` and
            // arrival both inside its own window (see the header).
            const scans = estates.length === 0
                ? []
                : await drainPages((cursor) =>
                    db.agentHarnessScan.findMany({
                        where: {
                            tenantId: ctx.tenantId,
                            OR: estates.map((e) => {
                                const start = freshnessWindowStart(e.cadenceHours, now);
                                return { scannerAgentId: e.scannerAgentId, asOf: { gte: start }, createdAt: { gte: start } };
                            }),
                        },
                        select: {
                            id: true,
                            scanRef: true,
                            scannerAgentId: true,
                            asOf: true,
                            createdAt: true,
                            complete: true,
                            agentCount: true,
                            sourcesJson: true,
                        },
                        orderBy: { id: 'asc' },
                        take: DRAIN_PAGE_SIZE,
                        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                    }),
                );

            // Every stale-estate finding the tenant holds, CLOSED ones included:
            // a stale estate reopens its own rather than opening a second.
            const findings = await drainPages((cursor) =>
                db.finding.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        sourceKind: STALE_ESTATE_FINDING_SOURCE_KIND,
                        sourceRef: { startsWith: STALE_ESTATE_REF_PREFIX },
                        deletedAt: null,
                    },
                    select: { id: true, sourceRef: true, status: true },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            );

            // Who is still a member: the source owners (the health row carries
            // it) and the scanner owners (a new finding's assignee). One read.
            const people = [
                ...new Set(estates.flatMap((e) => [e.scanner.ownerUserId, ...e.sources.map((s) => s.ownerUserId)])),
            ];
            const active = new Set(
                people.length === 0
                    ? []
                    : (
                          await db.tenantMembership.findMany({
                              where: { tenantId: ctx.tenantId, userId: { in: people }, status: 'ACTIVE' },
                              select: { userId: true },
                              take: people.length,
                          })
                      ).map((m) => m.userId),
            );

            const byScanner = new Map<string, EstateScanInput[]>();
            const arrivedAt = new Map<string, string>();
            for (const s of scans) {
                const list = byScanner.get(s.scannerAgentId) ?? [];
                list.push({
                    id: s.id,
                    scanRef: s.scanRef,
                    asOf: s.asOf.toISOString(),
                    ingestedAt: s.createdAt.toISOString(),
                    complete: s.complete,
                    agentCount: s.agentCount,
                    sources: parseStoredHarnessSources(s.sourcesJson),
                });
                byScanner.set(s.scannerAgentId, list);
                arrivedAt.set(s.id, s.createdAt.toISOString());
            }

            const evaluated: EstateUnderEvaluation[] = estates.map((e) => {
                const health = computeEstateHealth(
                    {
                        id: e.id,
                        name: e.name,
                        scannerAgentId: e.scannerAgentId,
                        scannerName: e.scanner.deletedAt === null ? e.scanner.name : null,
                        scannerLive: e.scanner.deletedAt === null && e.scanner.status !== 'RETIRED',
                        cadenceHours: e.cadenceHours,
                        sources: e.sources.map((s) => ({
                            kind: s.kind,
                            owner: { userId: s.ownerUserId, name: null, active: active.has(s.ownerUserId) },
                        })),
                    },
                    byScanner.get(e.scannerAgentId) ?? [],
                    now,
                );
                return {
                    health,
                    declaredAt: declarationChangedAt(e).toISOString(),
                    lastCompleteArrivedAt: health.lastComplete ? arrivedAt.get(health.lastComplete.scanId) ?? null : null,
                };
            });
            const plan = planEstateStaleness({
                now,
                estates: evaluated,
                findings: findings.filter((f): f is typeof f & { sourceRef: string } => typeof f.sourceRef === 'string'),
            });
            const estateById = new Map(estates.map((e) => [e.id, e]));

            const counts = { opened: 0, reopened: 0, stillOpen: 0, resolved: 0, held: 0 };
            const actionByEstate = new Map<string, string>();
            const held: { findingId: string; estateId: string; reason: HeldReason }[] = [];
            for (const a of plan.actions) {
                switch (a.kind) {
                    case 'OPEN': {
                        const owner = estateById.get(a.finding.estateId)?.scanner.ownerUserId ?? null;
                        const created = await FindingRepository.create(db, ctx, {
                            severity: a.finding.severity,
                            type: a.finding.type,
                            title: sanitizePlainText(a.finding.title),
                            description: sanitizePlainText(a.finding.description),
                            status: 'OPEN',
                            sourceKind: STALE_ESTATE_FINDING_SOURCE_KIND,
                            sourceRef: a.finding.sourceRef,
                            assigneeUserId: owner !== null && active.has(owner) ? owner : null,
                        });
                        counts.opened += 1;
                        actionByEstate.set(a.finding.estateId, 'OPENED');
                        await logEvent(db, ctx, {
                            action: 'CREATE',
                            entityType: 'Finding',
                            entityId: created.id,
                            details: `Harness estate staleness raised ${a.finding.code} on estate ${a.finding.estateId}`,
                            detailsJson: {
                                category: 'entity_lifecycle',
                                entityName: 'Finding',
                                operation: 'created',
                                after: { code: a.finding.code, sourceRef: a.finding.sourceRef, reason: a.finding.reason, severity: a.finding.severity },
                            },
                        });
                        break;
                    }
                    case 'REOPEN': {
                        await db.finding.update({
                            where: { id: a.findingId },
                            data: {
                                status: 'OPEN',
                                title: sanitizePlainText(a.finding.title),
                                description: sanitizePlainText(a.finding.description),
                                verificationNotes: sanitizePlainText('Reopened by the harness-estate staleness pass: the estate is stale again'),
                            },
                        });
                        counts.reopened += 1;
                        actionByEstate.set(a.finding.estateId, 'REOPENED');
                        await logEvent(db, ctx, {
                            action: 'STATUS_CHANGE',
                            entityType: 'Finding',
                            entityId: a.findingId,
                            details: `Harness estate staleness reopened ${a.finding.code} on estate ${a.finding.estateId}`,
                            detailsJson: {
                                category: 'status_change',
                                entityName: 'Finding',
                                before: { status: 'CLOSED' },
                                after: { status: 'OPEN', sourceRef: a.finding.sourceRef, reason: a.finding.reason },
                            },
                        });
                        break;
                    }
                    case 'STILL_OPEN':
                        counts.stillOpen += 1;
                        actionByEstate.set(a.estateId, 'STILL_OPEN');
                        break;
                    case 'CLOSE': {
                        await db.finding.update({
                            where: { id: a.findingId },
                            data: {
                                status: 'CLOSED',
                                verifiedAt: now,
                                verificationNotes: sanitizePlainText(
                                    `Resolved by the harness-estate staleness pass: complete scan ${a.scanRef} arrived at ${a.arrivedAt}`,
                                ),
                            },
                        });
                        counts.resolved += 1;
                        actionByEstate.set(a.estateId, 'RESOLVED');
                        await logEvent(db, ctx, {
                            action: 'STATUS_CHANGE',
                            entityType: 'Finding',
                            entityId: a.findingId,
                            details: `Harness estate staleness resolved ${a.sourceRef} on scan ${a.scanRef}`,
                            detailsJson: {
                                category: 'status_change',
                                entityName: 'Finding',
                                before: { status: a.priorStatus },
                                after: { status: 'CLOSED', sourceRef: a.sourceRef, scanRef: a.scanRef, arrivedAt: a.arrivedAt },
                            },
                        });
                        break;
                    }
                    case 'HOLD':
                        counts.held += 1;
                        actionByEstate.set(a.estateId, `HELD_${a.reason}`);
                        held.push({ findingId: a.findingId, estateId: a.estateId, reason: a.reason });
                        break;
                }
            }

            const staleByReason: Partial<Record<EstateStaleReason, number>> = {};
            for (const s of plan.stale) staleByReason[s.reason] = (staleByReason[s.reason] ?? 0) + 1;
            const reasonByEstate = new Map(plan.stale.map((s) => [s.estateId, s.reason]));

            const empty = plan.evaluated === 0;
            const status: EstateStalenessPassResult['status'] = empty ? 'NOT_APPLICABLE' : 'PASSED';
            const refusal = empty ? ('NO_ESTATES' as const) : null;
            const row = await db.integrationExecution.create({
                data: {
                    tenantId: ctx.tenantId,
                    provider: AGENTIC_PASS_PROVIDER,
                    automationKey: ESTATE_STALENESS_AUTOMATION_KEY,
                    status,
                    triggeredBy: 'scheduled',
                    jobRunId: input.jobRunId ?? null,
                    completedAt: new Date(),
                    resultJson: {
                        refusal,
                        detail: empty
                            ? 'This workspace declares no harness estate, so no estate was judged against a '
                              + 'cadence. Zero estates evaluated is nothing measured — it is not a clean result.'
                            : null,
                        evaluated: plan.evaluated,
                        stale: plan.stale.length,
                        staleByReason,
                        // The rule applied, by reference to its one home.
                        rule: { staleAfterCadences: STALE_AFTER_CADENCES, scansRead: scans.length },
                        estates: evaluated.slice(0, MAX_REPORTED_ESTATES).map(({ health, declaredAt, lastCompleteArrivedAt }) => ({
                            estateId: health.id,
                            scannerAgentId: health.scannerAgentId,
                            status: health.status,
                            reason: reasonByEstate.get(health.id) ?? null,
                            staleAfterHours: health.staleAfterHours,
                            lastCompleteScanRef: health.lastComplete?.scanRef ?? null,
                            lastCompleteArrivedAt,
                            declaredAt,
                            action: actionByEstate.get(health.id) ?? 'NONE',
                        })),
                        estatesTruncated: evaluated.length > MAX_REPORTED_ESTATES,
                        findings: counts,
                        // Named, never dropped: an open finding the pass would
                        // not close is a fact about this run.
                        held,
                    } as Prisma.InputJsonValue,
                },
                select: { id: true },
            });

            return { ...counts, evaluated: plan.evaluated, stale: plan.stale.length, staleByReason, status, refusal, executionId: row.id };
        }, { timeout: STALENESS_TX_TIMEOUT_MS });

        recordHarnessEstateStaleness({
            outcome: outcome.status === 'NOT_APPLICABLE' ? 'no_estates' : 'evaluated',
            evaluated: outcome.evaluated,
            staleByReason: outcome.staleByReason,
        });
        logger.info('harness estate staleness pass complete', {
            component: 'agent-harness-estate-staleness',
            tenantId: ctx.tenantId,
            evaluated: outcome.evaluated,
            stale: outcome.stale,
            opened: outcome.opened,
            reopened: outcome.reopened,
            resolved: outcome.resolved,
            held: outcome.held,
        });

        return {
            tenantId: input.tenantId,
            status: outcome.status,
            refusal: outcome.refusal,
            evaluated: outcome.evaluated,
            stale: outcome.stale,
            opened: outcome.opened,
            reopened: outcome.reopened,
            stillOpen: outcome.stillOpen,
            resolved: outcome.resolved,
            held: outcome.held,
            executionId: outcome.executionId,
        };
    } catch (err) {
        logger.error('harness estate staleness pass threw', {
            component: 'agent-harness-estate-staleness',
            tenantId: ctx.tenantId,
            errorMessage: err instanceof Error ? err.message : 'non-Error thrown',
        });
        let executionId: string | null = null;
        try {
            const row = await runInTenantContext(ctx, (db) =>
                db.integrationExecution.create({
                    data: {
                        tenantId: ctx.tenantId,
                        provider: AGENTIC_PASS_PROVIDER,
                        automationKey: ESTATE_STALENESS_AUTOMATION_KEY,
                        status: 'ERROR',
                        triggeredBy: 'scheduled',
                        jobRunId: input.jobRunId ?? null,
                        completedAt: new Date(),
                        resultJson: {
                            refusal: null,
                            detail: `The pass could not run to completion: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
                        },
                    },
                    select: { id: true },
                }),
            );
            executionId = row.id;
        } catch (writeErr) {
            logger.error('harness estate staleness pass threw and its record could not be written', {
                component: 'agent-harness-estate-staleness',
                tenantId: ctx.tenantId,
                errorMessage: writeErr instanceof Error ? writeErr.message : 'non-Error thrown',
            });
        }
        recordHarnessEstateStaleness({ outcome: 'error', evaluated: 0, staleByReason: {} });
        return { ...zero, status: 'ERROR', refusal: null, executionId };
    }
}
