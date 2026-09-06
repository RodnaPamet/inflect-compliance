import { Prisma, TaskStatus } from '@prisma/client';
import { RequestContext } from '../../types';
import { assertCanViewFrameworks } from '../../policies/framework.policies';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { rollUpRequirementVerdict } from '@/lib/compliance/requirement-status-rollup';
import { isCoverageQualifyingEvidence } from '@/lib/compliance/coverage-evidence';
import { toCsv } from '@/lib/csv/format-csv';
import {
    collapseLinksToOwnRequirements,
    resolveFamilyRequirementAliases,
} from '../../services/framework-representation-aliases';

// ─── Two representations of one framework ───
//
// Every framework in this repo can exist TWICE in `Framework`: the row
// `prisma/seed.ts` writes, and the row `library-importer.ts` writes from the
// YAML in `src/data/libraries/`. Their `key` values MUST differ because
// `Framework.key` is `@unique`, and a tenant's `ControlRequirementLink` rows
// hang off whichever representation its database happened to get.
//
// Both surfaces below joined links on requirement id alone, so a tenant whose
// controls hang off one representation read as covering NOTHING of the other.
// The failure is a WRONG NUMBER rather than an error — the coverage percent on
// the Frameworks list page, the framework JSON + CSV exports, the readiness
// report and the MCP framework tools all reported a mapped control as a gap,
// which is indistinguishable from a customer who has done no work.
//
// The reconciliation itself lives in
// `services/framework-representation-aliases.ts` because `getSoA` and
// `getFrameworkTree` read the SAME links and have to give the same answer:
// fixing this file alone would leave two compliance surfaces contradicting
// each other about one tenant. Read that module's header for the two axes,
// the tie-break, and why the denominator does not move.

// в”Ђв”Ђв”Ђ Coverage Computation в”Ђв”Ђв”Ђ

export async function computeCoverage(ctx: RequestContext, frameworkKey: string, version?: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fw = version
        ? await db.framework.findUnique({ where: { key_version: { key: frameworkKey, version } } })
        : await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    // `deprecatedAt: null` — the third instance of the same divergence the
    // `control: { deletedAt: null }` comment below describes, on the other
    // side of the join. `generateReadinessReport` (this file) and `getSoA`
    // (soa.ts) both exclude deprecated requirements; this query did not, so
    // the SAME field name — `coveragePercent`, same formula — was computed
    // over a LARGER denominator here than in the two reports beside it.
    //
    // Deprecation is a live, default-on write path: `library-importer.ts`
    // ships `deprecateMissing: true` in its defaults and stamps
    // `deprecatedAt` on every requirement absent from a re-imported library,
    // so any tenant that has re-imported a framework has rows this excludes.
    // The drift was one-directional: a requirement no longer in the framework
    // stayed in the denominator forever, and could never be mapped, so this
    // surface reported a permanently LOWER coverage percentage than the
    // readiness report and the SoA for the same tenant at the same moment.
    //
    // This is the number on the Frameworks list page, the framework JSON +
    // CSV exports, and the MCP framework tools/resources.
    const requirements = await db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });

    const requirementById = new Map(requirements.map((r) => [r.id, r]));

    // Get all tenant control requirement links for this framework — and for
    // every OTHER representation of it, via `aliases.lookupIds`.
    //
    // `control: { deletedAt: null }` for the same reason as
    // `generateReadinessReport` below: a soft-deleted control kept satisfying
    // the requirement it used to cover, so coverage counted rows the product
    // considers deleted and drifted UPWARD as data was removed. `getSoA`
    // filters, so the two disagreed about the same tenant at the same moment.
    //
    // The alias resolution reads only GLOBAL tables and runs in the same
    // transaction as the links query, so the two cannot see different
    // catalogues.
    const { rawLinks, aliases } = await runInTenantContext(ctx, async (tdb) => {
        const resolved = await resolveFamilyRequirementAliases(tdb, fw, requirements);
        const rows = await tdb.controlRequirementLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                requirementId: { in: resolved.lookupIds },
                control: { deletedAt: null },
            },
            include: {
                control: { select: { id: true, code: true, name: true, status: true } },
            },
        });
        return { rawLinks: rows, aliases: resolved };
    });

    // Re-point every link at the REQUESTED framework's own requirement row, so
    // a link held against the other representation counts for the obligation
    // it actually satisfies — at most one link per (requirement, control), or
    // a control linked to BOTH representations would emit two identical
    // `controlMappings` entries and two identical CSV rows. `requirement` is
    // read back from the requested framework's rows rather than the link's
    // own, so the output reports one spelling instead of a mixture of two.
    const links = collapseLinksToOwnRequirements(rawLinks, aliases).flatMap((l) => {
        const requirement = requirementById.get(l.requirementId);
        return requirement ? [{ ...l, requirement }] : [];
    });

    const mappedReqIds = new Set(links.map((l) => l.requirementId));
    const mapped = requirements.filter((r) => mappedReqIds.has(r.id));
    const unmapped = requirements.filter((r) => !mappedReqIds.has(r.id));
    const total = requirements.length;
    const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;

    // Group by section
    const sections = [...new Set(requirements.map((r) => r.section || r.category || 'Other'))];
    const bySection = sections.map((s) => {
        const sectionReqs = requirements.filter((r) => (r.section || r.category || 'Other') === s);
        const sectionMapped = sectionReqs.filter((r) => mappedReqIds.has(r.id));
        return {
            section: s,
            total: sectionReqs.length,
            mapped: sectionMapped.length,
            coveragePercent: sectionReqs.length > 0 ? Math.round((sectionMapped.length / sectionReqs.length) * 100) : 0,
        };
    });

    return {
        framework: { key: fw.key, name: fw.name, version: fw.version },
        total,
        mapped: mapped.length,
        unmapped: unmapped.length,
        coveragePercent,
        bySection,
        unmappedRequirements: unmapped.map((r) => ({ code: r.code, title: r.title, section: r.section || r.category })),
        controlMappings: links.map((l) => ({
            requirementCode: l.requirement.code,
            requirementTitle: l.requirement.title,
            controlCode: l.control.code,
            controlName: l.control.name,
            controlStatus: l.control.status,
        })),
    };
}

// в”Ђв”Ђв”Ђ Template Library (global catalog with tenant install status) в”Ђв”Ђв”Ђ

export async function listTemplates(
    ctx: RequestContext,
    filters: { frameworkKey?: string; section?: string; category?: string; search?: string }
) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const where: Prisma.ControlTemplateWhereInput = {};
    if (filters.frameworkKey) {
        const fw = await db.framework.findFirst({ where: { key: filters.frameworkKey } });
        if (!fw) throw notFound('Framework not found');
        where.requirementLinks = { some: { requirement: { frameworkId: fw.id } } };
    }
    if (filters.category) {
        where.category = filters.category;
    }
    if (filters.search) {
        where.OR = [
            { code: { contains: filters.search } },
            { title: { contains: filters.search } },
        ];
    }

    const templates = await db.controlTemplate.findMany({
        where,
        include: {
            tasks: { orderBy: { sortOrder: 'asc' } },
            requirementLinks: { include: { requirement: { include: { framework: true } } } },
            packLinks: { include: { pack: true } },
        },
        orderBy: { code: 'asc' },
    });

    // Check install status per template for this tenant
    const existingControls = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, code: { in: templates.map((t) => t.code) } },
            select: { code: true },
        })
    );
    const installedCodes = new Set(existingControls.map((c) => c.code));

    // Filter by section if specified (section comes from linked requirement)
    let result = templates;
    if (filters.section) {
        result = templates.filter((t) =>
            t.requirementLinks.some((rl) => (rl.requirement.section || rl.requirement.category) === filters.section)
        );
    }

    return result.map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        description: t.description,
        category: t.category,
        defaultFrequency: t.defaultFrequency,
        isGlobal: t.isGlobal,
        installed: installedCodes.has(t.code),
        tasks: t.tasks.map((tt) => ({ id: tt.id, title: tt.title, description: tt.description })),
        requirements: t.requirementLinks.map((rl) => ({
            code: rl.requirement.code,
            title: rl.requirement.title,
            section: rl.requirement.section || rl.requirement.category,
            framework: { key: rl.requirement.framework.key, name: rl.requirement.framework.name },
        })),
        packs: t.packLinks.map((pl) => ({ key: pl.pack.key, name: pl.pack.name })),
    }));
}

// в”Ђв”Ђв”Ђ Export Coverage Data в”Ђв”Ђв”Ђ

export async function exportCoverageData(
    ctx: RequestContext,
    frameworkKey: string,
    format: 'json' | 'csv' = 'json'
) {
    assertCanViewFrameworks(ctx);
    const coverage = await computeCoverage(ctx, frameworkKey);

    if (format === 'json') {
        return coverage;
    }

    // CSV export
    const rows: string[][] = [
        ['Status', 'Requirement Code', 'Requirement Title', 'Section', 'Control Code', 'Control Name', 'Control Status'],
    ];

    for (const m of coverage.controlMappings) {
        rows.push(['Mapped', m.requirementCode, m.requirementTitle, '', m.controlCode || '', m.controlName, m.controlStatus]);
    }
    for (const r of coverage.unmappedRequirements) {
        rows.push(['Unmapped', r.code, r.title, r.section || '', '', '', '']);
    }

    const csv = toCsv(rows);
    return { csv, filename: `${frameworkKey}-coverage.csv` };
}

// в”Ђв”Ђв”Ђ Readiness Report в”Ђв”Ђв”Ђ

export async function generateReadinessReport(ctx: RequestContext, frameworkKey: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fw = await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    // Get all active requirements
    const requirements = await db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });

    // R2-P5 — resolve in-force exceptions relative to now (auto-reverts on
    // expiry). Shared by the exception filter below and the overdue-task check.
    const now = new Date();

    // Get tenant control-requirement mappings, with the same
    // two-representation reconciliation as `computeCoverage` above — the
    // readiness report reads the SAME links and would otherwise report a
    // mapped control as a gap on exactly the tenants that surface does.
    const { rawLinks, aliases } = await runInTenantContext(ctx, async (tdb) => {
        const resolved = await resolveFamilyRequirementAliases(tdb, fw, requirements);
        const rows = await tdb.controlRequirementLink.findMany({
            // `control: { deletedAt: null }` is the second half of the same fix
            // the evidence filter below already made.
            //
            // Without it, a soft-deleted control still arrived through its link
            // and still counted toward `mapped`, `coveragePercent`,
            // `readinessScore` and `controlsMissingEvidence` — while `getSoA`
            // filters soft-deleted controls (soa.ts), so the SoA and the
            // readiness report gave DIFFERENT compliance numbers for the same
            // tenant at the same moment. Readiness was the optimistic one: a
            // deleted control kept satisfying the requirement it used to cover.
            where: {
                tenantId: ctx.tenantId,
                requirementId: { in: resolved.lookupIds },
                control: { deletedAt: null },
            },
            include: {
                control: {
                    include: {
                        // Bounded: an unbounded per-control task load is the
                        // dominant cost of this query on a large tenant, and
                        // only status/dueAt are read — the overdue check below
                        // does not need every task ever created.
                        // `orderBy` is not cosmetic here. Without it Postgres
                        // returns an ARBITRARY 500, so the overdue check below
                        // could miss overdue tasks that happened to fall
                        // outside the window — and miss DIFFERENT ones on each
                        // run. `dueAt: 'asc'` puts the most overdue first
                        // (NULLs sort last, and a task with no due date can
                        // never be overdue), so the rows the check actually
                        // needs are the ones guaranteed to be present.
                        //
                        // Measured 2026-08-15: max 7 tasks on any production
                        // control, so the cap does not bind today. This makes
                        // the day it does bind produce a correct answer rather
                        // than an optimistic one.
                        tasks: {
                            select: { id: true, status: true, dueAt: true, title: true },
                            orderBy: { dueAt: 'asc' },
                            take: 500,
                        },
                        // Evidence↔Control is a many-to-many join now; read the
                        // linked Evidence through it (flattened at the consumer).
                        // PR-I — exclude soft-deleted evidence at the query
                        // level so readiness agrees with the SoA rollup (which
                        // filters `evidence: { deletedAt: null }`). The
                        // isCoverageQualifyingEvidence predicate below also
                        // drops deleted rows; this makes the exclusion explicit
                        // + query-efficient and keeps the two report families
                        // from diverging on what evidence "counts".
                        evidenceControlLinks: {
                            where: { tenantId: ctx.tenantId, evidence: { deletedAt: null } },
                            select: { evidence: { select: { id: true, status: true, title: true, expiredAt: true, isArchived: true, deletedAt: true } } },
                            // Same reasoning as `tasks` above: an unordered
                            // `take` makes the truncation arbitrary, so a
                            // control WITH qualifying evidence could be
                            // reported as missing it — pessimistic here, but
                            // still wrong, and irreproducible between runs.
                            //
                            // Newest first: the consumer only asks whether ANY
                            // linked row is coverage-qualifying, and a recent
                            // row is likelier to be APPROVED and unexpired than
                            // an old one. Max 3 per control in production, so
                            // this does not bind today either.
                            orderBy: { createdAt: 'desc' },
                            take: 500,
                        },
                        // In-force exceptions: APPROVED and not yet expired.
                        exceptions: {
                            where: { status: 'APPROVED', expiresAt: { gt: now } },
                            select: { id: true },
                            // Only `.length > 0` is read, so one row settles it.
                            take: 1,
                        },
                    },
                },
            },
        });
        return { rawLinks: rows, aliases: resolved };
    });

    // Re-point every link at this framework's own requirement row (see
    // `collapseLinksToOwnRequirements`); everything below then reads exactly
    // as it did when links could only ever name this framework's rows —
    // including the "at most one link per (requirement, control)" guarantee
    // `@@unique([controlId, requirementId])` used to provide on its own, which
    // the per-requirement rollup and the N/A lists both lean on.
    const links = collapseLinksToOwnRequirements(rawLinks, aliases);

    const mappedReqIds = new Set(links.map((l) => l.requirementId));
    const mapped = requirements.filter((r) => mappedReqIds.has(r.id));
    const unmapped = requirements.filter((r) => !mappedReqIds.has(r.id));
    const total = requirements.length;
    const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;

    // Unique controls involved
    type LinkControl = (typeof links)[0]['control'];
    const controlsMap = new Map<string, LinkControl>();
    for (const l of links) {
        if (!controlsMap.has(l.control.id)) {
            controlsMap.set(l.control.id, l.control);
        }
    }
    const controls = Array.from(controlsMap.values());

    // Per-requirement implementation verdict — via the SHARED rollup helper
    // so this per-framework readiness recognises the full status vocabulary
    // (PLANNED / IMPLEMENTING included) and produces the identical verdict as
    // the ISO SoA. Mirrors SoA semantics: only APPLICABLE mapped controls
    // count; a requirement is "implemented" iff its worst applicable control
    // is IMPLEMENTED, else it's a gap. (P5 layers EXCEPTED on this seam.)
    const rollupControlsByReq = new Map<string, { status: string; applicability: string; hasInForceException: boolean }[]>();
    for (const l of links) {
        const arr = rollupControlsByReq.get(l.requirementId) || [];
        arr.push({
            status: l.control.status,
            // EFFECTIVE applicability — per-framework link override ?? control global.
            applicability: l.applicability ?? l.control.applicability,
            hasInForceException: (l.control.exceptions ?? []).length > 0,
        });
        rollupControlsByReq.set(l.requirementId, arr);
    }
    let implementedRequirements = 0;
    let gapRequirements = 0;
    let exceptedRequirements = 0; // R2-P5 — risk-accepted via in-force exception
    for (const reqId of mappedReqIds) {
        const { verdict } = rollUpRequirementVerdict(rollupControlsByReq.get(reqId) || []);
        if (verdict === 'implemented') implementedRequirements++;
        else if (verdict === 'excepted') exceptedRequirements++;
        else if (verdict === 'gap') gapRequirements++;
        // 'not-applicable' / 'unmapped' → neither implemented nor a gap
    }

    // EFFECTIVE applicability per control — the per-framework link override
    // (`ControlRequirementLink.applicability`) falling back to the control's
    // global column, resolved exactly as `getSoA` (soa.ts) and the shared
    // rollup 20 lines above already resolve it.
    //
    // These two lists used to key on `Control.status === 'NOT_APPLICABLE'`,
    // which is the SAME divergence class the `deletedAt` comment on the links
    // query above describes: the SoA and the readiness report answering
    // "is this control applicable?" from two different columns, so they gave
    // DIFFERENT compliance numbers for the same tenant at the same moment.
    //
    // Here the readiness side was the PESSIMISTIC one, and silently so.
    // Marking a control N/A is an `applicability` write — `setApplicability`
    // (ControlRepository) writes `applicability` + justification + decided-by
    // + decided-at and never touches `status`, and all three status-write
    // schemas exclude NOT_APPLICABLE on purpose (src/lib/schemas/index.ts).
    // So no current write path can produce the state this filter tested for:
    // `notApplicableControls` could only ever list rows left behind by a
    // pre-hardening writer, while every properly-decided N/A control fell
    // through to `controlsMissingEvidence` and was billed as a gap.
    //
    // A control counts as N/A for this framework only when EVERY link that
    // brings it in says so — if it is applicable against any requirement
    // here, it still owes evidence.
    const applicableSomewhere = new Set<string>();
    for (const l of links) {
        if ((l.applicability ?? l.control.applicability) !== 'NOT_APPLICABLE') {
            applicableSomewhere.add(l.control.id);
        }
    }
    const isNotApplicable = (c: LinkControl) => !applicableSomewhere.has(c.id);

    // NOT_APPLICABLE controls
    const notApplicable = controls.filter(isNotApplicable).map((c) => ({
        code: c.code,
        name: c.name,
        justification: c.applicabilityJustification || 'No justification provided',
    }));

    // Controls missing evidence — a control "has evidence" only when at
    // least one attached row is coverage-qualifying (APPROVED + unexpired +
    // not archived/deleted). Reuses the `now` resolved above.
    //
    // DELIBERATELY UNCAPPED, and the same goes for `overdueTasks` below.
    // Measured against production on 2026-08-15 before deciding:
    //
    //   worst tenant           308 control→requirement links
    //   tasks per control      max 7      (the include caps at 500)
    //   evidence per control   max 3      (the include caps at 500)
    //
    // The fan-out is ~2 orders of magnitude under the caps already in place,
    // so there is no cost here to reclaim — capping these would be optimising
    // a number nobody is paying.
    //
    // It would also be WRONG. These two arrays feed an auditor-facing report
    // and its CSV export. A `take` makes a truncated list look like a complete
    // one, so the report would UNDERSTATE gaps — the same failure class as the
    // soft-deleted-control bug documented at the links query above, where
    // "readiness was the optimistic one". A compliance number that errs
    // optimistic is a correctness regression, not a performance win.
    //
    // If this ever does get slow, the honest fixes are to narrow the SELECT or
    // paginate the RENDER while keeping the count whole — never to silently
    // shorten the list. The failure mode today is a 60s timeout on an
    // admin-triggered report: visible, and far preferable to a quiet undercount.
    //
    // (Layer D2's unbounded-findMany budget scans `repositories/` only, so
    // this file has never been in its scope — the absence of a
    // `guardrail-allow` pragma here is not a prior decision.)
    const missingEvidence = controls.filter((c) =>
        !isNotApplicable(c) &&
        !(c.evidenceControlLinks ?? []).some((l) => isCoverageQualifyingEvidence(l.evidence, now))
    ).map((c) => ({ code: c.code, name: c.name, status: c.status }));

    // Overdue tasks (reuses `now` defined above for the exception filter)
    const overdueTasks: Array<{ taskTitle: string; taskStatus: string; dueDate: Date; controlCode: string | null; controlName: string }> = [];
    for (const ctrl of controls) {
        for (const task of (ctrl.tasks || [])) {
            if (task.dueAt && new Date(task.dueAt) < now && task.status !== TaskStatus.RESOLVED && task.status !== TaskStatus.CLOSED && task.status !== TaskStatus.CANCELED) {
                overdueTasks.push({
                    taskTitle: task.title,
                    taskStatus: task.status,
                    dueDate: task.dueAt,
                    controlCode: ctrl.code,
                    controlName: ctrl.name,
                });
            }
        }
    }

    // By section
    const sections = [...new Set(requirements.map((r) => r.section || r.category || 'Other'))];
    const bySection = sections.map((s) => {
        const sectionReqs = requirements.filter((r) => (r.section || r.category || 'Other') === s);
        const sectionMapped = sectionReqs.filter((r) => mappedReqIds.has(r.id));
        return {
            section: s,
            total: sectionReqs.length,
            mapped: sectionMapped.length,
            coveragePercent: sectionReqs.length > 0 ? Math.round((sectionMapped.length / sectionReqs.length) * 100) : 0,
        };
    });

    // PR-I — readiness must reward IMPLEMENTATION, not mapping density. The
    // headline `readinessScore` is based on the implemented-requirement share
    // (from the shared verdict rollup), not `coveragePercent` (link-existence).
    // A framework with 80% mapped but 0 implemented reads as ~0 readiness, not
    // 80. `coveragePercent` remains the separate "Mapped %" metric.
    const implementedPercent =
        total > 0 ? Math.round((implementedRequirements / total) * 100) : 0;

    return {
        framework: { key: fw.key, name: fw.name, version: fw.version },
        // PR-U — ISO-family flag so the report EXPORTS (audit-readiness / gap PDFs)
        // that now compute off THIS payload can gate residual SoA/Annex-A wording
        // exactly as the SoA CSV route does, keeping non-ISO exports free of ISO
        // constructs. Same derivation as the SoA DTO (`fw.kind === 'ISO_STANDARD'`).
        isIsoFamily: fw.kind === 'ISO_STANDARD',
        generatedAt: now.toISOString(),
        coverage: { total, mapped: mapped.length, unmapped: unmapped.length, coveragePercent },
        bySection,
        unmappedRequirements: unmapped.map((r) => ({
            code: r.code, title: r.title, section: r.section || r.category,
        })),
        notApplicableControls: notApplicable,
        controlsMissingEvidence: missingEvidence,
        overdueTasks,
        summary: {
            totalRequirements: total,
            mappedRequirements: mapped.length,
            coveragePercent,
            // Per-requirement implementation verdict from the shared rollup
            // (recognises every control status; identical to the ISO SoA).
            implementedRequirements,
            gapRequirements,
            // R2-P5 — risk-accepted via an in-force exception (flows to every
            // framework's readiness, not just the ISO SoA).
            exceptedRequirements,
            notApplicableCount: notApplicable.length,
            missingEvidenceCount: missingEvidence.length,
            overdueTaskCount: overdueTasks.length,
            readinessScore: Math.max(0, implementedPercent - (missingEvidence.length * 2) - (overdueTasks.length * 3)),
        },
    };
}

export async function exportReadinessReport(
    ctx: RequestContext,
    frameworkKey: string,
    format: 'json' | 'csv' = 'json'
) {
    const report = await generateReadinessReport(ctx, frameworkKey);

    if (format === 'json') return report;

    const rows: string[][] = [
        ['Section', 'Type', 'Code', 'Title/Description', 'Status', 'Due Date'],
    ];

    for (const r of report.unmappedRequirements) {
        rows.push([r.section || '', 'Unmapped Requirement', r.code, r.title, '', '']);
    }
    for (const c of report.notApplicableControls) {
        rows.push(['', 'Not Applicable Control', c.code || '', `${c.name} — ${c.justification}`, 'NOT_APPLICABLE', '']);
    }
    for (const c of report.controlsMissingEvidence) {
        rows.push(['', 'Missing Evidence', c.code || '', c.name, c.status, '']);
    }
    for (const t of report.overdueTasks) {
        rows.push(['', 'Overdue Task', t.controlCode || '', `${t.taskTitle} (${t.controlName})`, t.taskStatus, t.dueDate?.toString() || '']);
    }

    const csv = toCsv(rows);
    return { csv, filename: `${frameworkKey}-readiness-report.csv`, summary: report.summary };
}
