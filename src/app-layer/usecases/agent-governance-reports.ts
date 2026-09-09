/**
 * THE ANSWER TO "SHOW ME YOUR AGENT GOVERNANCE".
 *
 * Nine prompts of this roadmap built records: a register, a risk assessment, a
 * policy card, a tool-manifest pin, an approval queue with a four-eyes rule, a
 * kill switch and a drill that proves it. Each is queryable one row at a time by
 * somebody who already knows it exists. None of them is what an assessor asks
 * for, which is one artefact that answers, for the whole tenant:
 *
 *   1. WHICH agents run here, at what autonomy, and who answers for each.
 *   2. WHICH of the OWASP ASI01–ASI10 agentic risks each is covered for.
 *   3. WHETHER the human approvals on what they propose mean anything.
 *   4. WHAT has gone wrong, and whether the stop control has been proven.
 *   5. WHICH of them somebody else wrote, and what assurance we hold on them.
 *
 * This module is those five reports. It stores nothing, writes nothing and adds
 * no authority — every figure is derived from rows the earlier prompts already
 * landed. That is deliberate: a governance report that needed its own table
 * would be a second copy of the register, and two copies can disagree about
 * what a tenant runs.
 *
 * ── EVERY NUMBER CARRIES ITS DEFINITION ──────────────────────────────
 *
 * A report that renders is not a report that is true. "12 agents" is not a fact
 * until somebody has said which twelve — over what population, at what moment,
 * counting retired ones or not — so each report's `metrics` block is emitted
 * alongside a `definitions` block resolved from `@/lib/agentic/report-definitions`,
 * and the pack fails its own coverage assertion if a figure ships without one.
 * A number nobody wrote a definition for is a number nobody can defend.
 *
 * ── EMPTY, UNKNOWN AND ZERO ARE THREE DIFFERENT ANSWERS ──────────────
 *
 * Every figure is a `Measure`, not a number, for the reason
 * `@/lib/agentic/report-measures` sets out at length. The sharpest case in the
 * pack is `incidents.tool_calls_after_kill`: summing an empty drill list gives
 * `0`, which reads as the strongest claim the product can make — "nothing got
 * through the kill switch" — from a tenant that has never run a drill. It
 * reports NO_POPULATION instead.
 *
 * An empty list is not the only way to get that zero, and the second way
 * survived the first fix: an ERRORED drill is a ROW, so the emptiness guard
 * never fires, and it contributes the `@default(0)` no failed run overwrote.
 * The sum therefore runs over drills that MEASURED something, and a tenant
 * whose every drill errored reports NOT_ASSESSED / ALL_DRILLS_ERRORED — a
 * different fact from never having drilled, and a different thing to go fix.
 *
 * ── WHY THERE IS NO PAGE ─────────────────────────────────────────────
 *
 * The pack is exposed as ONE read-only API route and no new UI surface. It is
 * an artefact somebody hands over — the shape it needs is a document with its
 * definitions attached, not a dashboard to browse — and the operator surfaces
 * that DO browse this data already exist per subsystem (the register, the
 * review-quality page, the leaver-pass and kill-switch lists). A page would be
 * a sixth place the same rows are rendered, with its own filters to keep in
 * step, for a reader who is going to export it anyway.
 *
 * ── Bounds ───────────────────────────────────────────────────────────
 *
 * Every read is `take:`-bounded and every report says when a bound bit
 * (`truncated`). A report over "the most recent 500" that presents itself as a
 * report over everything is a denominator quietly replaced by a smaller one —
 * the same defect the automation-bias module is about, one level up.
 */
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { UNATTENDED_AUTONOMY } from '@/lib/agentic/agent-risk-scoring';
import { KILL_SWITCH_DRILL_AGENT_ID } from '@/lib/agentic/kill-switch';
import {
    definitionsFor,
    type MetricDefinition,
    type MetricId,
} from '@/lib/agentic/report-definitions';
import {
    measured,
    noPopulation,
    notAssessed,
    notObservable,
    ratio,
    type Measure,
} from '@/lib/agentic/report-measures';
import { assertCanRead } from '../policies/common';
import { computeTenantAgentRiskCoverage } from './agent-coverage';
import { computeAgentReviewQuality } from './agent-review-quality';
import { getSampleAuditDisagreementRate } from './agent-proposal-sample-audit';
import { listToolManifests } from './mcp-tool-manifest';
import type { RequestContext } from '../types';

/** Default lookback for the two window-scoped reports. A quarter. */
export const DEFAULT_REPORT_WINDOW_DAYS = 90;
/** The longest lookback accepted. */
export const MAX_REPORT_WINDOW_DAYS = 365;

/** How many agents one pack describes. */
export const AGENT_ROW_CAP = 500;
/** How many history rows (kills, drills) one pack describes. */
export const HISTORY_ROW_CAP = 500;

/** The five reports, by stable id. Cited in a finding, so authored not derived. */
export const REPORT_IDS = [
    'agent-inventory',
    'asi-coverage',
    'approval-statistics',
    'incident-history',
    'third-party-assessments',
] as const;

export type ReportId = (typeof REPORT_IDS)[number];

/**
 * What every report is wrapped in.
 *
 * `definitions` is not decoration and not a footnote: it is resolved from the
 * keys of `metrics` on every build, so the two cannot drift. A reader holding
 * the JSON holds the meaning of every figure in it.
 */
export interface ReportEnvelope<TBody> {
    reportId: ReportId;
    /** The instant every AS_OF_GENERATION figure is true of. */
    generatedAt: Date;
    /** Present only on reports with OVER_WINDOW figures. */
    window: { days: number; since: Date } | null;
    /** True when a `take:` bound cut rows out of the population. */
    truncated: boolean;
    metrics: Partial<Record<MetricId, Measure>>;
    definitions: MetricDefinition[];
    body: TBody;
}

function envelope<TBody>(
    reportId: ReportId,
    generatedAt: Date,
    window: { days: number; since: Date } | null,
    truncated: boolean,
    metrics: Partial<Record<MetricId, Measure>>,
    body: TBody,
): ReportEnvelope<TBody> {
    return {
        reportId,
        generatedAt,
        window,
        truncated,
        metrics,
        definitions: definitionsFor(Object.keys(metrics)),
        body,
    };
}

/** 1..365, or a 400. Validated here so every caller is refused by one rule. */
function resolveWindow(days: number | undefined): { days: number; since: Date } {
    const windowDays = days ?? DEFAULT_REPORT_WINDOW_DAYS;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_REPORT_WINDOW_DAYS) {
        throw badRequest(`windowDays must be an integer between 1 and ${MAX_REPORT_WINDOW_DAYS}`);
    }
    return { days: windowDays, since: new Date(Date.now() - windowDays * 86_400_000) };
}

// ═══════════════════════════════════════════════════════════════════
// 1 — AGENT INVENTORY
// ═══════════════════════════════════════════════════════════════════

/** How the register's state is reported per agent, with no fact merged. */
export interface InventoryRow {
    agentId: string;
    name: string;
    status: string;
    autonomyLevel: number;
    /** TRUE at or above the unattended rung. The declaration, not an observation. */
    unattended: boolean;
    dataAccessScope: string;
    reversibility: string;
    provenance: string;
    ownerUserId: string;
    ownerName: string | null;
    vendorId: string | null;
    vendorName: string | null;
    riskTier: string | null;
    riskTierScoredAt: Date | null;
    /**
     * Three states, never merged into the tier. NEVER_ASSESSED is the one that
     * must not read as a low tier: an agent nobody has scored is the one that
     * should not be running.
     */
    assessmentState: 'NEVER_ASSESSED' | 'ASSESSED' | 'ASSESSED_STALE';
    /** Which staleness triggers fired, as codes. Empty unless ASSESSED_STALE. */
    staleTriggers: string[];
    grantedToolCount: number;
    /** Credentials that speak for this agent — what suspending it must reach. */
    credentialCount: number;
    /** `null` means NO CARD, which is a different fact from version 0. */
    policyCardVersion: number | null;
    /** The kill axis, separate from `status` because they are separate facts. */
    killState: 'RUNNING' | 'KILLED_BY_AGENT_SCOPE' | 'KILLED_BY_TENANT_SCOPE';
    /** `null` means no breaker row — never observed, not "closed". */
    breakerState: string | null;
}

export interface AgentInventoryBody {
    agents: InventoryRow[];
    /**
     * The legacy placeholder row, if the register carries one. Reported OUT of
     * every count and named here rather than silently dropped — an assessor who
     * sees it knows there are pre-register proposals nobody has attributed yet.
     */
    legacyPlaceholderPresent: boolean;
}

export async function buildAgentInventoryReport(
    ctx: RequestContext,
): Promise<ReportEnvelope<AgentInventoryBody>> {
    assertCanRead(ctx);
    const generatedAt = new Date();

    const loaded = await loadAgents(ctx);
    const { agents, truncated, legacyPlaceholderPresent } = loaded;

    const rows: InventoryRow[] = agents.map((a) => ({
        agentId: a.id,
        name: a.name,
        status: a.status,
        autonomyLevel: a.autonomyLevel,
        unattended: a.autonomyLevel >= UNATTENDED_AUTONOMY,
        dataAccessScope: a.dataAccessScope,
        reversibility: a.reversibility,
        provenance: a.provenance,
        ownerUserId: a.ownerUserId,
        ownerName: a.ownerName,
        vendorId: a.vendorId,
        vendorName: a.vendorName,
        riskTier: a.riskTier,
        riskTierScoredAt: a.riskTierScoredAt,
        assessmentState: a.assessmentState,
        staleTriggers: a.staleTriggers,
        grantedToolCount: a.grantedToolCount,
        credentialCount: a.credentialCount,
        policyCardVersion: a.policyCardVersion,
        killState: a.killState,
        breakerState: a.breakerState,
    }));

    const total = rows.length;
    const count = (pred: (r: InventoryRow) => boolean): Measure =>
        total === 0 ? noPopulation('NO_AGENTS_REGISTERED') : measured(rows.filter(pred).length);

    return envelope(
        'agent-inventory',
        generatedAt,
        null,
        truncated,
        {
            'inventory.registered_agents': measured(total),
            'inventory.active_agents': count((r) => r.status === 'ACTIVE'),
            'inventory.retired_agents': count((r) => r.status === 'RETIRED'),
            'inventory.unscored_agents': count((r) => r.riskTier === null),
            'inventory.stale_assessments': count((r) => r.assessmentState === 'ASSESSED_STALE'),
            'inventory.unattended_agents': count((r) => r.unattended),
            'inventory.third_party_agents': count((r) => r.provenance === 'THIRD_PARTY'),
            'inventory.agents_without_policy_card': count((r) => r.policyCardVersion === null),
        },
        { agents: rows, legacyPlaceholderPresent },
    );
}

// ═══════════════════════════════════════════════════════════════════
// 2 — ASI01–ASI10 COVERAGE PER AGENT
// ═══════════════════════════════════════════════════════════════════

export interface AsiAgentRow {
    agentId: string;
    name: string;
    status: string;
    /** Five DISJOINT code lists. A percentage cannot answer "which risk is open". */
    covered: string[];
    partiallyCovered: string[];
    reviewNeeded: string[];
    uncovered: string[];
    /**
     * Risks the agent's own register row puts out of scope — zero tool grants
     * for ASI02, autonomy 0 for ASI08. A separate list rather than a silent
     * omission: an assessor is owed the count they can check against the
     * register, and folding these into `uncovered` would report a capability
     * the agent provably lacks as an open finding.
     */
    notApplicable: string[];
}

/** One risk, across every agent — the column an assessor reads down. */
export interface AsiRiskRow {
    code: string;
    title: string;
    agentsCovered: number;
    agentsPartiallyCovered: number;
    agentsReviewNeeded: number;
    agentsUncovered: number;
    agentsNotApplicable: number;
}

export interface AsiCoverageBody {
    /**
     * FALSE when neither representation of the framework is installed. Every
     * coverage figure is NOT_ASSESSED in that case rather than 0 — a tenant that
     * has not installed the framework has not been found to cover nothing.
     */
    frameworkInstalled: boolean;
    framework: { key: string; name: string } | null;
    agents: AsiAgentRow[];
    risks: AsiRiskRow[];
}

export async function buildAsiCoverageReport(
    ctx: RequestContext,
): Promise<ReportEnvelope<AsiCoverageBody>> {
    assertCanRead(ctx);
    const generatedAt = new Date();

    // The population is the one `loadAgents` defines, so "agents in scope" means
    // the same set here as in the inventory report. `computeTenantAgentRiskCoverage`
    // reads the register directly and therefore still carries the legacy
    // placeholder; a matrix over a different denominator from the inventory's
    // would be two reports in one pack disagreeing about how many agents run here.
    const { agents: realAgents, truncated } = await loadAgents(ctx);
    const realIds = new Set(realAgents.map((a) => a.id));
    const coverage = await computeTenantAgentRiskCoverage(ctx, { take: AGENT_ROW_CAP });
    const reports = coverage.agents.filter((r) => realIds.has(r.agent.id));

    // These two come from the CATALOGUE, not from the agent list. An agentless
    // tenant can still have the framework installed, and reading the flag off
    // the (empty) agent list said the opposite — a different finding, aimed at a
    // different person, than "nobody has registered an agent yet".
    const frameworkInstalled = coverage.frameworkInstalled;
    const framework = coverage.framework === null ? null : { ...coverage.framework };

    const agents: AsiAgentRow[] = reports.map((r) => ({
        agentId: r.agent.id,
        name: r.agent.name,
        status: r.agent.status,
        covered: [...r.summary.covered],
        partiallyCovered: [...r.summary.partiallyCovered],
        reviewNeeded: [...r.summary.reviewNeeded],
        uncovered: [...r.summary.uncovered],
        notApplicable: [...r.summary.notApplicable],
    }));

    // The transpose. SEEDED from the framework's own risk list so every risk
    // appears even when no agent does — an assessor reading down the column
    // needs to see ASI07 with four zeros, not to find it missing — and then
    // filled from the per-agent entries, so the two halves of the report cannot
    // disagree about the same cell.
    const byCode = new Map<string, AsiRiskRow>(
        coverage.risks.map((r) => [
            r.code,
            {
                code: r.code,
                title: r.title,
                agentsCovered: 0,
                agentsPartiallyCovered: 0,
                agentsReviewNeeded: 0,
                agentsUncovered: 0,
                agentsNotApplicable: 0,
            },
        ]),
    );
    for (const report of reports) {
        for (const entry of report.entries) {
            const row: AsiRiskRow = byCode.get(entry.code) ?? {
                code: entry.code,
                title: entry.title,
                agentsCovered: 0,
                agentsPartiallyCovered: 0,
                agentsReviewNeeded: 0,
                agentsUncovered: 0,
                agentsNotApplicable: 0,
            };
            // NOT_APPLICABLE is tested FIRST and explicitly. The trailing
            // `else` is a catch-all for "everything that is not one of the
            // three named statuses", so without this branch an N/A entry would
            // be filed under `agentsUncovered` — a risk the register says the
            // agent cannot reach, reported as an open finding against it.
            if (entry.status === 'NOT_APPLICABLE') row.agentsNotApplicable += 1;
            else if (entry.status === 'COVERED') row.agentsCovered += 1;
            else if (entry.status === 'PARTIALLY_COVERED') row.agentsPartiallyCovered += 1;
            else if (entry.status === 'REVIEW_NEEDED') row.agentsReviewNeeded += 1;
            else row.agentsUncovered += 1;
            byCode.set(entry.code, row);
        }
    }
    const risks = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));

    // Three different absences, and they are not interchangeable.
    const noAgents = agents.length === 0;
    const coverageMeasure = (value: () => number): Measure => {
        if (noAgents) return noPopulation('NO_AGENTS_REGISTERED');
        if (!frameworkInstalled) return notAssessed('ASI_FRAMEWORK_NOT_INSTALLED');
        if (risks.length === 0) return notAssessed('ASI_FRAMEWORK_EMPTY');
        return measured(value());
    };

    return envelope(
        'asi-coverage',
        generatedAt,
        null,
        truncated,
        {
            'asi.agents_in_scope': measured(agents.length),
            'asi.risks_in_framework': frameworkInstalled
                ? measured(coverage.risks.length)
                : notAssessed('ASI_FRAMEWORK_NOT_INSTALLED'),
            'asi.agents_fully_covered': coverageMeasure(
                () => agents.filter((a) => a.uncovered.length === 0 && a.reviewNeeded.length === 0)
                    .length,
            ),
            'asi.risks_covered_by_no_agent': coverageMeasure(
                // The N/A term is not a nicety. A risk that applies to NOBODY
                // in the population — ASI02 in a tenant whose every agent holds
                // zero tool grants — has no agent covering it by definition, so
                // without this it is reported as an open gap for everybody,
                // which is the same absence-as-finding error the derivation
                // exists to stop. `<` not `<=`: one applicable agent leaving it
                // uncovered still makes it a gap.
                () => risks.filter(
                    (r) => r.agentsCovered === 0
                        && r.agentsPartiallyCovered === 0
                        && r.agentsNotApplicable < agents.length,
                ).length,
            ),
        },
        { frameworkInstalled, framework, agents, risks },
    );
}

// ═══════════════════════════════════════════════════════════════════
// 3 — APPROVAL STATISTICS (including the automation-bias metrics)
// ═══════════════════════════════════════════════════════════════════

export interface ApprovalStatisticsBody {
    /** Per-reviewer counts and estimates, exactly as the bias engine reports them. */
    reviewers: unknown[];
    /** Per-agent decision counts and pinned approval rungs. */
    agents: unknown[];
    /** Every fired pattern. Codes, ids and numbers — never proposal content. */
    signals: unknown[];
    /** What this report CANNOT answer, named rather than approximated. */
    unobservable: readonly string[];
    /** The retrospective second-opinion audit, which is the only quality signal. */
    sampleAudit: {
        sampled: number;
        answered: number;
        pending: number;
        concurred: number;
        dissented: number;
        indeterminate: number;
    };
    /** The constants every signal was measured against. */
    thresholds: Record<string, number>;
}

export async function buildApprovalStatisticsReport(
    ctx: RequestContext,
    opts: { windowDays?: number } = {},
): Promise<ReportEnvelope<ApprovalStatisticsBody>> {
    assertCanRead(ctx);
    const generatedAt = new Date();
    const window = resolveWindow(opts.windowDays);

    // `alert: false` — a report is a read, and a read that always has a side
    // effect is one nobody can run twice. The alert belongs to the surface that
    // is watching the queue, not to the artefact somebody hands an assessor.
    const quality = await computeAgentReviewQuality(ctx, {
        windowDays: window.days,
        alert: false,
    });
    const sample = await getSampleAuditDisagreementRate(ctx, { sinceDays: window.days });
    const pendingNow = await runInTenantContext(ctx, (db) =>
        db.agentProposal.count({ where: { tenantId: ctx.tenantId, status: 'PENDING' } }),
    );

    const fastest = quality.reviewers
        .map((r) => r.fastestSeconds)
        .filter((s): s is number => typeof s === 'number');

    return envelope(
        'approval-statistics',
        generatedAt,
        window,
        quality.truncated,
        {
            'approvals.decided': measured(quality.decided),
            'approvals.approved': measured(quality.approved),
            'approvals.rejected': measured(quality.rejected),
            'approvals.approval_rate': ratio(
                quality.approved,
                quality.decided,
                'NO_DECIDED_PROPOSALS',
            ),
            'approvals.fastest_decision_seconds':
                fastest.length === 0
                    ? noPopulation('NO_DECIDED_PROPOSALS')
                    : measured(Math.min(...fastest)),
            'approvals.reviewers': measured(quality.reviewers.length),
            'approvals.reviewers_below_reportable_sample':
                quality.reviewers.length === 0
                    ? noPopulation('NO_DECIDED_PROPOSALS')
                    : measured(quality.reviewers.filter((r) => !r.estimates.reported).length),
            'approvals.bias_signals': measured(quality.signals.length),
            'approvals.pending_now': measured(pendingNow),
            'approvals.sample_audits_answered': measured(sample.answered),
            'approvals.sample_audit_disagreement_rate':
                sample.disagreementRate === null
                    ? notAssessed('NO_ANSWERED_SAMPLE_AUDITS')
                    : measured(sample.disagreementRate),
        },
        {
            reviewers: quality.reviewers,
            agents: quality.agents,
            signals: quality.signals,
            unobservable: quality.unobservable,
            sampleAudit: {
                sampled: sample.sampled,
                answered: sample.answered,
                pending: sample.pending,
                concurred: sample.concurred,
                dissented: sample.dissented,
                indeterminate: sample.indeterminate,
            },
            thresholds: { ...quality.thresholds },
        },
    );
}

// ═══════════════════════════════════════════════════════════════════
// 4 — INCIDENT AND KILL-SWITCH HISTORY
// ═══════════════════════════════════════════════════════════════════

export interface KillHistoryRow {
    id: string;
    /** DERIVED from agentId — never stored, so the two cannot disagree. */
    scope: 'AGENT' | 'TENANT';
    agentId: string | null;
    agentName: string | null;
    reason: string;
    engagedByUserId: string;
    engagedAt: Date;
    liftedAt: Date | null;
    liftedByUserId: string | null;
    /** Minutes engaged. Measured to `generatedAt` while still in force. */
    durationMinutes: number;
    stillInForce: boolean;
}

export interface DrillHistoryRow {
    id: string;
    startedAt: Date;
    completedAt: Date | null;
    outcome: string;
    scopesHonoured: string[];
    scopesFailed: string[];
    toolCallsAfterKill: number;
    boundaryRefusalReason: string | null;
    evidenceId: string | null;
    findingId: string | null;
}

/**
 * The drill outcomes that PRODUCED a measurement, as an allowlist.
 *
 * Written as "which outcomes count" rather than as `!== 'ERROR'` for the reason
 * the identity write-ladder records: a fourth outcome added later inherits
 * nothing by falling through. It would land outside this list and be excluded,
 * which is the fail-closed direction — a drill nobody has classified must not
 * be able to buy the pack's strongest claim before somebody classifies it.
 */
const MEASURING_DRILL_OUTCOMES: readonly string[] = ['PASSED', 'FAILED'];

export interface BreakerTripRow {
    agentId: string;
    agentName: string | null;
    state: string;
    trippedAt: Date | null;
    trippedWindow: string | null;
    trippedSignals: string[];
    closedAt: Date | null;
    closeReason: string | null;
}

export interface IncidentHistoryBody {
    kills: KillHistoryRow[];
    /** Counted apart from real kills — an exercise is not an incident. */
    drillCanaryKills: KillHistoryRow[];
    drills: DrillHistoryRow[];
    breakers: BreakerTripRow[];
}

export async function buildIncidentHistoryReport(
    ctx: RequestContext,
    opts: { windowDays?: number } = {},
): Promise<ReportEnvelope<IncidentHistoryBody>> {
    assertCanRead(ctx);
    const generatedAt = new Date();
    const window = resolveWindow(opts.windowDays);

    const loaded = await runInTenantContext(ctx, async (db) => {
        const [killRows, inForceRows, drillRows, breakerRows, agentRows] = await Promise.all([
            db.agentKillSwitch.findMany({
                where: { tenantId: ctx.tenantId, engagedAt: { gte: window.since } },
                orderBy: { engagedAt: 'desc' },
                take: HISTORY_ROW_CAP,
                select: {
                    id: true, agentId: true, reason: true, engagedByUserId: true,
                    engagedAt: true, liftedAt: true, liftedByUserId: true,
                },
            }),
            // A kill engaged BEFORE the window and still in force is a fact
            // about now, so the snapshot metric cannot be read off the window.
            db.agentKillSwitch.findMany({
                where: { tenantId: ctx.tenantId, liftedAt: null },
                take: HISTORY_ROW_CAP,
                select: { id: true, agentId: true },
            }),
            db.agentKillSwitchDrill.findMany({
                where: { tenantId: ctx.tenantId, startedAt: { gte: window.since } },
                orderBy: { startedAt: 'desc' },
                take: HISTORY_ROW_CAP,
                select: {
                    id: true, startedAt: true, completedAt: true, outcome: true,
                    scopesHonoured: true, scopesFailed: true, toolCallsAfterKill: true,
                    boundaryRefusalReason: true, evidenceId: true, findingId: true,
                },
            }),
            db.agentCircuitBreaker.findMany({
                where: { tenantId: ctx.tenantId },
                take: HISTORY_ROW_CAP,
                select: {
                    agentId: true, state: true, trippedAt: true, trippedWindow: true,
                    trippedSignals: true, closedAt: true, closeReason: true,
                },
            }),
            db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId, deletedAt: null },
                take: AGENT_ROW_CAP,
                select: { id: true, name: true },
            }),
        ]);
        return { killRows, inForceRows, drillRows, breakerRows, agentRows };
    });

    const nameById = new Map(loaded.agentRows.map((a) => [a.id, a.name]));
    const isCanary = (agentId: string | null) => agentId === KILL_SWITCH_DRILL_AGENT_ID;

    const toKillRow = (r: {
        id: string;
        agentId: string | null;
        reason: string;
        engagedByUserId: string;
        engagedAt: Date;
        liftedAt: Date | null;
        liftedByUserId: string | null;
    }): KillHistoryRow => {
        const end = r.liftedAt ?? generatedAt;
        return {
            id: r.id,
            scope: r.agentId === null ? 'TENANT' : 'AGENT',
            agentId: r.agentId,
            agentName: r.agentId === null ? null : nameById.get(r.agentId) ?? null,
            reason: r.reason,
            engagedByUserId: r.engagedByUserId,
            engagedAt: r.engagedAt,
            liftedAt: r.liftedAt,
            liftedByUserId: r.liftedByUserId,
            durationMinutes: Math.max(0, (end.getTime() - r.engagedAt.getTime()) / 60_000),
            stillInForce: r.liftedAt === null,
        };
    };

    const allKills = loaded.killRows.map(toKillRow);
    const kills = allKills.filter((k) => !isCanary(k.agentId));
    const drillCanaryKills = allKills.filter((k) => isCanary(k.agentId));

    const inForceReal = loaded.inForceRows.filter((r) => !isCanary(r.agentId));

    const drills: DrillHistoryRow[] = loaded.drillRows;
    /** The subset a sum may run over — see `incidents.tool_calls_after_kill`. */
    const measuringDrills = drills.filter((d) => MEASURING_DRILL_OUTCOMES.includes(d.outcome));
    const breakers: BreakerTripRow[] = loaded.breakerRows.map((b) => ({
        agentId: b.agentId,
        agentName: nameById.get(b.agentId) ?? null,
        state: b.state,
        trippedAt: b.trippedAt,
        trippedWindow: b.trippedWindow,
        trippedSignals: b.trippedSignals,
        closedAt: b.closedAt,
        closeReason: b.closeReason,
    }));

    const trippedInWindow = breakers.filter(
        (b) => b.trippedAt !== null && b.trippedAt.getTime() >= window.since.getTime(),
    );

    return envelope(
        'incident-history',
        generatedAt,
        window,
        loaded.killRows.length >= HISTORY_ROW_CAP || loaded.drillRows.length >= HISTORY_ROW_CAP,
        {
            'incidents.kill_engagements': measured(kills.length),
            'incidents.drill_canary_engagements': measured(drillCanaryKills.length),
            'incidents.kills_in_force_now': measured(inForceReal.length),
            'incidents.longest_kill_minutes':
                kills.length === 0
                    ? noPopulation('NO_KILLS_ENGAGED')
                    : measured(Math.max(...kills.map((k) => k.durationMinutes))),
            'incidents.drills_run': measured(drills.length),
            'incidents.drills_failed': measured(
                drills.filter((d) => d.outcome === 'FAILED').length,
            ),
            'incidents.drills_errored': measured(
                drills.filter((d) => d.outcome === 'ERROR').length,
            ),
            // THE ONE THAT MUST NOT BE ZERO, and the guard on it was one step
            // too shallow for its whole life.
            //
            // `drills.length === 0` catches the tenant that never drilled. It
            // does NOT catch the tenant whose drill ERRORED, because that is a
            // row: the denominator is not empty, so the sum ran — over a
            // `toolCallsAfterKill` still sitting at its schema `@default(0)`,
            // which an errored run never overwrites. So a drill the schema
            // itself describes as having "proved nothing" rendered byte-for-byte
            // what a PASSED drill earns: MEASURED 0, the strongest claim in the
            // pack. The population that matters is not "drills", it is "drills
            // that measured something", and the two are only equal when nothing
            // went wrong — which is precisely the case this metric exists for.
            //
            // Three outcomes, three renderings, because they demand three
            // different actions: never drilled → go drill; drilled and every
            // drill broke → fix the harness, the control is still unproven;
            // drilled and measured → the number.
            'incidents.tool_calls_after_kill':
                drills.length === 0
                    ? noPopulation('NO_DRILLS_RUN')
                    : measuringDrills.length === 0
                      ? notAssessed('ALL_DRILLS_ERRORED')
                      : measured(
                            measuringDrills.reduce((sum, d) => sum + d.toolCallsAfterKill, 0),
                        ),
            'incidents.breaker_trips': measured(trippedInWindow.length),
            'incidents.breakers_open_now': measured(
                breakers.filter((b) => b.state === 'OPEN').length,
            ),
        },
        { kills, drillCanaryKills, drills, breakers },
    );
}

// ═══════════════════════════════════════════════════════════════════
// 5 — THIRD-PARTY AGENT ASSESSMENTS
// ═══════════════════════════════════════════════════════════════════

/** Terminal, reviewed assessment states. Started is not finished. */
const COMPLETED_ASSESSMENT_STATUSES = ['APPROVED', 'REVIEWED', 'CLOSED'] as const;

export interface ThirdPartyAgentRow {
    agentId: string;
    name: string;
    status: string;
    autonomyLevel: number;
    riskTier: string | null;
    vendorId: string | null;
    vendorName: string | null;
    /**
     * TRUE when the agent names a vendor the register cannot resolve — a
     * soft-deleted supplier, or one removed out from under the agent. The
     * schema's CHECK guarantees a NAMED vendor, never a resolvable one.
     */
    vendorUnresolved: boolean;
    vendorStatus: string | null;
    /** The most recent terminal reviewed assessment, or null. */
    latestCompletedAssessment: {
        id: string;
        status: string;
        decidedAt: Date | null;
        riskRating: string | null;
    } | null;
    /** Assessments started but not finished — visible, never counted as assurance. */
    openAssessments: number;
}

export interface ThirdPartyBody {
    agents: ThirdPartyAgentRow[];
    /** Per-tool pin state — 7/10's provenance chain, per supplier-served tool. */
    toolManifests: {
        toolName: string;
        status: string;
        approvalSource: string | null;
        approvedByUserId: string | null;
        approvedAt: Date | null;
        revision: number | null;
        blocked: boolean;
    }[];
}

export async function buildThirdPartyAssessmentReport(
    ctx: RequestContext,
): Promise<ReportEnvelope<ThirdPartyBody>> {
    assertCanRead(ctx);
    const generatedAt = new Date();

    const { agents, truncated } = await loadAgents(ctx);
    const thirdParty = agents.filter((a) => a.provenance === 'THIRD_PARTY');
    const vendorIds = [
        ...new Set(thirdParty.map((a) => a.vendorId).filter((v): v is string => v !== null)),
    ];

    interface AssessmentRow {
        id: string;
        vendorId: string;
        status: string;
        decidedAt: Date | null;
        riskRating: string | null;
    }

    const assessments: AssessmentRow[] = await runInTenantContext(ctx, async (db) => {
        if (vendorIds.length === 0) return [];
        const rows = await db.vendorAssessment.findMany({
            where: { tenantId: ctx.tenantId, vendorId: { in: vendorIds } },
            orderBy: [{ decidedAt: 'desc' }, { startedAt: 'desc' }],
            take: HISTORY_ROW_CAP,
            select: {
                id: true, vendorId: true, status: true,
                decidedAt: true, riskRating: true,
            },
        });
        return rows.map((r) => ({
            id: r.id,
            vendorId: r.vendorId,
            status: String(r.status),
            decidedAt: r.decidedAt,
            riskRating: r.riskRating === null ? null : String(r.riskRating),
        }));
    });

    const completedByVendor = new Map<string, AssessmentRow>();
    const openCountByVendor = new Map<string, number>();
    for (const a of assessments) {
        const isCompleted = (COMPLETED_ASSESSMENT_STATUSES as readonly string[]).includes(a.status);
        if (isCompleted) {
            if (!completedByVendor.has(a.vendorId)) completedByVendor.set(a.vendorId, a);
        } else {
            openCountByVendor.set(a.vendorId, (openCountByVendor.get(a.vendorId) ?? 0) + 1);
        }
    }

    const rows: ThirdPartyAgentRow[] = thirdParty.map((a) => {
        const completed = a.vendorId === null ? undefined : completedByVendor.get(a.vendorId);
        return {
            agentId: a.id,
            name: a.name,
            status: a.status,
            autonomyLevel: a.autonomyLevel,
            riskTier: a.riskTier,
            vendorId: a.vendorId,
            vendorName: a.vendorName,
            vendorUnresolved: a.vendorId !== null && a.vendorName === null,
            vendorStatus: a.vendorStatus,
            latestCompletedAssessment: completed
                ? {
                      id: completed.id,
                      status: completed.status,
                      decidedAt: completed.decidedAt,
                      riskRating: completed.riskRating,
                  }
                : null,
            openAssessments: a.vendorId === null ? 0 : openCountByVendor.get(a.vendorId) ?? 0,
        };
    });

    const manifests = await listToolManifests(ctx);
    const pinned = manifests.filter((m) => m.approvalSource !== null);

    const vendorsWithoutAssurance = vendorIds.filter((v) => !completedByVendor.has(v));

    return envelope(
        'third-party-assessments',
        generatedAt,
        null,
        truncated,
        {
            'thirdparty.agents': measured(thirdParty.length),
            'thirdparty.supplying_vendors':
                thirdParty.length === 0
                    ? noPopulation('NO_AGENTS_IN_SCOPE')
                    : measured(vendorIds.length),
            'thirdparty.vendors_without_completed_assessment':
                vendorIds.length === 0
                    ? noPopulation('NO_SUPPLYING_VENDORS')
                    : measured(vendorsWithoutAssurance.length),
            'thirdparty.tools_pinned': measured(pinned.length),
            'thirdparty.tools_human_approved': measured(
                pinned.filter((m) => m.approvalSource === 'APPROVED').length,
            ),
            // Named, never approximated. See the definition for why every
            // available proxy would be a claim about the supplier made out of
            // our own logs.
            'thirdparty.supplier_side_agent_changes': notObservable('OUTSIDE_PLATFORM_BOUNDARY'),
        },
        {
            agents: rows,
            toolManifests: manifests.map((m) => ({
                toolName: m.toolName,
                status: String(m.status),
                approvalSource: m.approvalSource,
                approvedByUserId: m.approvedByUserId,
                approvedAt: m.approvedAt,
                revision: m.revision,
                blocked: m.blocked,
            })),
        },
    );
}

// ═══════════════════════════════════════════════════════════════════
// The pack
// ═══════════════════════════════════════════════════════════════════

export interface AgentGovernancePack {
    generatedAt: Date;
    tenantId: string;
    inventory: ReportEnvelope<AgentInventoryBody>;
    asiCoverage: ReportEnvelope<AsiCoverageBody>;
    approvals: ReportEnvelope<ApprovalStatisticsBody>;
    incidents: ReportEnvelope<IncidentHistoryBody>;
    thirdParty: ReportEnvelope<ThirdPartyBody>;
}

/**
 * All five, as one artefact. Sequential rather than `Promise.all`: each report
 * opens its own tenant transaction, and five concurrent ones per assessor click
 * is a pool exhaustion nobody asked for on a read that runs once a quarter.
 */
export async function buildAgentGovernancePack(
    ctx: RequestContext,
    opts: { windowDays?: number } = {},
): Promise<AgentGovernancePack> {
    assertCanRead(ctx);
    // Validate before any query, so a bad window is a 400 rather than a 400
    // that arrives after four reports have already been computed.
    resolveWindow(opts.windowDays);

    const inventory = await buildAgentInventoryReport(ctx);
    const asiCoverage = await buildAsiCoverageReport(ctx);
    const approvals = await buildApprovalStatisticsReport(ctx, opts);
    const incidents = await buildIncidentHistoryReport(ctx, opts);
    const thirdParty = await buildThirdPartyAssessmentReport(ctx);

    return {
        generatedAt: inventory.generatedAt,
        tenantId: ctx.tenantId,
        inventory,
        asiCoverage,
        approvals,
        incidents,
        thirdParty,
    };
}

// ═══════════════════════════════════════════════════════════════════
// The shared agent load
// ═══════════════════════════════════════════════════════════════════

interface LoadedAgent {
    id: string;
    name: string;
    status: string;
    autonomyLevel: number;
    dataAccessScope: string;
    reversibility: string;
    provenance: string;
    ownerUserId: string;
    ownerName: string | null;
    vendorId: string | null;
    vendorName: string | null;
    vendorStatus: string | null;
    riskTier: string | null;
    riskTierScoredAt: Date | null;
    assessmentState: 'NEVER_ASSESSED' | 'ASSESSED' | 'ASSESSED_STALE';
    staleTriggers: string[];
    grantedToolCount: number;
    credentialCount: number;
    policyCardVersion: number | null;
    killState: 'RUNNING' | 'KILLED_BY_AGENT_SCOPE' | 'KILLED_BY_TENANT_SCOPE';
    breakerState: string | null;
}

interface VendorRow {
    id: string;
    name: string;
    status: string;
    deletedAt: Date | null;
}

/** Suppliers named by the loaded agents. Empty in, empty out — no query. */
async function loadVendors(
    db: PrismaTx,
    tenantId: string,
    vendorIds: readonly string[],
): Promise<VendorRow[]> {
    if (vendorIds.length === 0) return [];
    const rows = await db.vendor.findMany({
        where: { tenantId, id: { in: [...vendorIds] } },
        take: AGENT_ROW_CAP,
        select: { id: true, name: true, status: true, deletedAt: true },
    });
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: String(r.status),
        deletedAt: r.deletedAt,
    }));
}

/**
 * The register plus every per-agent fact the pack reports, in ONE transaction
 * and with no read inside a loop.
 *
 * The legacy placeholder is filtered OUT here rather than at each call site, so
 * "registered agents" means the same population in the inventory report and the
 * third-party one. Whether the register carries one is reported separately.
 */
async function loadAgents(ctx: RequestContext): Promise<{
    agents: LoadedAgent[];
    truncated: boolean;
    legacyPlaceholderPresent: boolean;
}> {
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.registeredAgent.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: [{ createdAt: 'desc' }],
            take: AGENT_ROW_CAP,
            select: {
                id: true, name: true, status: true, autonomyLevel: true,
                dataAccessScope: true, reversibility: true, provenance: true,
                ownerUserId: true, vendorId: true, riskTier: true,
                riskTierScoredAt: true, isLegacyPlaceholder: true,
                owner: { select: { name: true } },
                _count: { select: { apiKeys: true } },
            },
        });

        const real = rows.filter((r) => !r.isLegacyPlaceholder);
        const vendorIds = [
            ...new Set(real.map((r) => r.vendorId).filter((v): v is string => v !== null)),
        ];

        const [cards, toolCounts, assessments, kills, breakers, vendors] = await Promise.all([
            db.agentPolicyCard.findMany({
                where: { tenantId: ctx.tenantId },
                take: AGENT_ROW_CAP,
                select: { agentId: true, currentVersion: true },
            }),
            db.registeredAgentTool.groupBy({
                by: ['agentId'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            // Newest-completed first, so the first row seen per agent is the
            // judgement in force. `staleAt` on THAT row is what makes an agent
            // stale — an older run going stale says nothing about the current tier.
            db.agentRiskAssessment.findMany({
                where: { tenantId: ctx.tenantId, status: 'COMPLETED' },
                orderBy: [{ completedAt: 'desc' }],
                take: AGENT_ROW_CAP,
                select: { agentId: true, staleAt: true, staleTriggers: true },
            }),
            db.agentKillSwitch.findMany({
                where: { tenantId: ctx.tenantId, liftedAt: null },
                take: HISTORY_ROW_CAP,
                select: { agentId: true },
            }),
            db.agentCircuitBreaker.findMany({
                where: { tenantId: ctx.tenantId },
                take: AGENT_ROW_CAP,
                select: { agentId: true, state: true },
            }),
            loadVendors(db, ctx.tenantId, vendorIds),
        ]);

        const cardVersion = new Map(cards.map((c) => [c.agentId, c.currentVersion]));
        const toolCount = new Map(toolCounts.map((t) => [t.agentId, t._count._all]));
        const latestAssessment = new Map<string, { staleAt: Date | null; staleTriggers: string[] }>();
        for (const a of assessments) {
            if (!latestAssessment.has(a.agentId)) {
                latestAssessment.set(a.agentId, { staleAt: a.staleAt, staleTriggers: a.staleTriggers });
            }
        }
        const tenantWideKill = kills.some((k) => k.agentId === null);
        const killedAgentIds = new Set(
            kills.map((k) => k.agentId).filter((id): id is string => id !== null),
        );
        const breakerState = new Map(breakers.map((b) => [b.agentId, b.state]));
        const vendorById = new Map(
            vendors
                .filter((v) => v.deletedAt === null)
                .map((v) => [v.id, { name: v.name, status: v.status }]),
        );

        const agents: LoadedAgent[] = real.map((r) => {
            const assessment = latestAssessment.get(r.id);
            const vendor = r.vendorId === null ? undefined : vendorById.get(r.vendorId);
            return {
                id: r.id,
                name: r.name,
                status: String(r.status),
                autonomyLevel: r.autonomyLevel,
                dataAccessScope: String(r.dataAccessScope),
                reversibility: String(r.reversibility),
                provenance: String(r.provenance),
                ownerUserId: r.ownerUserId,
                ownerName: r.owner?.name ?? null,
                vendorId: r.vendorId,
                vendorName: vendor?.name ?? null,
                vendorStatus: vendor?.status ?? null,
                riskTier: r.riskTier === null ? null : String(r.riskTier),
                riskTierScoredAt: r.riskTierScoredAt,
                assessmentState: assessment === undefined
                    ? 'NEVER_ASSESSED'
                    : assessment.staleAt === null
                      ? 'ASSESSED'
                      : 'ASSESSED_STALE',
                staleTriggers: assessment?.staleTriggers ?? [],
                grantedToolCount: toolCount.get(r.id) ?? 0,
                credentialCount: r._count.apiKeys,
                policyCardVersion: cardVersion.get(r.id) ?? null,
                killState: tenantWideKill
                    ? 'KILLED_BY_TENANT_SCOPE'
                    : killedAgentIds.has(r.id)
                      ? 'KILLED_BY_AGENT_SCOPE'
                      : 'RUNNING',
                breakerState: breakerState.get(r.id) ?? null,
            };
        });

        return {
            agents,
            truncated: rows.length >= AGENT_ROW_CAP,
            legacyPlaceholderPresent: rows.length !== real.length,
        };
    });
}
