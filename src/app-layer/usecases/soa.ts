/**
 * Statement of Applicability — Computation Use Case
 *
 * Produces a deterministic SoA "view" for a tenant against a framework
 * (ISO 27001:2022 Annex A by default).
 *
 * Rules:
 *   Applicability (per requirement):
 *     - Any mapped control APPLICABLE       → true
 *     - All mapped controls NOT_APPLICABLE   → false
 *     - No mapped controls                   → null (unmapped)
 *
 *   Implementation status (worst-status rollup — shared helper):
 *     NOT_STARTED < PLANNED < IN_PROGRESS < IMPLEMENTING < NEEDS_REVIEW < IMPLEMENTED
 *     Reports the lowest status among mapped applicable controls. The order
 *     and status set are owned by @/lib/compliance/requirement-status-rollup
 *     so the ISO SoA and per-framework readiness never diverge.
 *
 *   Justification (when applicable === false):
 *     Concatenates applicabilityJustification from NOT_APPLICABLE controls.
 *     If any justification is missing → missingJustification++.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { WorkItemStatus } from '@prisma/client';
import { isImplemented, rollUpRequirementVerdict } from '@/lib/compliance/requirement-status-rollup';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { coverageQualifyingEvidenceWhere } from '@/lib/compliance/coverage-evidence';
import type {
    SoAReportDTO,
    SoAEntryDTO,
    SoAMappedControlDTO,
    SoASummaryDTO,
} from '@/lib/dto/soa';

// The per-requirement worst-status rollup + canonical status vocabulary now
// live in the shared helper (@/lib/compliance/requirement-status-rollup), so
// the ISO SoA and every framework's coverage/readiness compute the identical
// verdict and no status (PLANNED / IMPLEMENTING) is silently dropped.

// ─── Options ───

export interface SoAOptions {
    framework?: string;       // default ISO27001_2022
    includeEvidence?: boolean;
    includeTasks?: boolean;
    includeTests?: boolean;
}

// ─── Installed-framework resolution ───

/**
 * Resolve which framework the SoA should report on when the caller
 * doesn't pin one explicitly. A framework counts as "installed" for a
 * tenant when at least one of the tenant's controls links to one of
 * that framework's requirements (`ControlRequirementLink`) — that's
 * exactly what `installPack` writes. ISO 27001 is preferred when it's
 * installed (the SoA is an ISO-native artifact); otherwise the first
 * installed framework is used. Falls back to ISO 27001 only when the
 * tenant has nothing installed yet, so a fresh tenant still renders a
 * meaningful (unmapped) baseline instead of erroring.
 *
 * Fixes the report defaulting to ISO 27001's 93 requirements even when
 * the tenant installed a different pack (e.g. NIS2, SOC 2).
 */
export async function resolveInstalledFrameworkKey(
    ctx: RequestContext,
): Promise<string> {
    const installed = await runInTenantContext(ctx, (db) =>
        db.framework.findMany({
            where: {
                requirements: {
                    some: { controlLinks: { some: { tenantId: ctx.tenantId } } },
                },
            },
            select: { key: true },
            orderBy: { key: 'asc' },
        }),
    );
    if (installed.length === 0) return 'ISO27001';
    const keys = installed.map((f) => f.key);
    return keys.includes('ISO27001') ? 'ISO27001' : keys[0];
}

export interface InstalledFramework {
    key: string;
    /** Display name, version-qualified (e.g. "ISO 27001:2022"). */
    name: string;
    /** True for the ISO-27001 family — gates the SoA (Annex-A) artifacts. */
    isIsoFamily: boolean;
}

/**
 * PR-G — the frameworks a tenant has actually installed (≥1
 * ControlRequirementLink), for the Reports framework selector. Reuses the same
 * "installed" detection as {@link resolveInstalledFrameworkKey}. Version-
 * qualifies the name and derives `isIsoFamily` from `kind` (mirrors the SoA
 * DTO) so a non-ISO framework never gets an ISO-Annex-A artifact offered.
 */
export async function listInstalledFrameworks(
    ctx: RequestContext,
): Promise<InstalledFramework[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.framework.findMany({
            where: {
                requirements: {
                    some: { controlLinks: { some: { tenantId: ctx.tenantId } } },
                },
            },
            select: { key: true, name: true, version: true, kind: true },
            orderBy: { key: 'asc' },
        }),
    );
    return rows.map((f) => ({
        key: f.key,
        name: f.version ? `${f.name}:${f.version}` : f.name,
        isIsoFamily: f.kind === 'ISO_STANDARD',
    }));
}

// ─── Main Use Case ───

export async function getSoA(ctx: RequestContext, options: SoAOptions = {}): Promise<SoAReportDTO> {
    assertCanRead(ctx);
    const frameworkKey =
        options.framework || (await resolveInstalledFrameworkKey(ctx));

    // 1. Load framework + requirements
    const fw = await runInTenantContext(ctx, (db) =>
        db.framework.findFirst({ where: { key: frameworkKey } })
    );
    if (!fw) throw notFound(`Framework "${frameworkKey}" not found`);

    const requirements = await runInTenantContext(ctx, (db) =>
        db.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            orderBy: { sortOrder: 'asc' },
        })
    );

    if (requirements.length === 0) throw notFound('No requirements found for this framework');

    const reqIds = requirements.map((r) => r.id);

    // 2. Load all ControlRequirementLinks for this tenant + framework
    interface ControlLinkRow {
        requirementId: string;
        // Per-framework applicability override on the link — NULL inherits the
        // control's global value. SoA reads the EFFECTIVE value below.
        applicability: string | null;
        applicabilityJustification: string | null;
        control: {
            id: string;
            code: string | null;
            name: string;
            status: string;
            applicability: string;
            applicabilityJustification: string | null;
            ownerUserId: string | null;
            frequency: string | null;
            deletedAt: Date | null;
            exceptions: { expiresAt: Date | null }[];
        };
    }
    // R2-P5 — resolve in-force exceptions relative to now so reversion on
    // expiry is automatic (the exception-expiry-monitor also flips
    // APPROVED→EXPIRED, but keying on live status here needs no scheduling).
    const now = new Date();
    const links: ControlLinkRow[] = await runInTenantContext(ctx, (db) =>
        db.controlRequirementLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                requirementId: { in: reqIds },
            },
            include: {
                control: {
                    select: {
                        id: true,
                        code: true,
                        name: true,
                        status: true,
                        applicability: true,
                        applicabilityJustification: true,
                        ownerUserId: true,
                        frequency: true,
                        deletedAt: true,
                        // In-force exceptions: APPROVED and not yet expired.
                        exceptions: {
                            where: { status: 'APPROVED', expiresAt: { gt: now } },
                            select: { expiresAt: true },
                            orderBy: { expiresAt: 'asc' },
                        },
                    },
                },
            },
        })
    ) as ControlLinkRow[];

    // Filter out deleted controls
    const activeLinks = links.filter((l) => !l.control.deletedAt);

    // Group links by requirement ID
    const linksByReq = new Map<string, ControlLinkRow[]>();
    for (const link of activeLinks) {
        const arr = linksByReq.get(link.requirementId) || [];
        arr.push(link);
        linksByReq.set(link.requirementId, arr);
    }

    // 3. Optionally load rollup data
    const controlIds = [...new Set(activeLinks.map((l: { control: { id: string } }) => l.control.id))];

    let evidenceCounts = new Map<string, number>();
    let taskCounts = new Map<string, number>();
    let latestTestResults = new Map<string, string>();

    if (options.includeEvidence && controlIds.length > 0) {
        evidenceCounts = await loadEvidenceCounts(ctx, controlIds);
    }
    if (options.includeTasks && controlIds.length > 0) {
        taskCounts = await loadOpenTaskCounts(ctx, controlIds);
    }
    if (options.includeTests && controlIds.length > 0) {
        latestTestResults = await loadLatestTestResults(ctx, controlIds);
    }

    // 4. Build entries
    const entries: SoAEntryDTO[] = [];
    const summary: SoASummaryDTO = {
        total: requirements.length,
        applicable: 0,
        notApplicable: 0,
        unmapped: 0,
        implemented: 0,
        excepted: 0,
        missingJustification: 0,
    };

    for (const req of requirements) {
        const reqLinks = linksByReq.get(req.id) || [];

        // Build mapped controls list
        const mappedControls: SoAMappedControlDTO[] = reqLinks.map((l) => ({
            controlId: l.control.id,
            code: l.control.code,
            title: l.control.name,
            status: l.control.status,
            // EFFECTIVE applicability — the per-framework link override, falling
            // back to the control's global value. So a control N/A for this
            // framework doesn't read N/A everywhere.
            applicability: l.applicability ?? l.control.applicability,
            justification: l.applicabilityJustification ?? l.control.applicabilityJustification,
            owner: l.control.ownerUserId,
            frequency: l.control.frequency,
        }));

        // Derive applicability
        let applicable: boolean | null = null;
        let justification: string | null = null;

        if (mappedControls.length === 0) {
            // Unmapped
            applicable = null;
            summary.unmapped++;
        } else {
            const hasApplicable = mappedControls.some(c => c.applicability === 'APPLICABLE');
            if (hasApplicable) {
                applicable = true;
                summary.applicable++;
            } else {
                // All NOT_APPLICABLE
                applicable = false;
                summary.notApplicable++;

                // Collect justifications
                const justifications = mappedControls
                    .map(c => c.justification)
                    .filter(Boolean) as string[];

                if (justifications.length > 0) {
                    justification = justifications.join('; ');
                }

                // Check for missing justifications
                const missingCount = mappedControls.filter(c => !c.justification).length;
                if (missingCount > 0) {
                    summary.missingJustification++;
                }
            }
        }

        // Derive implementation verdict (shared rollup — adds EXCEPTED).
        let implementationStatus: string | null = null;
        let verdict: string | null = null;
        let exceptedUntil: string | null = null;
        if (applicable === true) {
            const rollupControls = reqLinks
                .filter((l) => (l.applicability ?? l.control.applicability) === 'APPLICABLE')
                .map((l) => ({
                    status: l.control.status,
                    applicability: l.applicability ?? l.control.applicability,
                    hasInForceException: l.control.exceptions.length > 0,
                }));
            const rolled = rollUpRequirementVerdict(rollupControls);
            implementationStatus = rolled.worst;
            verdict = rolled.verdict;
            if (rolled.verdict === 'implemented') {
                summary.implemented++;
            } else if (rolled.verdict === 'excepted') {
                summary.excepted++;
                // Excepted until the EARLIEST gapping exception expires — after
                // that date a control reverts to a real gap.
                const gapDates = reqLinks
                    .filter((l) => (l.applicability ?? l.control.applicability) === 'APPLICABLE' && !isImplemented(l.control.status))
                    .flatMap((l) => l.control.exceptions.map((e) => e.expiresAt))
                    .filter((d): d is Date => d != null);
                if (gapDates.length > 0) {
                    exceptedUntil = new Date(Math.min(...gapDates.map((d) => d.getTime()))).toISOString();
                }
            }
        }

        // Rollup counts for this entry
        let evidenceCount = 0;
        let openTaskCount = 0;
        let lastTestResult: string | null = null;

        for (const mc of mappedControls) {
            evidenceCount += evidenceCounts.get(mc.controlId) || 0;
            openTaskCount += taskCounts.get(mc.controlId) || 0;
            const tr = latestTestResults.get(mc.controlId);
            if (tr && !lastTestResult) lastTestResult = tr;
        }

        entries.push({
            requirementId: req.id,
            requirementCode: req.code,
            requirementTitle: req.title || '',
            section: req.section || req.category || null,
            applicable,
            justification,
            implementationStatus,
            verdict,
            exceptedUntil,
            mappedControls,
            evidenceCount,
            openTaskCount,
            lastTestResult,
        });
    }

    // 5. Tenant info for slug
    const tenant = await runInTenantContext(ctx, (db) =>
        db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { slug: true },
        })
    );

    return {
        tenantId: ctx.tenantId,
        tenantSlug: tenant?.slug || '',
        framework: frameworkKey,
        // Display name for the report header — resolved from the
        // installed framework so it isn't hard-coded to ISO 27001.
        frameworkName: fw.version ? `${fw.name}:${fw.version}` : fw.name,
        // ISO-family gate — the SoA is an ISO-27001-Annex-A artifact; for a
        // non-ISO pack (SOC 2 / NIS2 / …) the consumer shows coverage/readiness
        // instead of a mislabeled applicability statement.
        isIsoFamily: fw.kind === 'ISO_STANDARD',
        generatedAt: new Date().toISOString(),
        entries,
        summary,
    };
}

// ─── Rollup Helpers ───

async function loadEvidenceCounts(ctx: RequestContext, controlIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    // Evidence↔Control is a many-to-many join now; count the join rows per
    // control (the unique [tenantId, evidenceId, controlId] key means one row
    // per distinct evidence, so the per-control tally is preserved).
    const counts = await runInTenantContext(ctx, (db) =>
        db.evidenceControlLink.groupBy({
            by: ['controlId'],
            // Count only evidence that COUNTS — the SoA tally used to
            // filter deletedAt alone, so DRAFT/expired/archived rows
            // inflated it past what coverage scoring credits.
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIds },
                evidence: coverageQualifyingEvidenceWhere(),
            },
            _count: { id: true },
        })
    );
    for (const row of counts) {
        if (row.controlId) result.set(row.controlId, row._count.id);
    }
    return result;
}

async function loadOpenTaskCounts(ctx: RequestContext, controlIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    // Unified Task model (not legacy controlTask) — the discoverable install
    // paths now write Task rows, so the SoA open-task rollup must read them.
    // "Open" = every non-terminal WorkItemStatus (notIn the shared terminal
    // set) so TRIAGED / BLOCKED tasks are counted too — a positive
    // [OPEN, IN_PROGRESS] allowlist would silently miss them.
    const counts = await runInTenantContext(ctx, (db) =>
        db.task.groupBy({
            by: ['controlId'],
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIds },
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] },
            },
            _count: { id: true },
        })
    );
    for (const row of counts) {
        if (row.controlId) result.set(row.controlId, row._count.id);
    }
    return result;
}

/**
 * How far back a control test can be and still describe the control.
 *
 * There was no date bound and no `take`, so this pulled EVERY completed run for
 * every mapped control and then kept the first per control in JS — the query
 * grew without limit over a tenant's lifetime while the answer it produced
 * stayed the same size. A two-year-old passing test is not evidence about the
 * control today, so bounding the window costs nothing the SoA was using.
 */
const TEST_RESULT_LOOKBACK_DAYS = 730;

/**
 * Upper bound on rows scanned. Generous relative to `controlIds.length` (the
 * answer is one row per control) so a control with a busy test history still
 * resolves, while a pathological tenant cannot make this unbounded.
 */
const TEST_RESULT_MAX_ROWS = 5_000;

async function loadLatestTestResults(ctx: RequestContext, controlIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (controlIds.length === 0) return result;
    const since = new Date(Date.now() - TEST_RESULT_LOOKBACK_DAYS * 86_400_000);
    // Latest completed test run per control, newest first — the loop below
    // keeps the first it sees for each control, so ordering is load-bearing.
    const runs = await runInTenantContext(ctx, (db) =>
        db.controlTestRun.findMany({
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIds },
                status: 'COMPLETED',
                result: { not: null },
                executedAt: { gte: since },
            },
            orderBy: { executedAt: 'desc' },
            select: { controlId: true, result: true },
            take: TEST_RESULT_MAX_ROWS,
        })
    );
    // Take first (latest) per control
    for (const run of runs) {
        if (!result.has(run.controlId) && run.result) {
            result.set(run.controlId, run.result);
        }
    }
    return result;
}
