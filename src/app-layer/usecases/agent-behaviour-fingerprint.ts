/**
 * AGENT BEHAVIOUR FINGERPRINT — one tenant's nightly pass (Morpheus roadmap
 * Phase 1, decision D-L1-3: a CPU detector in the worker before Morpheus DFP).
 *
 * Per tenant, for the UTC day that just closed:
 *
 *   1. read the day's counts per agent (`readLedgerDay` — the one read of the
 *      ledger, held to a column allowlist by a guard);
 *   2. read each active agent's in-baseline days from `AgentBehaviourBaseline`;
 *   3. score the day with `scoreDay` (pure; rolling mean and floored σ);
 *   4. write the day's baseline row — LEARNING, STEADY or ANOMALOUS — and, for
 *      an anomalous day, an `AgentBehaviourAnomaly` row with the features that
 *      drove it;
 *   5. reconcile ONE finding per agent (`sourceRef = BEHAVIOUR_ANOMALY:<agentId>`):
 *      open one, reopen a CLOSED one, or leave an open one alone;
 *   6. after commit, at threshold B and only when the operator's latch key is
 *      on, latch the agent's EXISTING circuit breaker with `BEHAVIOUR_ANOMALY`.
 *
 * ── IDEMPOTENT ON (tenant, agent, day) ──────────────────────────────────────
 *
 * A day already scored for an agent is not scored again: the unique index on
 * the baseline row is the key, and the pass reads it before it writes. So a
 * second run of the same night — a retry, a manual run, a jobId the queue
 * evicted — writes no row, raises no finding and latches nothing. A per-tenant
 * advisory lock serialises two concurrent passes, so the second sees the
 * first's rows.
 *
 * ── NOTHING RAISED WHILE LEARNING ───────────────────────────────────────────
 *
 * Fewer than `BASELINE_MIN_DAYS` in-baseline days is LEARNING: the row is
 * written (it IS the baseline being built) and nothing is raised. A day with no
 * activity writes no row at all — an empty day is not a sample.
 *
 * ── ITS OWN RUN IS RECORDED ─────────────────────────────────────────────────
 *
 * One `IntegrationExecution` row per pass (`agentic.agent_fingerprint`), in the
 * same transaction as the rows it describes. No active agent is NOT_APPLICABLE
 * (`NO_ACTIVITY`) — never PASSED — and a pass that threw records ERROR.
 *
 * Nothing here writes a ledger row, a grant or a card. The only write outside
 * the two fingerprint tables, the finding and the execution row is the latch,
 * and that goes through `latchOnBehaviourAnomaly` — the breaker's own seam.
 *
 * @module usecases/agent-behaviour-fingerprint
 */
import type { Prisma } from '@prisma/client';

import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import { recordAgentFingerprintPass } from '@/lib/observability/integration-metrics';
import {
    anomalyFindingText,
    BEHAVIOUR_ANOMALY_FINDING_SOURCE_KIND,
    behaviourAnomalySourceRef,
    baselineLookbackStart,
    dayKeyFor,
    driversForStorage,
    FINGERPRINT_AUTOMATION_KEY,
    FINGERPRINT_FEATURES,
    isActiveDay,
    previousUtcDay,
    round2,
    scoreDay,
    type FingerprintFeatures,
    type FingerprintVerdict,
    type AnomalyTier,
} from '@/lib/agentic/behaviour-fingerprint';
import { latchOnBehaviourAnomaly } from '@/lib/agentic/circuit-breaker-store';
import { AGENTIC_PASS_PROVIDER } from '@/lib/agentic/owner-orphan';
import { buildSystemContext } from '../context-system';
import { drainPages, DRAIN_PAGE_SIZE } from '../jobs/drain-pages';
import { logEvent } from '../events/audit';
import { FindingRepository } from '../repositories/FindingRepository';
import { FINGERPRINT_MAX_AGENTS, readLedgerDay } from './agent-behaviour-fingerprint-ledger';

const FINGERPRINT_TX_TIMEOUT_MS = 120_000;

/** Agents one execution row describes before it says it was truncated. */
const MAX_REPORTED_AGENTS = 200;

export interface AgentDayOutcome {
    agentId: string;
    verdict: FingerprintVerdict;
    tier: AnomalyTier | null;
    score: number | null;
    baselineDays: number;
    findingAction: 'OPENED' | 'REOPENED' | 'STILL_OPEN' | null;
    findingId: string | null;
    latched: boolean;
}

export interface FingerprintPassResult {
    tenantId: string;
    day: string;
    status: 'PASSED' | 'NOT_APPLICABLE' | 'ERROR';
    refusal: 'NO_ACTIVITY' | null;
    /** Agent-days scored by THIS pass. A day already scored is not counted again. */
    evaluated: number;
    /** Active agent-days this pass found already scored (a re-run). */
    alreadyScored: number;
    learning: number;
    steady: number;
    anomalous: number;
    latched: number;
    agents: AgentDayOutcome[];
    executionId: string | null;
}

function featuresOf(row: Record<(typeof FINGERPRINT_FEATURES)[number], number>): FingerprintFeatures {
    const out = {} as Record<(typeof FINGERPRINT_FEATURES)[number], number>;
    for (const f of FINGERPRINT_FEATURES) out[f] = row[f];
    return out;
}

/**
 * Run one tenant's pass for the UTC day before `now`. Never throws: a broken
 * pass is an ERROR row. `latch` is the operator's third key — without it a
 * threshold-B day raises its finding and stops nothing.
 */
export async function runAgentBehaviourFingerprint(input: {
    tenantId: string;
    tenantSlug?: string;
    latch: boolean;
    jobRunId?: string;
    now?: Date;
    triggeredBy?: 'scheduled' | 'manual';
}): Promise<FingerprintPassResult> {
    const now = input.now ?? new Date();
    // Held as one object and read by member, so every sink below names its
    // field (`period.day`) rather than a bare local the logging rule cannot follow.
    const period = previousUtcDay(now);
    const { day, start, end } = period;
    const ctx = buildSystemContext({
        tenantId: input.tenantId,
        job: 'agent-fingerprint',
        ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
        ...(input.jobRunId ? { discriminator: input.jobRunId } : {}),
    });
    const triggeredBy = input.triggeredBy ?? 'scheduled';
    const zero = {
        tenantId: input.tenantId, day, evaluated: 0, alreadyScored: 0, learning: 0, steady: 0,
        anomalous: 0, latched: 0, agents: [] as AgentDayOutcome[],
    };

    try {
        const outcome = await runInTenantContext(ctx, async (db) => {
            await db.$executeRawUnsafe(
                `SELECT pg_advisory_xact_lock(hashtext($1))`,
                `agent-fingerprint:${ctx.tenantId}`,
            );

            // The register first, read one past the cap so a truncation is a
            // fact the pass holds. The ledger is then read for these ids only:
            // `AiDecisionLog.agentId` has no foreign key, so an id it names may
            // be one this tenant never had, and the behaviour-window read must
            // sit on its index prefix (tenantId, agentId, windowStart).
            const registered = await db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, name: true, ownerUserId: true },
                orderBy: { id: 'asc' },
                take: FINGERPRINT_MAX_AGENTS + 1,
            });
            const agentsTruncated = registered.length > FINGERPRINT_MAX_AGENTS;
            const inScope = registered.slice(0, FINGERPRINT_MAX_AGENTS);
            const todayByAgent = await readLedgerDay(db, ctx.tenantId, inScope.map((a) => a.id), start, end);
            const agents = inScope.filter((a) => {
                const f = todayByAgent.get(a.id);
                return f !== undefined && isActiveDay(f);
            });

            const scoredAlready = agents.length === 0
                ? []
                : await db.agentBehaviourBaseline.findMany({
                      where: { tenantId: ctx.tenantId, day: start, agentId: { in: agents.map((a) => a.id) } },
                      select: { agentId: true },
                      take: agents.length,
                  });
            const already = new Set(scoredAlready.map((r) => r.agentId));
            const toScore = agents.filter((a) => !already.has(a.id));
            const toScoreIds = toScore.map((a) => a.id);

            const history = toScoreIds.length === 0
                ? []
                : await drainPages((cursor) =>
                      db.agentBehaviourBaseline.findMany({
                          where: {
                              tenantId: ctx.tenantId,
                              agentId: { in: toScoreIds },
                              inBaseline: true,
                              day: { gte: baselineLookbackStart(start), lt: start },
                          },
                          select: {
                              id: true, agentId: true, day: true,
                              readCalls: true, proposeCalls: true, orchestrateCalls: true, activeHours: true,
                              proposals: true, guardFlags: true, modelCalls: true, tokens: true,
                          },
                          orderBy: { id: 'asc' },
                          take: DRAIN_PAGE_SIZE,
                          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                      }),
                  );
            const historyByAgent = new Map<string, { day: string; features: FingerprintFeatures }[]>();
            for (const h of history) {
                const list = historyByAgent.get(h.agentId) ?? [];
                list.push({ day: dayKeyFor(h.day), features: featuresOf(h) });
                historyByAgent.set(h.agentId, list);
            }

            // Every behaviour-anomaly finding on these agents, CLOSED included:
            // an anomalous agent reopens its own rather than opening a second.
            const refs = toScoreIds.map(behaviourAnomalySourceRef);
            const findings = refs.length === 0
                ? []
                : await db.finding.findMany({
                      where: {
                          tenantId: ctx.tenantId,
                          sourceKind: BEHAVIOUR_ANOMALY_FINDING_SOURCE_KIND,
                          sourceRef: { in: refs },
                          deletedAt: null,
                      },
                      select: { id: true, sourceRef: true, status: true },
                      orderBy: { createdAt: 'desc' },
                      take: refs.length * 4,
                  });
            const findingByRef = new Map<string, { id: string; status: string }>();
            for (const f of findings) {
                if (f.sourceRef && !findingByRef.has(f.sourceRef)) findingByRef.set(f.sourceRef, f);
            }

            const owners = [...new Set(toScore.map((a) => a.ownerUserId).filter((u): u is string => !!u))];
            const activeOwners = new Set(
                owners.length === 0
                    ? []
                    : (
                          await db.tenantMembership.findMany({
                              where: { tenantId: ctx.tenantId, userId: { in: owners }, status: 'ACTIVE' },
                              select: { userId: true },
                              take: owners.length,
                          })
                      ).map((m) => m.userId),
            );

            const results: AgentDayOutcome[] = [];
            for (const agent of toScore) {
                const features = todayByAgent.get(agent.id)!;
                const score = scoreDay({ today: features, baseline: historyByAgent.get(agent.id) ?? [] });
                await db.agentBehaviourBaseline.create({
                    data: {
                        tenantId: ctx.tenantId,
                        agentId: agent.id,
                        day: start,
                        ...features,
                        verdict: score.verdict,
                        score: score.score === null ? null : round2(score.score),
                        baselineDays: score.baselineDays,
                        inBaseline: score.inBaseline,
                    },
                    select: { id: true },
                });

                const result: AgentDayOutcome = {
                    agentId: agent.id,
                    verdict: score.verdict,
                    tier: score.tier,
                    score: score.score === null ? null : round2(score.score),
                    baselineDays: score.baselineDays,
                    findingAction: null,
                    findingId: null,
                    latched: false,
                };

                if (score.verdict === 'ANOMALOUS' && score.tier !== null && score.score !== null) {
                    const keyed = { sourceRef: behaviourAnomalySourceRef(agent.id) };
                    const ref = keyed.sourceRef;
                    const rounded = { score: round2(score.score) };
                    const text = anomalyFindingText({
                        agentId: agent.id,
                        agentName: agent.name,
                        day,
                        tier: score.tier,
                        score: score.score,
                        drivers: score.drivers,
                        baselineDays: score.baselineDays,
                    });
                    const existing = findingByRef.get(ref);
                    if (!existing) {
                        const created = await FindingRepository.create(db, ctx, {
                            severity: score.tier === 'LATCH' ? 'HIGH' : 'MEDIUM',
                            type: 'OBSERVATION',
                            title: sanitizePlainText(text.title),
                            description: sanitizePlainText(text.description),
                            status: 'OPEN',
                            sourceKind: BEHAVIOUR_ANOMALY_FINDING_SOURCE_KIND,
                            sourceRef: ref,
                            assigneeUserId:
                                agent.ownerUserId && activeOwners.has(agent.ownerUserId) ? agent.ownerUserId : null,
                        });
                        findingByRef.set(ref, { id: created.id, status: 'OPEN' });
                        result.findingAction = 'OPENED';
                        result.findingId = created.id;
                        await logEvent(db, ctx, {
                            action: 'CREATE',
                            entityType: 'Finding',
                            entityId: created.id,
                            details: `Agent behaviour fingerprint raised an anomaly on agent ${agent.id} for ${period.day}`,
                            detailsJson: {
                                category: 'entity_lifecycle',
                                entityName: 'Finding',
                                operation: 'created',
                                after: { sourceRef: keyed.sourceRef, day: period.day, tier: score.tier, score: rounded.score },
                            },
                        });
                    } else if (existing.status === 'CLOSED') {
                        await db.finding.update({
                            where: { id: existing.id },
                            data: {
                                status: 'OPEN',
                                title: sanitizePlainText(text.title),
                                description: sanitizePlainText(text.description),
                                verificationNotes: sanitizePlainText(
                                    `Reopened by the agent behaviour fingerprint: ${day} scored anomalous again`,
                                ),
                            },
                        });
                        findingByRef.set(ref, { id: existing.id, status: 'OPEN' });
                        result.findingAction = 'REOPENED';
                        result.findingId = existing.id;
                        await logEvent(db, ctx, {
                            action: 'STATUS_CHANGE',
                            entityType: 'Finding',
                            entityId: existing.id,
                            details: `Agent behaviour fingerprint reopened the anomaly on agent ${agent.id} for ${period.day}`,
                            detailsJson: {
                                category: 'status_change',
                                entityName: 'Finding',
                                before: { status: 'CLOSED' },
                                after: { status: 'OPEN', sourceRef: keyed.sourceRef, day: period.day, tier: score.tier },
                            },
                        });
                    } else {
                        result.findingAction = 'STILL_OPEN';
                        result.findingId = existing.id;
                    }

                    await db.agentBehaviourAnomaly.create({
                        data: {
                            tenantId: ctx.tenantId,
                            agentId: agent.id,
                            day: start,
                            score: round2(score.score),
                            tier: score.tier,
                            driversJson: driversForStorage(score.drivers) as Prisma.InputJsonValue,
                            findingId: result.findingId,
                        },
                        select: { id: true },
                    });
                }
                results.push(result);
            }

            const counts = {
                learning: results.filter((r) => r.verdict === 'LEARNING').length,
                steady: results.filter((r) => r.verdict === 'STEADY').length,
                anomalous: results.filter((r) => r.verdict === 'ANOMALOUS').length,
            };
            const nothingActive = agents.length === 0;
            const status: FingerprintPassResult['status'] = nothingActive ? 'NOT_APPLICABLE' : 'PASSED';
            const refusal = nothingActive ? ('NO_ACTIVITY' as const) : null;
            const row = await db.integrationExecution.create({
                data: {
                    tenantId: ctx.tenantId,
                    provider: AGENTIC_PASS_PROVIDER,
                    automationKey: FINGERPRINT_AUTOMATION_KEY,
                    status,
                    triggeredBy,
                    jobRunId: input.jobRunId ?? null,
                    completedAt: new Date(),
                    resultJson: {
                        day,
                        refusal,
                        detail: nothingActive
                            ? 'No registered agent was active on this day, so no agent-day was judged. '
                              + 'Zero judged is nothing measured — it is not a clean result.'
                            : null,
                        evaluated: results.length,
                        alreadyScored: already.size,
                        ...counts,
                        agents: results.slice(0, MAX_REPORTED_AGENTS).map((r) => ({
                            agentId: r.agentId,
                            verdict: r.verdict,
                            tier: r.tier,
                            score: r.score,
                            baselineDays: r.baselineDays,
                            findingAction: r.findingAction,
                        })),
                        agentsTruncated: results.length > MAX_REPORTED_AGENTS,
                        // The register held more agents than one pass scores;
                        // those past the cap were not judged.
                        registerTruncated: agentsTruncated,
                    } as Prisma.InputJsonValue,
                },
                select: { id: true },
            });

            return { results, counts, alreadyScored: already.size, status, refusal, executionId: row.id };
        }, { timeout: FINGERPRINT_TX_TIMEOUT_MS });

        // After commit: the breaker's own seam, which never throws. Only a
        // threshold-B day, only with the operator's latch key.
        const tally = { latched: 0 };
        if (input.latch) {
            for (const r of outcome.results) {
                if (r.tier !== 'LATCH') continue;
                const { latched: did } = await latchOnBehaviourAnomaly(ctx.tenantId, r.agentId, now);
                if (!did) continue;
                r.latched = true;
                tally.latched += 1;
                await runInTenantContext(ctx, (db) =>
                    db.agentBehaviourAnomaly.updateMany({
                        where: { tenantId: ctx.tenantId, agentId: r.agentId, day: start, latchedAt: null },
                        data: { latchedAt: now },
                    }),
                );
            }
        }

        recordAgentFingerprintPass({
            outcome: outcome.status === 'NOT_APPLICABLE' ? 'no_activity' : 'evaluated',
            days: {
                learning: outcome.counts.learning,
                steady: outcome.counts.steady,
                anomalous_finding: outcome.results.filter((r) => r.tier === 'FINDING').length,
                anomalous_latch: outcome.results.filter((r) => r.tier === 'LATCH').length,
                latched: tally.latched,
            },
        });
        logger.info('agent behaviour fingerprint pass complete', {
            component: 'agent-fingerprint',
            tenantId: ctx.tenantId,
            day: period.day,
            evaluated: outcome.results.length,
            alreadyScored: outcome.alreadyScored,
            anomalous: outcome.counts.anomalous,
            latched: tally.latched,
        });

        return {
            tenantId: input.tenantId,
            day,
            status: outcome.status,
            refusal: outcome.refusal,
            evaluated: outcome.results.length,
            alreadyScored: outcome.alreadyScored,
            ...outcome.counts,
            latched: tally.latched,
            agents: outcome.results,
            executionId: outcome.executionId,
        };
    } catch (err) {
        logger.error('agent behaviour fingerprint pass threw', {
            component: 'agent-fingerprint',
            tenantId: ctx.tenantId,
            day: period.day,
            errorMessage: err instanceof Error ? err.message : 'non-Error thrown',
        });
        let executionId: string | null = null;
        try {
            const row = await runInTenantContext(ctx, (db) =>
                db.integrationExecution.create({
                    data: {
                        tenantId: ctx.tenantId,
                        provider: AGENTIC_PASS_PROVIDER,
                        automationKey: FINGERPRINT_AUTOMATION_KEY,
                        status: 'ERROR',
                        triggeredBy,
                        jobRunId: input.jobRunId ?? null,
                        completedAt: new Date(),
                        resultJson: {
                            day,
                            refusal: null,
                            detail: `The pass could not run to completion: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
                        },
                    },
                    select: { id: true },
                }),
            );
            executionId = row.id;
        } catch (writeErr) {
            logger.error('agent behaviour fingerprint pass threw and its record could not be written', {
                component: 'agent-fingerprint',
                tenantId: ctx.tenantId,
                errorMessage: writeErr instanceof Error ? writeErr.message : 'non-Error thrown',
            });
        }
        recordAgentFingerprintPass({ outcome: 'error' });
        return { ...zero, status: 'ERROR', refusal: null, executionId };
    }
}
