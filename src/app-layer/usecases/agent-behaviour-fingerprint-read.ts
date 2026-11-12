/**
 * AGENT BEHAVIOUR FINGERPRINT — the human side (Morpheus roadmap Phase 1,
 * sub-phase 1.3): what the nightly detector found, why, and the one decision a
 * person can take about it.
 *
 * The detector itself is `agent-behaviour-fingerprint.ts` (the worker). This
 * file READS its two tables for the agent's Overview tab and the
 * `/agents/reports` behaviour view, and holds `acceptAgentBehaviourBaseline`.
 *
 * ── THE READ SAYS WHETHER ANYBODY WAS LOOKING ──────────────────────────────
 *
 * An empty anomaly list means two different things: the detector ran and found
 * nothing, or the detector is off for this workspace and looked at nothing.
 * Rendering both as "no anomalies" is the reassurance-shaped failure the
 * breaker's `null` row exists to avoid, so every read carries the operator
 * keys' decision (`detector.on`, `detector.basis`) and the day the detector
 * last scored this agent (or tenant). The surface words the empty state from
 * those, never from the list's length alone.
 *
 * ── WHY A SEPARATE "ACCEPT AS NEW NORMAL", AND WHY IT IS THE BREAKER'S EPOCH ─
 *
 * The 1.x pass re-baselines the fingerprint only when a person closes the
 * breaker `ACCEPTED_NEW_BASELINE`. That covers an anomaly that LATCHED. It
 * leaves no way out for one that did not: a threshold-A day (a finding, no
 * latch), or any day while the operator's latch key is off — the default once
 * the detector is on. An anomalous day never enters a later baseline, so a
 * deliberate, lasting change at that tier is re-scored ANOMALOUS every night
 * until the pre-change days age out of the 90-day look-back, and the one
 * finding per agent is reopened every night a person closes it. The breaker's
 * own docstring names that treadmill as the reason `ACCEPTED_NEW_BASELINE`
 * exists ("something to do other than switch the control off"); the fingerprint
 * had inherited the treadmill without the escape.
 *
 * So the narrowest control that closes it, and no wider:
 *
 *   · IT WRITES THE SAME COLUMN THE BREAKER'S CLOSE WRITES —
 *     `AgentCircuitBreaker.baselineEpoch` — and nothing of its own. One
 *     decision ("this change was intended"), one epoch, read by both
 *     detectors (`personSetBaselineEpoch`). A fingerprint-only epoch would be
 *     a second control free to disagree with the first: an agent accepted on
 *     one detector and judged against its old self by the other.
 *   · ONLY ON A CLOSED BREAKER. An OPEN breaker is decided by its close, which
 *     makes the person choose RESOLVED or ACCEPTED_NEW_BASELINE; offering a
 *     second button that re-baselines without closing would let the choice be
 *     skipped. The write is conditional on `state = 'CLOSED'`, so a latch that
 *     lands between the read and the write refuses rather than being undone.
 *   · ONLY WHEN THERE IS SOMETHING TO ACCEPT — an anomaly raised after the last
 *     re-baseline a person set. It is not a "wipe this agent's history" button.
 *   · A PERSON, BY NAME. The breaker close's gate (`admin.agent_registry` at
 *     the route, `assertAgentGovernanceAdmin` here), and refused for an API key
 *     or an agent-bound context: an agent must not be able to declare its own
 *     behaviour normal. Audited, hash-chained, with the anomaly it answered.
 *   · IT TOUCHES NO FINDING. Re-baselining stops tomorrow's re-raise (the agent
 *     is LEARNING again); closing today's finding is the findings workflow's
 *     act, done where findings are closed.
 *
 * AN AGENT WITH NO BREAKER ROW IS ACCEPTED, NOT REFUSED. The fingerprint scores
 * every agent with any activity in the ledger — model calls, proposals, guard
 * flags — while the breaker row is created only by a tool-funnel call
 * (`openBreakerGate`) or a latch. So an agent that only ever proposes, or runs
 * read-only on Flue, is scored and can be judged ANOMALOUS every night with no
 * row to carry an epoch; refusing it would leave exactly the treadmill this
 * control exists to end, for exactly the agents with the least other traffic.
 * A missing row is a CLOSED breaker that has never been observed, so the
 * acceptance creates it through the store's one insert site
 * (`ensureBreakerRow`, in this transaction) and then moves its epoch. The
 * epoch written is strictly after the row's `createdAt` — never equal — because
 * an epoch AT creation is read as the column default, "nobody decided"
 * (`personSetBaselineEpoch`), and an acceptance that read back as that would
 * be recorded and ignored.
 *
 * @module usecases/agent-behaviour-fingerprint-read
 */
import { env } from '@/env';
import { runInTenantContext } from '@/lib/db-context';
import { ConflictError, forbidden, notFound } from '@/lib/errors/types';
import { recordAgentFingerprintBaselineAccepted } from '@/lib/observability/integration-metrics';
import {
    BASELINE_LOOKBACK_DAYS,
    BASELINE_MAX_DAYS,
    BASELINE_MIN_DAYS,
    dayKeyFor,
    FINGERPRINT_FEATURES,
    personSetBaselineEpoch,
    Z_FINDING,
    Z_LATCH,
    type AnomalyTier,
    type FingerprintFeature,
    type FingerprintVerdict,
} from '@/lib/agentic/behaviour-fingerprint';
import { ensureBreakerRow } from '@/lib/agentic/circuit-breaker-store';
import {
    behaviourDetectorDecisionFor,
    type BehaviourDetectorBasis,
} from '@/lib/agentic/behaviour-detector-switch';

import { assertCanRead } from '../policies/common';
import { assertAgentGovernanceAdmin, meetsAgentGovernanceAdmin } from '../policies/agent-governance.policies';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';

/** Scored days the agent panel shows, newest first. */
export const FINGERPRINT_PANEL_DAYS = 30;
/** Anomalies the agent panel shows, newest first. */
export const FINGERPRINT_PANEL_ANOMALIES = 10;
/** The tenant view's window, in days, and its row cap. */
export const FINGERPRINT_REPORT_DAYS = 30;
export const FINGERPRINT_REPORT_LIMIT = 200;

const DAY_MS = 86_400_000;

/** Why an acceptance was refused. Stable codes; the surface words them. */
export const BASELINE_ACCEPT_REFUSALS = [
    'NOT_A_PERSON',
    'BREAKER_OPEN',
    'NOTHING_TO_ACCEPT',
] as const;
export type BaselineAcceptRefusal = (typeof BASELINE_ACCEPT_REFUSALS)[number];

export interface FingerprintDriverView {
    feature: FingerprintFeature;
    observed: number;
    mean: number;
    sd: number;
    z: number;
}

export interface FingerprintAnomalyView {
    id: string;
    agentId: string;
    day: string;
    score: number;
    tier: AnomalyTier;
    drivers: FingerprintDriverView[];
    findingId: string | null;
    latchedAt: string | null;
    createdAt: string;
}

export interface FingerprintDetectorView {
    on: boolean;
    basis: BehaviourDetectorBasis;
    latch: boolean;
}

/** The thresholds in force, returned rather than copied into the client. */
export const FINGERPRINT_THRESHOLDS = Object.freeze({
    zFinding: Z_FINDING,
    zLatch: Z_LATCH,
    baselineMinDays: BASELINE_MIN_DAYS,
    baselineMaxDays: BASELINE_MAX_DAYS,
    lookbackDays: BASELINE_LOOKBACK_DAYS,
});

function detectorFor(ctx: RequestContext): FingerprintDetectorView {
    const d = behaviourDetectorDecisionFor({
        detector: env.AGENT_BEHAVIOUR_DETECTOR,
        tenants: env.AGENT_BEHAVIOUR_DETECTOR_TENANTS,
        latch: env.AGENT_BEHAVIOUR_DETECTOR_LATCH,
        tenantSlug: ctx.tenantSlug,
    });
    return { on: d.on, basis: d.basis, latch: d.latch };
}

/**
 * The read gate: the breaker's own read key. The fingerprint is the breaker's
 * sibling detector and its "why" sits beside the breaker's, so it is read
 * under the same authority (`admin.agent_registry`), at the route AND here,
 * because the reports page calls this without a route in front of it.
 */
function assertMayReadFingerprint(ctx: RequestContext): void {
    assertCanRead(ctx);
    if (ctx.appPermissions?.admin?.agent_registry !== true) {
        throw forbidden('You do not have permission to read agent behaviour.');
    }
}

/**
 * Who may accept a new baseline: the breaker close's floor, a PERSON. Exported
 * so the read returns the affordance the usecase would honour.
 */
export function baselineAcceptRefusalForCaller(ctx: RequestContext): BaselineAcceptRefusal | 'FORBIDDEN' | null {
    if (ctx.apiKeyId || ctx.agentId) return 'NOT_A_PERSON';
    if (!meetsAgentGovernanceAdmin(ctx, 'agent_registry')) return 'FORBIDDEN';
    return null;
}

/**
 * The row-state half of the acceptance rule, pure so the read and the write
 * ask it identically. No breaker row is a CLOSED breaker nobody has
 * re-baselined (see the module header), not a refusal.
 */
export function baselineAcceptRefusalForState(input: {
    breaker: { state: string; baselineEpoch: Date; createdAt: Date } | null;
    latestAnomalyCreatedAt: Date | null;
}): BaselineAcceptRefusal | null {
    if (input.breaker && input.breaker.state !== 'CLOSED') return 'BREAKER_OPEN';
    if (!input.latestAnomalyCreatedAt) return 'NOTHING_TO_ACCEPT';
    const epoch = personSetBaselineEpoch(input.breaker);
    if (epoch && input.latestAnomalyCreatedAt.getTime() <= epoch.getTime()) return 'NOTHING_TO_ACCEPT';
    return null;
}

function driversOf(raw: unknown): FingerprintDriverView[] {
    if (!Array.isArray(raw)) return [];
    const known = new Set<string>(FINGERPRINT_FEATURES);
    const out: FingerprintDriverView[] = [];
    for (const d of raw) {
        if (!d || typeof d !== 'object') continue;
        const r = d as Record<string, unknown>;
        if (typeof r.feature !== 'string' || !known.has(r.feature)) continue;
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        out.push({
            feature: r.feature as FingerprintFeature,
            observed: num(r.observed),
            mean: num(r.mean),
            sd: num(r.sd),
            z: num(r.z),
        });
    }
    return out;
}

function anomalyView(a: {
    id: string;
    agentId: string;
    day: Date;
    score: number;
    tier: string;
    driversJson: unknown;
    findingId: string | null;
    latchedAt: Date | null;
    createdAt: Date;
}): FingerprintAnomalyView {
    return {
        id: a.id,
        agentId: a.agentId,
        day: dayKeyFor(a.day),
        score: a.score,
        tier: a.tier === 'LATCH' ? 'LATCH' : 'FINDING',
        drivers: driversOf(a.driversJson),
        findingId: a.findingId,
        latchedAt: a.latchedAt ? a.latchedAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
    };
}

const ANOMALY_SELECT = {
    id: true,
    agentId: true,
    day: true,
    score: true,
    tier: true,
    driversJson: true,
    findingId: true,
    latchedAt: true,
    createdAt: true,
} as const;

/** One agent's fingerprint: recent days, recent anomalies, the epoch, and the affordance. */
export async function getAgentBehaviourFingerprint(ctx: RequestContext, agentId: string) {
    assertMayReadFingerprint(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!agent) throw notFound('Agent not found');

        const [days, anomalies, breaker] = await Promise.all([
            db.agentBehaviourBaseline.findMany({
                where: { tenantId: ctx.tenantId, agentId },
                orderBy: { day: 'desc' },
                take: FINGERPRINT_PANEL_DAYS,
                select: {
                    day: true,
                    verdict: true,
                    score: true,
                    baselineDays: true,
                    inBaseline: true,
                    readCalls: true,
                    proposeCalls: true,
                    orchestrateCalls: true,
                    activeHours: true,
                    proposals: true,
                    guardFlags: true,
                    modelCalls: true,
                    tokens: true,
                },
            }),
            db.agentBehaviourAnomaly.findMany({
                where: { tenantId: ctx.tenantId, agentId },
                orderBy: [{ day: 'desc' }, { id: 'asc' }],
                take: FINGERPRINT_PANEL_ANOMALIES,
                select: ANOMALY_SELECT,
            }),
            db.agentCircuitBreaker.findUnique({
                where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
                select: { state: true, baselineEpoch: true, createdAt: true },
            }),
        ]);

        const latestAnomalyCreatedAt = anomalies.reduce<Date | null>(
            (latest, a) => (latest === null || a.createdAt > latest ? a.createdAt : latest),
            null,
        );
        const epoch = personSetBaselineEpoch(breaker);
        const callerRefusal = baselineAcceptRefusalForCaller(ctx);
        const stateRefusal = baselineAcceptRefusalForState({ breaker, latestAnomalyCreatedAt });

        return {
            agentId,
            detector: detectorFor(ctx),
            thresholds: FINGERPRINT_THRESHOLDS,
            features: [...FINGERPRINT_FEATURES],
            lastScoredDay: days[0] ? dayKeyFor(days[0].day) : null,
            days: days.map((d) => ({
                day: dayKeyFor(d.day),
                verdict: d.verdict as FingerprintVerdict,
                score: d.score,
                baselineDays: d.baselineDays,
                inBaseline: d.inBaseline,
                features: Object.fromEntries(FINGERPRINT_FEATURES.map((f) => [f, d[f]])) as Record<FingerprintFeature, number>,
            })),
            anomalies: anomalies.map(anomalyView),
            /** The re-baseline a PERSON set, if any; days before it are not in the baseline. */
            baselineEpoch: epoch ? epoch.toISOString() : null,
            acceptBaseline: {
                /** Whether this caller would be allowed, and the state allows it, now. */
                allowed: callerRefusal === null && stateRefusal === null,
                /** Why not, for the surface to word. Caller refusals first. */
                refusal: callerRefusal ?? stateRefusal,
            },
        };
    });
}

/**
 * The tenant's anomalies over the last `FINGERPRINT_REPORT_DAYS`, newest first,
 * with each agent's name. Reads one past the cap so truncation is a fact.
 */
export async function listAgentBehaviourAnomalies(ctx: RequestContext, now: Date = new Date()) {
    assertMayReadFingerprint(ctx);
    const since = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - FINGERPRINT_REPORT_DAYS * DAY_MS);
    return runInTenantContext(ctx, async (db) => {
        const [rows, lastScored] = await Promise.all([
            db.agentBehaviourAnomaly.findMany({
                where: { tenantId: ctx.tenantId, day: { gte: since } },
                orderBy: [{ day: 'desc' }, { id: 'asc' }],
                take: FINGERPRINT_REPORT_LIMIT + 1,
                select: ANOMALY_SELECT,
            }),
            db.agentBehaviourBaseline.findFirst({
                where: { tenantId: ctx.tenantId },
                orderBy: { day: 'desc' },
                select: { day: true },
            }),
        ]);
        const truncated = rows.length > FINGERPRINT_REPORT_LIMIT;
        const kept = rows.slice(0, FINGERPRINT_REPORT_LIMIT);
        const agentIds = [...new Set(kept.map((r) => r.agentId))];
        const agents =
            agentIds.length === 0
                ? []
                : await db.registeredAgent.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                      select: { id: true, name: true },
                      take: agentIds.length,
                  });
        const names = new Map(agents.map((a) => [a.id, a.name]));
        return {
            detector: detectorFor(ctx),
            thresholds: FINGERPRINT_THRESHOLDS,
            windowDays: FINGERPRINT_REPORT_DAYS,
            since: dayKeyFor(since),
            lastScoredDay: lastScored ? dayKeyFor(lastScored.day) : null,
            truncated,
            anomalies: kept.map((r) => ({ ...anomalyView(r), agentName: names.get(r.agentId) ?? null })),
        };
    });
}

/**
 * A person accepts the agent's changed behaviour as its new normal: the
 * breaker's `baselineEpoch` moves to now, so BOTH detectors re-learn from it.
 * See the module header for every limit and the reason for each.
 */
export async function acceptAgentBehaviourBaseline(ctx: RequestContext, agentId: string) {
    assertAgentGovernanceAdmin(ctx, 'agent_registry');
    if (baselineAcceptRefusalForCaller(ctx) === 'NOT_A_PERSON') {
        throw forbidden('Only a person can accept an agent’s new behaviour as normal.', {
            reason: 'NOT_A_PERSON' satisfies BaselineAcceptRefusal,
        });
    }
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!agent) throw notFound('Agent not found');

        const [existingBreaker, latest] = await Promise.all([
            db.agentCircuitBreaker.findUnique({
                where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
                select: { state: true, baselineEpoch: true, createdAt: true },
            }),
            db.agentBehaviourAnomaly.findFirst({
                where: { tenantId: ctx.tenantId, agentId },
                orderBy: { createdAt: 'desc' },
                select: { id: true, day: true, tier: true, createdAt: true },
            }),
        ]);
        const refusal = baselineAcceptRefusalForState({
            breaker: existingBreaker,
            latestAnomalyCreatedAt: latest?.createdAt ?? null,
        });
        if (refusal) throw refusalError(refusal);

        // No row yet (an agent the fingerprint scores but the tool funnel never
        // saw): create it here, in this transaction, through the one insert
        // site, and read back its `createdAt` so the epoch can be placed after it.
        let breaker = existingBreaker;
        if (!breaker) {
            await ensureBreakerRow(db, ctx.tenantId, agentId);
            breaker = await db.agentCircuitBreaker.findUnique({
                where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
                select: { state: true, baselineEpoch: true, createdAt: true },
            });
            if (!breaker || breaker.state !== 'CLOSED') throw refusalError('BREAKER_OPEN');
        }

        // Strictly after creation, whatever the app and database clocks say: an
        // epoch equal to `createdAt` reads as the default (`personSetBaselineEpoch`).
        const now = new Date(Math.max(Date.now(), breaker.createdAt.getTime() + 1));
        // Conditional on CLOSED: a latch landing between the read above and this
        // write must refuse, not be silently re-baselined under.
        const moved = await db.agentCircuitBreaker.updateMany({
            where: { tenantId: ctx.tenantId, agentId, state: 'CLOSED' },
            data: {
                baselineEpoch: now,
                lastEvaluatedWindow: null,
                anomalousStreak: 0,
                streakSignals: [],
            },
        });
        if (moved.count !== 1) throw refusalError('BREAKER_OPEN');

        // Held as one object and read by member, so the audit row names each
        // field (`answered.anomalyDay`) rather than a bare local or a helper
        // call the logging rule cannot open. Identifiers, a day, a tier code
        // and a timestamp — never content.
        const answered = {
            agentId,
            anomalyId: latest?.id ?? null,
            anomalyDay: latest ? dayKeyFor(latest.day) : null,
            anomalyTier: latest?.tier ?? null,
            baselineEpoch: now.toISOString(),
        };

        await logEvent(db, ctx, {
            action: 'AGENT_BEHAVIOUR_BASELINE_ACCEPTED',
            entityType: 'RegisteredAgent',
            entityId: answered.agentId,
            detailsJson: {
                category: 'access',
                entityName: 'AgentCircuitBreaker',
                operation: 'accept_new_baseline',
                summary:
                    'Accepted the agent’s changed behaviour as its new normal; '
                    + 'both behaviour detectors discard the prior baseline and re-learn',
                anomalyId: answered.anomalyId,
                anomalyDay: answered.anomalyDay,
                anomalyTier: answered.anomalyTier,
                baselineEpoch: answered.baselineEpoch,
            },
        });
        recordAgentFingerprintBaselineAccepted();

        return { agentId, baselineEpoch: answered.baselineEpoch };
    });
}

function refusalError(reason: BaselineAcceptRefusal) {
    const message: Record<BaselineAcceptRefusal, string> = {
        NOT_A_PERSON: 'Only a person can accept an agent’s new behaviour as normal.',
        BREAKER_OPEN: 'The agent’s circuit breaker is open: close it, choosing whether the change was intended.',
        NOTHING_TO_ACCEPT: 'There is no behaviour anomaly since the last accepted baseline.',
    };
    return new ConflictError(message[reason], { reason });
}
