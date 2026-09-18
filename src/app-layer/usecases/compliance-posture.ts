/**
 * Compliance-Posture Summary — usecase orchestration.
 *
 * Gathers an AGGREGATE, tenant-scoped signals snapshot from EXISTING
 * usecases (the executive dashboard + framework coverage), runs it through
 * the configured provider (stub by default, opt-in LLM), guards the output,
 * and upserts the single cached `CompliancePostureSummary` row per tenant.
 *
 * The dashboard hero reads the cached row cheaply via `getLatestPostureSummary`
 * — the LLM is NEVER called on the render path, only here (daily cron) and via
 * the explicit regenerate endpoint.
 *
 * @module app-layer/usecases/compliance-posture
 */
import { Prisma, type CompliancePostureSummary } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { rollUpRequirementVerdict, type RollupControl } from '@/lib/compliance/requirement-status-rollup';
import { assertCanRead } from '../policies/common';
import { getExecutiveDashboard } from './dashboard';
import { listFrameworks } from './framework';
import { getCompliancePostureProvider } from '../ai/compliance-posture/provider';
import { applyPostureOutputGuard } from '../ai/compliance-posture/output-guard';
import { describePayload } from '../ai/compliance-posture/privacy';
import type {
    AdvicePriority,
    FrameworkCoverageSignal,
    PostureAdviceItem,
    PostureLabel,
    PostureSummaryInput,
    PostureSummaryResult,
} from '../ai/compliance-posture/types';
import { POSTURE_LABELS } from '../ai/compliance-posture/types';
import { logger } from '@/lib/observability/logger';

/**
 * Serializable projection of the cached row for the dashboard hero. Keeps the
 * client component free of Prisma types and normalises the JSON columns into
 * typed shapes (a client may `import type` this without pulling server code).
 */
export interface PostureSummaryDto {
    postureLabel: PostureLabel;
    maturityScore: number | null;
    summaryText: string;
    advice: PostureAdviceItem[];
    provider: string;
    model: string | null;
    generatedAt: string;
}

function coerceAdviceJson(value: unknown): PostureAdviceItem[] {
    if (!Array.isArray(value)) return [];
    const out: PostureAdviceItem[] = [];
    for (const item of value) {
        if (item && typeof item === 'object') {
            const r = item as Record<string, unknown>;
            const title = typeof r.title === 'string' ? r.title : '';
            if (!title) continue;
            const priority: AdvicePriority =
                r.priority === 'high' || r.priority === 'low' ? r.priority : 'medium';
            out.push({ title, detail: typeof r.detail === 'string' ? r.detail : '', priority });
        }
    }
    return out;
}

/** Map a cached Prisma row to the serializable hero DTO (or null). */
export function toPostureDto(row: CompliancePostureSummary | null): PostureSummaryDto | null {
    if (!row) return null;
    const label = (POSTURE_LABELS as readonly string[]).includes(row.postureLabel)
        ? (row.postureLabel as PostureLabel)
        : 'DEVELOPING';
    return {
        postureLabel: label,
        maturityScore: row.maturityScore,
        summaryText: row.summaryText,
        advice: coerceAdviceJson(row.adviceJson),
        provider: row.provider,
        model: row.model,
        generatedAt: row.generatedAt.toISOString(),
    };
}

/**
 * Assemble the aggregate signals snapshot for a tenant.
 *
 * Reuses `getExecutiveDashboard` (control coverage, risk severities, evidence
 * freshness, task/policy/vendor/finding counts) and a single per-framework
 * coverage pass. Everything returned is a count/percent — no entity names,
 * free text, or PII.
 */
export async function gatherPostureSignals(ctx: RequestContext): Promise<PostureSummaryInput> {
    assertCanRead(ctx);

    const [exec, frameworks] = await Promise.all([
        getExecutiveDashboard(ctx),
        listFrameworks(ctx),
    ]);

    // Per-framework coverage — one tenant-scoped read of the control ⇄
    // requirement links, then grouped in memory (no per-framework query loop).
    const frameworkById = new Map(
        frameworks.map((f) => [f.id, { key: f.key, name: f.name, total: f._count.requirements }]),
    );

    const now = new Date();
    const links = await runInTenantContext(ctx, (tdb) =>
        tdb.controlRequirementLink.findMany({
            // `deprecatedAt: null` — and this is the THIRD time this exact
            // divergence has been fixed in this codebase. `framework/coverage.ts`
            // records the other two in its own comments: the same field name, the
            // same formula, computed over a LARGER denominator than the reports
            // beside it, because a requirement dropped from a re-imported library
            // stays in the count forever and can never be mapped.
            // `generateReadinessReport` and `getSoA` both exclude it; this did not.
            where: { tenantId: ctx.tenantId, requirement: { deprecatedAt: null } },
            select: {
                requirementId: true,
                // EFFECTIVE applicability is the link override ?? the control's own.
                applicability: true,
                requirement: { select: { frameworkId: true } },
                control: {
                    select: {
                        status: true,
                        applicability: true,
                        // In-force exceptions: APPROVED and not yet expired. Only
                        // `.length > 0` is read, so one row settles it.
                        exceptions: {
                            where: { status: 'APPROVED', expiresAt: { gt: now } },
                            select: { id: true },
                            take: 1,
                        },
                    },
                },
            },
            take: 50000,
        }),
    );

    /**
     * Per framework: which requirements are MAPPED, and which are IMPLEMENTED.
     *
     * These are different questions and the summary used to answer only the
     * first while calling it coverage. Installing a framework pack creates every
     * link at once (`usecases/framework/install.ts`), so mapping reaches 100%
     * before any work is done — which is exactly when an operator most needs to
     * be told the difference.
     *
     * The implemented verdict comes from `rollUpRequirementVerdict`, the ONE
     * canonical rollup, rather than being re-derived here. That is the whole
     * point of that module: the SoA and the readiness report already disagreed
     * once by each having their own.
     */
    const mappedByFramework = new Map<string, Set<string>>();
    const rollupByRequirement = new Map<string, RollupControl[]>();
    for (const link of links) {
        const fwId = link.requirement?.frameworkId;
        if (!fwId) continue;
        let set = mappedByFramework.get(fwId);
        if (!set) {
            set = new Set<string>();
            mappedByFramework.set(fwId, set);
        }
        set.add(link.requirementId);

        const arr = rollupByRequirement.get(link.requirementId) ?? [];
        arr.push({
            status: link.control.status,
            applicability: link.applicability ?? link.control.applicability,
            hasInForceException: (link.control.exceptions ?? []).length > 0,
        });
        rollupByRequirement.set(link.requirementId, arr);
    }

    const frameworkSignals: FrameworkCoverageSignal[] = [];
    for (const [fwId, mappedSet] of mappedByFramework) {
        const meta = frameworkById.get(fwId);
        if (!meta || meta.total === 0) continue;
        const mapped = mappedSet.size;
        let implemented = 0;
        for (const reqId of mappedSet) {
            const { verdict } = rollUpRequirementVerdict(rollupByRequirement.get(reqId) ?? []);
            // 'excepted' is a risk-accepted gap and 'not-applicable' is neither a
            // gap nor an achievement — only 'implemented' counts as done.
            if (verdict === 'implemented') implemented += 1;
        }
        frameworkSignals.push({
            key: meta.key,
            name: meta.name,
            mapped,
            total: meta.total,
            requirementsMappedPercent: Math.round((mapped / meta.total) * 100),
            implemented,
            requirementsImplementedPercent: Math.round((implemented / meta.total) * 100),
        });
    }
    // Least-mapped first — the narrative + advice lead with the gaps. This
    // orders by MAPPING, not by implementation; see FrameworkCoverageSignal.
    frameworkSignals.sort((a, b) => a.requirementsMappedPercent - b.requirementsMappedPercent);

    const sev = exec.riskBySeverity;
    return {
        controls: {
            applicable: exec.controlCoverage.applicable,
            implemented: exec.controlCoverage.implemented,
            inProgress: exec.controlCoverage.inProgress,
            notStarted: exec.controlCoverage.notStarted,
            coveragePercent: exec.controlCoverage.coveragePercent,
        },
        frameworks: frameworkSignals,
        risks: {
            total: sev.critical + sev.high + sev.medium + sev.low,
            critical: sev.critical,
            high: sev.high,
            medium: sev.medium,
            low: sev.low,
        },
        evidence: {
            overdue: exec.evidenceExpiry.overdue,
            dueSoon: exec.evidenceExpiry.dueSoon7d + exec.evidenceExpiry.dueSoon30d,
            current: exec.evidenceExpiry.current,
        },
        findings: { open: exec.stats.openFindings },
        tasks: { open: exec.taskSummary.open, overdue: exec.taskSummary.overdue },
        policies: {
            total: exec.policySummary.total,
            overdueReview: exec.policySummary.overdueReview,
        },
        vendors: { overdueReview: exec.vendorSummary.overdueReview },
        // Org-maturity is an ORG-scoped (not tenant-scoped) signal requiring an
        // OrgContext, so it isn't wired here — the stub derives the score from
        // coverage + hygiene instead. Left null on purpose.
        maturityAverage: null,
    };
}

/**
 * Generate (and cache) the compliance-posture summary for a tenant.
 *
 * gather signals → provider.generate → output-guard → upsert the single
 * per-tenant row. Returns the guarded result.
 */
export async function generateCompliancePostureSummary(
    ctx: RequestContext,
): Promise<PostureSummaryResult> {
    const signals = await gatherPostureSignals(ctx);

    const provider = getCompliancePostureProvider();
    const raw = await provider.generate(signals);
    const result = applyPostureOutputGuard(raw);

    logger.info('compliance-posture summary generated', {
        component: 'compliance-posture',
        tenantId: ctx.tenantId,
        provider: result.provider,
        model: result.model,
        isFallback: result.isFallback ?? false,
        postureLabel: result.postureLabel,
        maturityScore: result.maturityScore,
        payload: describePayload(signals),
    });

    await runInTenantContext(ctx, (tdb) =>
        tdb.compliancePostureSummary.upsert({
            where: { tenantId: ctx.tenantId },
            create: {
                tenantId: ctx.tenantId,
                postureLabel: result.postureLabel,
                maturityScore: result.maturityScore,
                summaryText: result.summaryText,
                adviceJson: result.advice as unknown as Prisma.InputJsonValue,
                signalsJson: signals as unknown as Prisma.InputJsonValue,
                provider: result.provider,
                model: result.model ?? null,
                generatedAt: new Date(),
            },
            update: {
                postureLabel: result.postureLabel,
                maturityScore: result.maturityScore,
                summaryText: result.summaryText,
                adviceJson: result.advice as unknown as Prisma.InputJsonValue,
                signalsJson: signals as unknown as Prisma.InputJsonValue,
                provider: result.provider,
                model: result.model ?? null,
                generatedAt: new Date(),
            },
        }),
    );

    return result;
}

/**
 * Read the cached compliance-posture summary for a tenant (or null when the
 * daily cron has not yet produced one).
 */
export async function getLatestPostureSummary(
    ctx: RequestContext,
): Promise<CompliancePostureSummary | null> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (tdb) =>
        tdb.compliancePostureSummary.findUnique({ where: { tenantId: ctx.tenantId } }),
    );
}
