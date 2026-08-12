/**
 * Audit Readiness Scoring & Exports
 *
 * Framework-aware readiness scoring with documented weights:
 *
 * ISO27001:2022 weights:
 *   - Coverage (requirements mapped to APPLIES controls): 35%
 *   - Implementation (APPLIES controls IMPLEMENTED): 25%
 *   - Evidence (APPLIES controls with >=1 evidence): 25%
 *   - Task completion (penalty for overdue tasks): 10%
 *   - Issues (penalty for open CONTROL_GAP/AUDIT_FINDING): 5%
 *
 * NIS2 Directive weights:
 *   - Coverage (NIS2 requirements mapped to controls): 40%
 *   - Evidence (mapped controls with >=1 evidence): 30%
 *   - Policies (in-scope controls with a linked governing policy): 15%
 *   - Issues (penalty for open incidents/issues): 15%
 *
 * RETENTION HARDENING: Evidence queries route through the shared
 * `coverageQualifyingEvidenceWhere` predicate — only APPROVED, not
 * archived, not soft-deleted, and unexpired evidence counts toward a
 * readiness score. Approval is load-bearing: a DRAFT / SUBMITTED /
 * expired row no longer satisfies a control's evidence dimension.
 */
import { type AuditCycle, type Applicability, type TaskStatus } from '@prisma/client';
import { RequestContext } from '../../types';
import { assertCanViewPack } from '../../policies/audit-readiness.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';
import { NIS2_SOURCE_KIND } from '../nis2-readiness';
import { coverageQualifyingEvidenceWhere } from '@/lib/compliance/coverage-evidence';
import { readinessBand } from '@/lib/readiness/bands';

/**
 * The engine that produces the score owns the bands that read it. The numbers
 * themselves live in the dependency-free `@/lib/readiness/bands` so client
 * components can import them without pulling Prisma into the browser bundle;
 * this re-export is how server callers reach them, and is the reason a
 * renderer never needs to know what 80 and 50 are.
 */
export {
    readinessBand,
    readinessVariant,
    readinessTone,
    READINESS_BAND_MIN,
    READINESS_BAND_VARIANT,
    READINESS_BAND_TONE,
    READINESS_BAND_COLOR_VAR,
    type ReadinessBand,
} from '@/lib/readiness/bands';


// ─── Types ───

export interface ReadinessBreakdown {
    coverage: { score: number; weight: number; mapped: number; total: number };
    implementation?: { score: number; weight: number; implemented: number; total: number };
    evidence: { score: number; weight: number; withEvidence: number; total: number };
    policies?: { score: number; weight: number; withPolicy: number; total: number };
    tasks?: { score: number; weight: number; overdue: number };
    issues: { score: number; weight: number; open: number };
}

export interface ReadinessGap {
    type: 'UNMAPPED_REQUIREMENT' | 'MISSING_EVIDENCE' | 'OVERDUE_TASK' | 'OPEN_ISSUE' | 'MISSING_POLICY';
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    details: string;
    entityId?: string;
}

export interface ReadinessResult {
    frameworkKey: string;
    score: number;
    breakdown: ReadinessBreakdown;
    gaps: ReadinessGap[];
    recommendations: string[];
    computedAt: string;
}

// ─── ISO27001 Weights ───
const ISO_WEIGHTS = { coverage: 0.35, implementation: 0.25, evidence: 0.25, tasks: 0.10, issues: 0.05 };

// ─── NIS2 Weights ───
const NIS2_WEIGHTS = { coverage: 0.40, evidence: 0.30, policies: 0.15, issues: 0.15 };

// ─── Compute Readiness ───

/**
 * Audit Coherence S5 (2026-05-22) — load the effective weights for
 * a framework. Per-tenant override via `Tenant.readinessWeightsJson`
 * takes precedence over the hardcoded defaults; the override is
 * validated (sum ≈ 1.0, each value in [0, 1]) before use.
 */
async function loadEffectiveWeights<T extends Record<string, number>>(
    ctx: RequestContext,
    frameworkKey: string,
    defaults: T,
): Promise<T> {
    const override = await runInTenantContext(ctx, (tdb) =>
        tdb.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { readinessWeightsJson: true },
        }));
    const json = override?.readinessWeightsJson;
    if (!json || typeof json !== 'object') return defaults;
    const candidate = (json as Record<string, unknown>)[frameworkKey];
    if (!candidate || typeof candidate !== 'object') return defaults;
    // Validate: every key in defaults must appear in candidate, every
    // value in [0,1], and the sum within tolerance of 1.0.
    const merged = { ...defaults };
    let sum = 0;
    for (const k of Object.keys(defaults)) {
        const v = (candidate as Record<string, unknown>)[k];
        if (typeof v !== 'number' || v < 0 || v > 1) return defaults;
        (merged as Record<string, number>)[k] = v;
        sum += v;
    }
    if (Math.abs(sum - 1.0) > 0.001) return defaults;
    return merged;
}

/**
 * The single canonical NIS2 cycle that folds in the tenant-wide NIS2
 * self-assessment findings — the oldest NIS2 cycle (by createdAt).
 *
 * NIS2 self-assessment is a TENANT-WIDE questionnaire (`Nis2SelfAssessment`
 * is keyed by tenantId only, not per-cycle), and its gap findings
 * materialise with `auditId: null` + `sourceKind = NIS2_SELF_ASSESSMENT`
 * and NO cycle reference. A tenant can nonetheless create multiple NIS2
 * audit cycles. If every NIS2 cycle counted the tenant-wide self-assessment
 * findings, the same gaps would double-penalize each cycle identically.
 * We therefore attribute the self-assessment to exactly ONE canonical cycle
 * (the oldest NIS2 cycle) — only one NIS2 cycle folds the self-assessment.
 * Returns null when the tenant has no NIS2 cycle.
 */
async function getCanonicalNis2CycleId(ctx: RequestContext): Promise<string | null> {
    return runInTenantContext(ctx, async (tdb) => {
        const c = await tdb.auditCycle.findFirst({
            where: { tenantId: ctx.tenantId, frameworkKey: 'NIS2' },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
        });
        return c?.id ?? null;
    });
}

/**
 * feat/audit-cycle-unify — count OPEN `Finding` rows raised on a
 * fieldwork audit that belongs to this cycle (Audit.auditCycleId =
 * cycleId, now linkable via the Part-1 FK), PLUS — for the canonical NIS2
 * cycle only — the tenant-wide NIS2 self-assessment gap findings. "Open" =
 * any status that is not CLOSED. Folded into the issue count of every
 * scoring profile so a real, unresolved finding lowers the cycle's
 * readiness — not just the legacy Task-based CONTROL_GAP/AUDIT_FINDING proxy.
 *
 * Bounded (a single `count` plus one canonical-cycle lookup, no row
 * materialisation, no N+1).
 */
async function countOpenCycleFindings(ctx: RequestContext, cycleId: string, frameworkKey: string): Promise<number> {
    // Fold the tenant-wide NIS2 self-assessment findings into the canonical
    // NIS2 cycle ONLY, so two NIS2 cycles never double-count the same gaps.
    const foldNis2SelfAssessment =
        frameworkKey === 'NIS2' && cycleId === (await getCanonicalNis2CycleId(ctx));
    return runInTenantContext(ctx, (tdb) =>
        tdb.finding.count({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                status: { not: 'CLOSED' },
                OR: [
                    // Fieldwork findings reach the cycle via their audit.
                    { audit: { auditCycleId: cycleId } },
                    // NIS2 self-assessment gap-findings are materialised with NO
                    // fieldwork audit (auditId = null), so the audit-join above
                    // never sees them. They are tenant-wide, so they count once —
                    // against the canonical NIS2 cycle only (see helper above).
                    ...(foldNis2SelfAssessment
                        ? [{ auditId: null, sourceKind: NIS2_SOURCE_KIND }]
                        : []),
                ],
            },
        }),
    );
}

/**
 * Compute a cycle's readiness score WITHOUT persisting a snapshot or
 * logging an event. This is the read path — the list/overview/export/pack
 * surfaces call it (often fanned over every cycle), so it must be free of
 * write side-effects: otherwise the readiness trend fills with
 * near-identical snapshots on every incidental recompute and the "N scored
 * snapshots" count is inflated. Persist only via `computeReadiness`.
 */
export async function scoreReadiness(ctx: RequestContext, cycleId: string): Promise<ReadinessResult> {
    assertCanViewPack(ctx);

    const cycle = await runInTenantContext(ctx, (tdb) =>
        tdb.auditCycle.findFirst({ where: { id: cycleId, tenantId: ctx.tenantId } }));
    if (!cycle) throw notFound('Audit cycle not found');

    if (cycle.frameworkKey === 'ISO27001') {
        return computeISO27001Readiness(ctx, cycle);
    } else if (cycle.frameworkKey === 'NIS2') {
        return computeNIS2Readiness(ctx, cycle);
    }
    // Audit S5 — generic fallback for custom frameworks. Coverage
    // + evidence + issues only (no implementation/policy specifics).
    return computeGenericReadiness(ctx, cycle);
}

/**
 * Compute a cycle's readiness AND record it — the DELIBERATE-scoring path
 * (the single-cycle readiness route). Persists a time-series snapshot +
 * logs `READINESS_COMPUTED`, but DEDUPES: if the cycle's most recent
 * snapshot already carries this score, the write + event are skipped, so
 * the trend records real readiness movement rather than every recompute.
 * Best-effort — a persistence failure never surfaces to the caller.
 */
export async function computeReadiness(ctx: RequestContext, cycleId: string): Promise<ReadinessResult> {
    const result = await scoreReadiness(ctx, cycleId);

    try {
        const persisted = await runInTenantContext(ctx, async (tdb) => {
            // Dedup: skip if the latest snapshot for this cycle+framework
            // already holds this score (no real movement to record).
            const latest = await tdb.readinessSnapshot.findFirst({
                where: {
                    tenantId: ctx.tenantId,
                    frameworkKey: result.frameworkKey,
                    auditCycleId: cycleId,
                },
                orderBy: { computedAt: 'desc' },
                select: { score: true },
            });
            if (latest && latest.score === result.score) return false;
            await tdb.readinessSnapshot.create({
                data: {
                    tenantId: ctx.tenantId,
                    frameworkKey: result.frameworkKey,
                    auditCycleId: cycleId,
                    score: result.score,
                    gapCount: result.gaps.length,
                    computedByUserId: ctx.userId,
                },
            });
            return true;
        });

        // Log the scoring event only when a snapshot was actually recorded,
        // so read-driven recomputes don't amplify the audit log either.
        if (persisted) {
            await runInTenantContext(ctx, (tdb) =>
                logEvent(tdb, ctx, {
                    action: 'READINESS_COMPUTED',
                    entityType: 'AuditCycle',
                    entityId: cycleId,
                    details: JSON.stringify({ score: result.score, frameworkKey: result.frameworkKey }),
                    detailsJson: {
                        category: 'custom',
                        event: 'readiness_computed',
                        score: result.score,
                        frameworkKey: result.frameworkKey,
                        gapCount: result.gaps.length,
                    },
                }),
            );
        }
    } catch (_err) {
        // Snapshot + event are observational — a write failure must not
        // surface to the caller; the computed result still returns.
    }

    return result;
}

/**
 * Audit Coherence S5 (2026-05-22) — read the readiness snapshot
 * history for the dashboard's trend chart.
 *
 * Returns the most-recent N snapshots for the framework in
 * descending `computedAt` order; the chart reverses to ascending
 * for rendering.
 */
export interface ReadinessSnapshotRow {
    id: string;
    score: number;
    gapCount: number;
    computedAt: Date;
    auditCycleId: string | null;
}

export async function getReadinessHistory(
    ctx: RequestContext,
    frameworkKey: string,
    opts: { take?: number; cycleId?: string } = {},
): Promise<ReadinessSnapshotRow[]> {
    assertCanViewPack(ctx);
    const take = Math.min(Math.max(1, opts.take ?? 30), 200);

    return runInTenantContext(ctx, (tdb) =>
        tdb.readinessSnapshot.findMany({
            where: {
                tenantId: ctx.tenantId,
                frameworkKey,
                ...(opts.cycleId ? { auditCycleId: opts.cycleId } : {}),
            },
            select: {
                id: true,
                score: true,
                gapCount: true,
                computedAt: true,
                auditCycleId: true,
            },
            orderBy: { computedAt: 'desc' },
            take,
        }),
    );
}

// ─── Generic / Custom-Framework Scoring ───
//
// Audit Coherence S5 (2026-05-22) — fallback model for any
// framework key without a hardcoded scoring profile. Uses three
// dimensions only: coverage (% requirements mapped to APPLIES
// controls), evidence (% mapped controls with ≥1 evidence), and
// issues (penalty for open CONTROL_GAP / AUDIT_FINDING). Per-tenant
// `GENERIC` weight override is honoured.

const GENERIC_WEIGHTS = { coverage: 0.5, evidence: 0.35, issues: 0.15 };

async function computeGenericReadiness(
    ctx: RequestContext,
    cycle: AuditCycle,
): Promise<ReadinessResult> {
    const gaps: ReadinessGap[] = [];
    const weights = await loadEffectiveWeights(ctx, 'GENERIC', GENERIC_WEIGHTS);

    // 1) Coverage — requirements mapped to APPLIES controls.
    const fw = await runInTenantContext(ctx, (tdb) =>
        tdb.framework.findFirst({ where: { key: cycle.frameworkKey } }),
    );
    let totalReqs = 0;
    let mappedReqs = 0;
    if (fw) {
        const reqs = await runInTenantContext(ctx, (tdb) =>
            tdb.frameworkRequirement.findMany({
                where: { frameworkId: fw.id, deprecatedAt: null },
                select: { id: true, code: true, title: true },
            }),
        );
        totalReqs = reqs.length;
        const reqIds = reqs.map((r) => r.id);
        const mappings = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    requirementId: { in: reqIds },
                    control: { applicability: 'APPLIES' as Applicability },
                },
                select: { requirementId: true },
            }),
        );
        mappedReqs = new Set(mappings.map((m) => m.requirementId)).size;
    }
    const coverageScore = totalReqs > 0 ? Math.round((mappedReqs / totalReqs) * 100) : 0;

    // 2) Evidence — mapped controls with ≥1 active evidence.
    const mappedControls = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: {
                tenantId: ctx.tenantId,
                applicability: 'APPLIES' as Applicability,
                deletedAt: null,
                requirementLinks: { some: { requirement: { frameworkId: fw?.id ?? '' } } },
            },
            select: { id: true },
        }),
    );
    let withEvidence = 0;
    if (mappedControls.length > 0) {
        const ids = mappedControls.map((c) => c.id);
        const now = new Date();
        const ev = await runInTenantContext(ctx, (tdb) =>
            tdb.evidenceControlLink.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    controlId: { in: ids },
                    evidence: coverageQualifyingEvidenceWhere(now),
                },
                select: { controlId: true },
            }),
        );
        withEvidence = new Set(ev.map((e) => e.controlId)).size;
    }
    const evidenceScore =
        mappedControls.length > 0
            ? Math.round((withEvidence / mappedControls.length) * 100)
            : 0;

    // 3) Issues — penalty for open CONTROL_GAP / AUDIT_FINDING.
    const openIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.count({
            where: {
                tenantId: ctx.tenantId,
                type: { in: ['CONTROL_GAP', 'AUDIT_FINDING'] },
                status: {
                    notIn: TERMINAL_WORK_ITEM_STATUSES as readonly TaskStatus[] as TaskStatus[],
                },
                deletedAt: null,
            },
        }),
    );
    // feat/audit-cycle-unify — add real open findings on the cycle's
    // audits to the open-issue penalty.
    const openFindingCount = await countOpenCycleFindings(ctx, cycle.id, cycle.frameworkKey);
    const totalOpenIssues = openIssues + openFindingCount;
    const issuesScore = Math.max(0, 100 - totalOpenIssues * 5);

    const finalScore = Math.round(
        coverageScore * weights.coverage +
            evidenceScore * weights.evidence +
            issuesScore * weights.issues,
    );

    const result: ReadinessResult = {
        frameworkKey: cycle.frameworkKey,
        score: finalScore,
        breakdown: {
            coverage: { score: coverageScore, weight: weights.coverage, mapped: mappedReqs, total: totalReqs },
            evidence: { score: evidenceScore, weight: weights.evidence, withEvidence, total: mappedControls.length },
            issues: { score: issuesScore, weight: weights.issues, open: totalOpenIssues },
        },
        gaps,
        recommendations: [
            `Custom framework "${cycle.frameworkKey}" — using the generic 3-dimension scoring model (coverage / evidence / issues). For framework-specific weights or dimensions, set tenant.readinessWeightsJson["${cycle.frameworkKey}"] or add a dedicated scoring profile.`,
        ],
        computedAt: new Date().toISOString(),
    };
    return result;
}

// ─── ISO27001 Scoring ───

async function computeISO27001Readiness(ctx: RequestContext, cycle: AuditCycle): Promise<ReadinessResult> {
    const gaps: ReadinessGap[] = [];

    // Audit S7 — route through the per-tenant weight override seam.
    // Pre-S7 this function read `ISO_WEIGHTS` directly, so the
    // helper added during Audit S5 only applied to GENERIC frameworks
    // — the Tenant.readinessWeightsJson override was silently
    // ignored for ISO27001 + NIS2. Wiring the load through the
    // helper means the operator-facing override surface (which
    // already accepts framework-keyed weights) finally applies
    // uniformly.
    const weights = await loadEffectiveWeights(ctx, 'ISO27001', ISO_WEIGHTS);

    // 1) Requirement coverage
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: 'ISO27001' } }));
    let totalReqs = 0;
    let mappedReqs = 0;
    interface RequirementSummary { id: string; code: string; title: string }
    let unmappedReqs: RequirementSummary[] = [];

    if (fw) {
        const reqs = await runInTenantContext(ctx, (tdb) => tdb.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            select: { id: true, code: true, title: true },
        }));
        totalReqs = reqs.length;

        const mappedReqIds = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { requirementId: true },
            }));
        const mappedSet = new Set(mappedReqIds.map((l) => l.requirementId));
        mappedReqs = mappedSet.size;
        unmappedReqs = reqs.filter((r) => !mappedSet.has(r.id));
    }

    const coverageScore = totalReqs > 0 ? (mappedReqs / totalReqs) * 100 : 0;

    // Add unmapped requirement gaps (top 10)
    unmappedReqs.slice(0, 10).forEach((r) => gaps.push({
        type: 'UNMAPPED_REQUIREMENT', severity: 'HIGH',
        title: `${r.code}: ${r.title}`, details: 'Not mapped to any control', entityId: r.id,
    }));

    // 2) Controls implementation
    const controls = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, applicability: 'APPLICABLE' },
            select: { id: true, code: true, name: true, status: true },
        }));
    const totalControls = controls.length;
    const implementedControls = controls.filter((c) => c.status === 'IMPLEMENTED').length;
    const implScore = totalControls > 0 ? (implementedControls / totalControls) * 100 : 0;

    // 3) Evidence completeness — only APPROVED + unexpired evidence counts
    // (routes through the shared coverage predicate, excluding archived,
    // soft-deleted, non-approved, and expired rows).
    const nowIso = new Date();
    const controlsWithEvidence = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, applicability: 'APPLICABLE' },
            select: { id: true, code: true, name: true, evidenceControlLinks: {
                where: { evidence: coverageQualifyingEvidenceWhere(nowIso) },
                select: { id: true },
            } },
        }));
    const withEvidence = controlsWithEvidence.filter((c) => c.evidenceControlLinks?.length > 0).length;
    const evidenceScore = totalControls > 0 ? (withEvidence / totalControls) * 100 : 0;

    // Controls missing evidence (top 10)
    controlsWithEvidence
        .filter((c) => !c.evidenceControlLinks?.length)
        .slice(0, 10)
        .forEach((c) => gaps.push({
            type: 'MISSING_EVIDENCE', severity: 'MEDIUM',
            title: `${c.code}: ${c.name}`, details: 'No active evidence attached (archived/expired excluded)', entityId: c.id,
        }));

    // 4) Overdue tasks
    const overdueTasks = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
                dueAt: { lt: new Date() },
            },
            select: { id: true, title: true, dueAt: true },
            take: 20,
        }));
    const overdueCount = overdueTasks.length;
    const taskScore = Math.max(0, 100 - (overdueCount * 10));

    overdueTasks.slice(0, 5).forEach((t) => gaps.push({
        type: 'OVERDUE_TASK', severity: 'MEDIUM',
        title: t.title, details: `Due: ${t.dueAt?.toISOString().split('T')[0] || 'unknown'}`, entityId: t.id,
    }));

    // 5) Open issues
    const openIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
                type: { in: ['CONTROL_GAP', 'AUDIT_FINDING'] },
            },
            select: { id: true, title: true, severity: true },
            take: 20,
        }));
    // feat/audit-cycle-unify — real open findings on the cycle's audits
    // count as issues alongside the legacy Task-based proxy.
    const openFindingCount = await countOpenCycleFindings(ctx, cycle.id, cycle.frameworkKey);
    const issueCount = openIssues.length + openFindingCount;
    const issueScore = Math.max(0, 100 - (issueCount * 15));

    openIssues.slice(0, 5).forEach((i) => gaps.push({
        type: 'OPEN_ISSUE', severity: i.severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        title: i.title, details: `Severity: ${i.severity}`, entityId: i.id,
    }));
    if (openFindingCount > 0) {
        gaps.push({
            type: 'OPEN_ISSUE', severity: 'MEDIUM',
            title: `${openFindingCount} open audit finding(s)`,
            details: 'Findings raised on this cycle’s audits are still open',
        });
    }

    // Weighted score — Audit S7 reads `weights` instead of the
    // raw `ISO_WEIGHTS` constant so a per-tenant override applies.
    const score = Math.round(
        coverageScore * weights.coverage +
        implScore * weights.implementation +
        evidenceScore * weights.evidence +
        taskScore * weights.tasks +
        issueScore * weights.issues
    );

    return {
        frameworkKey: 'ISO27001',
        score: Math.min(100, Math.max(0, score)),
        breakdown: {
            coverage: { score: Math.round(coverageScore), weight: weights.coverage, mapped: mappedReqs, total: totalReqs },
            implementation: { score: Math.round(implScore), weight: weights.implementation, implemented: implementedControls, total: totalControls },
            evidence: { score: Math.round(evidenceScore), weight: weights.evidence, withEvidence, total: totalControls },
            tasks: { score: Math.round(taskScore), weight: weights.tasks, overdue: overdueCount },
            issues: { score: Math.round(issueScore), weight: weights.issues, open: issueCount },
        },
        gaps,
        recommendations: generateISO27001Recommendations(coverageScore, implScore, evidenceScore, overdueCount, issueCount),
        computedAt: new Date().toISOString(),
    };
}

// ─── NIS2 Scoring ───

async function computeNIS2Readiness(ctx: RequestContext, cycle: AuditCycle): Promise<ReadinessResult> {
    const gaps: ReadinessGap[] = [];

    // Audit S7 — see the matching comment in computeISO27001Readiness
    // for the rationale. The per-tenant override seam now applies to
    // NIS2 as well as ISO27001 and GENERIC.
    const weights = await loadEffectiveWeights(ctx, 'NIS2', NIS2_WEIGHTS);

    // 1) Requirement coverage
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: 'NIS2' } }));
    let totalReqs = 0;
    let mappedReqs = 0;
    interface RequirementSummary { id: string; code: string; title: string }
    let unmappedReqs: RequirementSummary[] = [];

    if (fw) {
        const reqs = await runInTenantContext(ctx, (tdb) => tdb.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            select: { id: true, code: true, title: true },
        }));
        totalReqs = reqs.length;

        const mappedReqIds = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { requirementId: true },
            }));
        const mappedSet = new Set(mappedReqIds.map((l) => l.requirementId));
        mappedReqs = mappedSet.size;
        unmappedReqs = reqs.filter((r) => !mappedSet.has(r.id));
    }

    const coverageScore = totalReqs > 0 ? (mappedReqs / totalReqs) * 100 : 0;

    unmappedReqs.slice(0, 10).forEach((r) => gaps.push({
        type: 'UNMAPPED_REQUIREMENT', severity: 'HIGH',
        title: `${r.code}: ${r.title}`, details: 'Not mapped to any measure', entityId: r.id,
    }));

    // 2) Evidence completeness for mapped controls — EXCLUDES archived/deleted evidence
    let controlIds: string[] = [];
    if (fw) {
        const links = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { controlId: true },
            }));
        controlIds = [...new Set(links.map((l) => l.controlId))];
    }
    if (controlIds.length === 0) {
        const allControls = await runInTenantContext(ctx, (tdb) =>
            tdb.control.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true } }));
        controlIds = allControls.map((c) => c.id);
    }

    const nowNis2 = new Date();
    const controlsWithEv = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, id: { in: controlIds } },
            select: { id: true, code: true, name: true, evidenceControlLinks: {
                where: { evidence: coverageQualifyingEvidenceWhere(nowNis2) },
                select: { id: true },
            },
            // Governing-policy linkage (PolicyControlLink) for the NIS2
            // policy-readiness signal — counted structurally, not by title.
            _count: { select: { policyLinks: true } } },
        }));
    const totalControls = controlsWithEv.length;
    const withEvidence = controlsWithEv.filter((c) => c.evidenceControlLinks?.length > 0).length;
    const evidenceScore = totalControls > 0 ? (withEvidence / totalControls) * 100 : 0;

    controlsWithEv
        .filter((c) => !c.evidenceControlLinks?.length)
        .slice(0, 10)
        .forEach((c) => gaps.push({
            type: 'MISSING_EVIDENCE', severity: 'MEDIUM',
            title: `${c.code}: ${c.name}`, details: 'No active evidence for this control (archived/expired excluded)', entityId: c.id,
        }));

    // 3) Policy governance — a NIS2-scoped control should be backed by a
    // governing policy. Linkage-based (PolicyControlLink), NOT a title-keyword
    // guess: a control counts only if a policy is actually LINKED to it, so
    // the signal reflects operationalised governance rather than a policy that
    // merely happens to have the right word in its title. Mirrors the
    // evidence-completeness shape above (withEvidence/total → withPolicy/total).
    const withPolicy = controlsWithEv.filter((c) => (c._count?.policyLinks ?? 0) > 0).length;
    const policyScore = totalControls > 0 ? (withPolicy / totalControls) * 100 : 0;

    controlsWithEv
        .filter((c) => !c._count?.policyLinks)
        .slice(0, 10)
        .forEach((c) => gaps.push({
            type: 'MISSING_POLICY', severity: 'MEDIUM',
            title: `${c.code}: ${c.name}`, details: 'No governing policy linked to this control', entityId: c.id,
        }));

    // 4) Open issues
    const openIssues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
            },
            select: { id: true, title: true, severity: true, type: true },
            take: 20,
        }));
    // feat/audit-cycle-unify — fold real open findings on this cycle's
    // audits into the issue count.
    const openFindingCount = await countOpenCycleFindings(ctx, cycle.id, cycle.frameworkKey);
    const issueCount = openIssues.length + openFindingCount;
    const issueScore = Math.max(0, 100 - (issueCount * 10));

    openIssues.slice(0, 5).forEach((i) => gaps.push({
        type: 'OPEN_ISSUE', severity: i.severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
        title: i.title, details: `${i.type} · Severity: ${i.severity}`, entityId: i.id,
    }));
    if (openFindingCount > 0) {
        gaps.push({
            type: 'OPEN_ISSUE', severity: 'MEDIUM',
            title: `${openFindingCount} open audit finding(s)`,
            details: 'Findings raised on this cycle’s audits are still open',
        });
    }

    const score = Math.round(
        coverageScore * weights.coverage +
        evidenceScore * weights.evidence +
        policyScore * weights.policies +
        issueScore * weights.issues
    );

    return {
        frameworkKey: 'NIS2',
        score: Math.min(100, Math.max(0, score)),
        breakdown: {
            coverage: { score: Math.round(coverageScore), weight: weights.coverage, mapped: mappedReqs, total: totalReqs },
            evidence: { score: Math.round(evidenceScore), weight: weights.evidence, withEvidence, total: totalControls },
            policies: { score: Math.round(policyScore), weight: weights.policies, withPolicy, total: totalControls },
            issues: { score: Math.round(issueScore), weight: weights.issues, open: issueCount },
        },
        gaps,
        recommendations: generateNIS2Recommendations(coverageScore, evidenceScore, policyScore, issueCount),
        computedAt: new Date().toISOString(),
    };
}

// ─── Recommendations ───
//
// The prose bands are the SAME bands the ring and the badges paint, so they
// go through `readinessBand` rather than re-writing 50 and 80. Before this,
// a dimension could read "amber" on screen while its recommendation was
// worded for the red band — the two were separately-maintained copies of one
// rule.

function generateISO27001Recommendations(coverage: number, impl: number, evidence: number, overdue: number, issues: number): string[] {
    const recs: string[] = [];
    if (readinessBand(coverage) === 'atRisk') recs.push('Map more Annex A requirements to controls — coverage is below 50%');
    else if (readinessBand(coverage) === 'nearly') recs.push('Continue mapping requirements — aim for 80%+ coverage before audit');
    if (impl < 60) recs.push('Focus on implementing controls — many APPLICABLE controls are not yet IMPLEMENTED');
    if (readinessBand(evidence) === 'atRisk') recs.push('Attach evidence to controls — auditors will expect documentation for each control');
    else if (readinessBand(evidence) === 'nearly') recs.push('Strengthen evidence collection — aim for 80%+ controls with evidence');
    if (overdue > 5) recs.push(`Address ${overdue} overdue tasks to improve audit readiness`);
    else if (overdue > 0) recs.push(`Close remaining ${overdue} overdue task(s)`);
    if (issues > 3) recs.push(`Resolve ${issues} open audit findings/control gaps before audit`);
    if (recs.length === 0) recs.push('Readiness is strong — review final pack before scheduling audit');
    return recs;
}

function generateNIS2Recommendations(coverage: number, evidence: number, policies: number, issues: number): string[] {
    const recs: string[] = [];
    if (readinessBand(coverage) === 'atRisk') recs.push('Map NIS2 requirements (Art.21 measures) to controls — coverage below 50%');
    else if (readinessBand(coverage) === 'nearly') recs.push('Continue mapping NIS2 requirements — aim for full Art.21 coverage');
    if (readinessBand(evidence) === 'atRisk') recs.push('Attach evidence to mapped controls — NIS2 requires demonstrable measures');
    if (readinessBand(policies) === 'atRisk') recs.push('Link governing policies to your NIS2 controls — most in-scope controls have no policy attached');
    else if (policies < 100) recs.push('Attach policies to the remaining unlinked NIS2 controls to demonstrate governance');
    if (issues > 3) recs.push(`Address ${issues} open issues to reduce compliance risk`);
    if (recs.length === 0) recs.push('NIS2 readiness is strong — prepare for notification to competent authority');
    return recs;
}

// ─── Export Generators ───

export async function exportReadinessJson(ctx: RequestContext, cycleId: string): Promise<ReadinessResult> {
    const result = await scoreReadiness(ctx, cycleId);
    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ format: 'readiness.json', score: result.score }),
            detailsJson: {
                category: 'custom',
                event: 'audit_export_generated',
                format: 'readiness.json',
                score: result.score,
            },
        })
    );
    return result;
}

export async function exportUnmappedCsv(ctx: RequestContext, cycleId: string): Promise<{ csv: string; filename: string }> {
    const result = await scoreReadiness(ctx, cycleId);
    const unmapped = result.gaps.filter((g) => g.type === 'UNMAPPED_REQUIREMENT');

    const rows = [['Requirement', 'Details', 'Severity']];
    unmapped.forEach((g) => rows.push([g.title, g.details, g.severity]));

    const csv = rows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ format: 'unmapped.csv', count: unmapped.length }),
            detailsJson: {
                category: 'custom',
                event: 'audit_export_generated',
                format: 'unmapped.csv',
                count: unmapped.length,
            },
        })
    );

    return { csv, filename: `${result.frameworkKey}-unmapped-requirements.csv` };
}

export async function exportControlGapsCsv(ctx: RequestContext, cycleId: string): Promise<{ csv: string; filename: string }> {
    const result = await scoreReadiness(ctx, cycleId);
    const gapItems = result.gaps.filter((g) => g.type === 'MISSING_EVIDENCE' || g.type === 'OVERDUE_TASK' || g.type === 'OPEN_ISSUE');

    const rows = [['Type', 'Title', 'Details', 'Severity']];
    gapItems.forEach((g) => rows.push([g.type, g.title, g.details, g.severity]));

    const csv = rows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    await runInTenantContext(ctx, (tdb) =>
        logEvent(tdb, ctx, {
            action: 'AUDIT_EXPORT_GENERATED',
            entityType: 'AuditCycle',
            entityId: cycleId,
            details: JSON.stringify({ format: 'control-gaps.csv', count: gapItems.length }),
            detailsJson: {
                category: 'custom',
                event: 'audit_export_generated',
                format: 'control-gaps.csv',
                count: gapItems.length,
            },
        })
    );

    return { csv, filename: `${result.frameworkKey}-control-gaps.csv` };
}

// ─── Attach readiness to frozen pack ───

export async function addReadinessToPack(ctx: RequestContext, packId: string, cycleId: string) {
    assertCanViewPack(ctx);
    const result = await scoreReadiness(ctx, cycleId);
    // Deferred import: `packs` imports nothing from here, but the barrel does,
    // so a static import would close the cycle. Now a sibling, not '../'.
    const { addAuditPackItems } = await import('./packs');
    return addAuditPackItems(ctx, packId, [{
        entityType: 'READINESS_REPORT',
        entityId: cycleId,
        snapshotJson: JSON.stringify(result),
        sortOrder: 999,
    }]);
}

// ─── Exported weights for tests ───
export { ISO_WEIGHTS, NIS2_WEIGHTS };
