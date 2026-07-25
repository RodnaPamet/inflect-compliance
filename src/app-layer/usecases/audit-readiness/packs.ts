/**
 * Audit Readiness — Pack CRUD, Freeze, Snapshots, Export, Default Pack Preview
 */
import { AuditPackItemEntityType, WorkItemStatus, ControlStatus } from '@prisma/client';
import { type PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../../types';
import { policyCountsWhere } from '@/lib/policy/coverage-predicate';
import {
    assertCanManageAuditPacks, assertCanFreezePack, assertCanViewPack,
} from '../../policies/audit-readiness.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { coverageQualifyingEvidenceWhere } from '@/lib/compliance/coverage-evidence';

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Audit Packs РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function createAuditPack(ctx: RequestContext, auditCycleId: string, name: string) {
    assertCanManageAuditPacks(ctx);
    const pack = await runInTenantContext(ctx, async (tdb) => {
        const cycle = await tdb.auditCycle.findFirst({ where: { id: auditCycleId, tenantId: ctx.tenantId } });
        if (!cycle) throw notFound('Audit cycle not found');
        const created = await tdb.auditPack.create({
            data: { tenantId: ctx.tenantId, auditCycleId, name },
        });
        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_CREATED', entityType: 'AuditPack', entityId: created.id, details: JSON.stringify({ auditCycleId, name }), detailsJson: { category: 'entity_lifecycle', entityName: 'AuditPack', operation: 'created', after: { auditCycleId, name }, summary: `Audit pack created: ${name}` } });
        return created;
    });
    await bumpEntityCacheVersion(ctx, 'audit');
    return pack;
}

export async function listAuditPacks(ctx: RequestContext, cycleId?: string) {
    assertCanViewPack(ctx);
    return runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findMany({
            where: { tenantId: ctx.tenantId, ...(cycleId ? { auditCycleId: cycleId } : {}) },
            include: { _count: { select: { items: true } }, cycle: { select: { frameworkKey: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        })
    );
}

export async function getAuditPack(ctx: RequestContext, packId: string) {
    assertCanViewPack(ctx);
    const pack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId },
            include: {
                items: { orderBy: { sortOrder: 'asc' } },
                cycle: true,
                frozenBy: { select: { id: true, name: true, email: true } },
                _count: { select: { items: true, shares: true } },
            },
        })
    );
    if (!pack) throw notFound('Audit pack not found');
    return pack;
}

export async function updateAuditPack(ctx: RequestContext, packId: string, data: { name?: string; notes?: string }) {
    assertCanManageAuditPacks(ctx);
    const pack = await runInTenantContext(ctx, async (tdb) => {
        const existing = await tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId } });
        if (!existing) throw notFound('Audit pack not found');
        if (existing.status !== 'DRAFT') throw badRequest('Cannot update a frozen or exported pack');
        return tdb.auditPack.update({
            where: { id: packId },
            data: { ...(data.name !== undefined && { name: data.name }), ...(data.notes !== undefined && { notes: data.notes }) },
        });
    });
    await bumpEntityCacheVersion(ctx, 'audit');
    return pack;
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Pack Items РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function addAuditPackItems(
    ctx: RequestContext,
    packId: string,
    items: Array<{ entityType: string; entityId: string; snapshotJson?: string; sortOrder?: number }>
) {
    assertCanManageAuditPacks(ctx);
    const outcome = await runInTenantContext(ctx, async (tdb) => {
        const pack = await tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId } });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status !== 'DRAFT') throw badRequest('Cannot add items to a frozen or exported pack');
        if (!items || items.length === 0) throw badRequest('At least one item required');

        const payload = items.map(item => ({
            tenantId: ctx.tenantId,
            auditPackId: packId,
            entityType: item.entityType as AuditPackItemEntityType,
            entityId: item.entityId,
            snapshotJson: item.snapshotJson || '{}',
            sortOrder: item.sortOrder ?? 0,
        }));

        const result = await tdb.auditPackItem.createMany({
            data: payload,
            skipDuplicates: true,
        });

        const created = result.count;
        const skipped = items.length - created;

        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_UPDATED', entityType: 'AuditPack', entityId: packId, details: JSON.stringify({ created, skipped }), detailsJson: { category: 'entity_lifecycle', entityName: 'AuditPack', operation: 'updated', after: { itemsCreated: created, itemsSkipped: skipped }, summary: `Audit pack items added: ${created} created, ${skipped} skipped` } });
        return { created, skipped };
    });
    await bumpEntityCacheVersion(ctx, 'audit');
    return outcome;
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Snapshot Creation РІвЂќР‚РІвЂќР‚РІвЂќР‚

async function createControlSnapshot(tdb: PrismaTx, controlId: string, tenantId: string): Promise<string> {
    const ctrl = await tdb.control.findFirst({
        where: { id: controlId, tenantId },
        include: {
            tasks: { select: { id: true, title: true, status: true, dueAt: true } },
            // Evidence↔Control is a many-to-many join now; the snapshot only
            // needs the linked-evidence count (one join row per distinct
            // evidence via the unique key).
            evidenceControlLinks: { where: { tenantId }, select: { id: true } },
            requirementLinks: { include: { requirement: { select: { code: true, title: true, frameworkId: true } } } },
        },
    });
    if (!ctrl) return JSON.stringify({ error: 'Control not found', entityId: controlId });
    return JSON.stringify({
        code: ctrl.code, name: ctrl.name, status: ctrl.status,
        objective: ctrl.objective,
        owner: ctrl.ownerUserId,
        taskCompletion: { total: ctrl.tasks.length, done: ctrl.tasks.filter((t) => t.status === WorkItemStatus.RESOLVED || t.status === WorkItemStatus.CLOSED).length },
        evidenceCount: ctrl.evidenceControlLinks.length,
        mappedRequirements: (ctrl.requirementLinks || []).map((l) => ({
            code: l.requirement.code, title: l.requirement.title,
        })),
        snapshotAt: new Date().toISOString(),
    });
}

async function createPolicySnapshot(tdb: PrismaTx, policyId: string, tenantId: string): Promise<string> {
    const pol = await tdb.policy.findFirst({
        where: { id: policyId, tenantId },
        include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { versionNumber: true } } },
    });
    if (!pol) return JSON.stringify({ error: 'Policy not found', entityId: policyId });
    return JSON.stringify({
        title: pol.title, status: pol.status, category: pol.category,
        currentVersion: pol.versions[0]?.versionNumber,
        snapshotAt: new Date().toISOString(),
    });
}

async function createEvidenceSnapshot(tdb: PrismaTx, evidenceId: string, tenantId: string): Promise<string> {
    const ev = await tdb.evidence.findFirst({ where: { id: evidenceId, tenantId } });
    if (!ev) return JSON.stringify({ error: 'Evidence not found', entityId: evidenceId });
    return JSON.stringify({
        title: ev.title, type: ev.type, status: ev.status,
        snapshotAt: new Date().toISOString(),
    });
}

async function createIssueSnapshot(tdb: PrismaTx, issueId: string, tenantId: string): Promise<string> {
    const issue = await tdb.task.findFirst({ where: { id: issueId, tenantId } });
    if (!issue) return JSON.stringify({ error: 'Issue not found', entityId: issueId });
    return JSON.stringify({
        title: issue.title, type: issue.type, severity: issue.severity,
        status: issue.status, dueAt: issue.dueAt,
        snapshotAt: new Date().toISOString(),
    });
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Freeze Pack РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function freezeAuditPack(ctx: RequestContext, packId: string) {
    assertCanFreezePack(ctx);

    // Use an extended transaction timeout (60s) because large packs (500+ items)
    // require snapshot creation for each item, which exceeds the default 5s timeout.
    const frozenPack = await runInTenantContext(ctx, async (tdb) => {
        const pack = await tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId },
            include: { items: true },
        });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status !== 'DRAFT') throw badRequest('Pack is already frozen or exported');
        if (pack.items.length === 0) throw badRequest('Cannot freeze an empty pack');

        // Create snapshots for all items in chunks
        const CHUNK_SIZE = 10;
        for (let i = 0; i < pack.items.length; i += CHUNK_SIZE) {
            const chunk = pack.items.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (item) => {
                let snapshot = item.snapshotJson;
                try {
                    if (!snapshot || snapshot === '{}') {
                        switch (item.entityType) {
                            case 'CONTROL': snapshot = await createControlSnapshot(tdb, item.entityId, ctx.tenantId); break;
                            case 'POLICY': snapshot = await createPolicySnapshot(tdb, item.entityId, ctx.tenantId); break;
                            case 'EVIDENCE': snapshot = await createEvidenceSnapshot(tdb, item.entityId, ctx.tenantId); break;
                            case 'ISSUE': snapshot = await createIssueSnapshot(tdb, item.entityId, ctx.tenantId); break;
                            default: snapshot = JSON.stringify({ entityType: item.entityType, entityId: item.entityId, snapshotAt: new Date().toISOString() });
                        }
                        await tdb.auditPackItem.update({ where: { id: item.id }, data: { snapshotJson: snapshot } });
                    }
                } catch { /* keep existing snapshot */ }
            }));
        }

        const result = await tdb.auditPack.update({
            where: { id: packId },
            data: { status: 'FROZEN', frozenAt: new Date(), frozenByUserId: ctx.userId },
        });

        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_FROZEN', entityType: 'AuditPack', entityId: packId, details: JSON.stringify({ itemCount: pack.items.length }), detailsJson: { category: 'status_change', entityName: 'AuditPack', fromStatus: 'DRAFT', toStatus: 'FROZEN', reason: `Pack frozen with ${pack.items.length} items` } });

        return { frozenPack: result, itemCount: pack.items.length };
    }, { timeout: 60000, maxWait: 10000 });

    // Phase 2: Attach SoA snapshot as EXPORT_ARTIFACT (best-effort, separate transaction)
    // This runs outside the freeze transaction because getSoA opens its own
    // runInTenantContext calls, and Prisma interactive transactions cannot be nested.
    try {
        const { getSoA } = await import('../soa');
        const soaReport = await getSoA(ctx, {
            includeEvidence: true,
            includeTasks: true,
            includeTests: true,
        });
        const soaSnapshot = JSON.stringify({
            type: 'SOA_REPORT',
            framework: soaReport.framework,
            generatedAt: soaReport.generatedAt,
            summary: soaReport.summary,
            entries: soaReport.entries.map((e) => ({
                code: e.requirementCode,
                title: e.requirementTitle,
                section: e.section,
                applicable: e.applicable,
                justification: e.justification,
                status: e.implementationStatus,
                controlRefs: e.mappedControls.map((c) => `${c.code ?? '—'} ${c.title}`).join('; '),
                evidenceCount: e.evidenceCount,
            })),
            snapshotAt: new Date().toISOString(),
        });
        await runInTenantContext(ctx, (tdb) =>
            tdb.auditPackItem.create({
                data: {
                    tenantId: ctx.tenantId,
                    auditPackId: packId,
                    // EXPORT_ARTIFACT not yet in AuditPackItemEntityType enum; pending schema migration
                    entityType: 'EXPORT_ARTIFACT' as AuditPackItemEntityType,
                    entityId: `soa-${soaReport.framework}`,
                    snapshotJson: soaSnapshot,
                    sortOrder: frozenPack.itemCount + 1,
                },
            })
        );
    } catch { /* SoA attachment is best-effort */ }

    await bumpEntityCacheVersion(ctx, 'audit');
    return frozenPack.frozenPack;
}


// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Default Pack Templates (selection logic) РІвЂќР‚РІвЂќР‚РІвЂќР‚
//
// The default pack is a CURATED starting point, NOT a dump of the whole
// tenant. An auditor wants the story of what is *in place and evidenced*,
// plus the open items being worked — not every draft policy and
// not-started control. The curation rules (shared across frameworks):
//
//   • Controls  — framework-mapped controls that are actually OPERATING
//                 (IMPLEMENTED or under NEEDS_REVIEW). NOT_APPLICABLE /
//                 not-started / in-progress controls are excluded; the
//                 no-mapping fallback narrows to operating controls
//                 rather than every control.
//   • Policies  — only PUBLISHED (issued) policies (a draft/approved-but-
//                 unpublished policy is not an auditable artefact), preferring
//                 the framework-relevant ones by category/title.
//   • Evidence  — APPROVED evidence linked to the selected controls
//                 (the reviewed, attestation-grade artefacts).
//   • Issues    — OPEN (non-terminal) findings/tasks, so the auditor
//                 sees the live remediation backlog.

/** Control statuses that represent a control actually in operation. */
const OPERATING_CONTROL_STATUSES: readonly ControlStatus[] = [
    ControlStatus.IMPLEMENTED,
    ControlStatus.NEEDS_REVIEW,
];
// Auditable policies are gated by the shared "counts toward coverage"
// predicate (PUBLISHED + not deleted) — see @/lib/policy/coverage-predicate.
// Previously this counted APPROVED as well; an approved-but-unpublished policy
// has not been issued and is not an auditable artefact.

export async function previewDefaultPack(ctx: RequestContext, cycleId: string) {
    assertCanViewPack(ctx);

    const cycle = await runInTenantContext(ctx, (tdb) =>
        tdb.auditCycle.findFirst({ where: { id: cycleId, tenantId: ctx.tenantId } })
    );
    if (!cycle) throw notFound('Audit cycle not found');

    if (cycle.frameworkKey === 'ISO27001') {
        return buildCuratedDefaultPack(ctx, 'ISO27001', ['security', 'information security', 'access control']);
    } else if (cycle.frameworkKey === 'NIS2') {
        return buildCuratedDefaultPack(ctx, 'NIS2', ['incident', 'business continuity', 'disaster recovery', 'access control', 'supplier', 'supply chain']);
    }
    throw badRequest(`No default pack template for framework: ${cycle.frameworkKey}`);
}

/**
 * Curated default-pack selection shared by every framework template.
 * `policyKeywords` biases policy selection toward framework-relevant
 * titles/categories among the APPROVED/PUBLISHED set.
 */
async function buildCuratedDefaultPack(ctx: RequestContext, frameworkKey: string, policyKeywords: string[]) {
    const fw = await runInTenantContext(ctx, (tdb) => tdb.framework.findFirst({ where: { key: frameworkKey } }));

    // Controls mapped to the framework's requirements…
    let mappedControlIds: string[] = [];
    if (fw) {
        const links = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirement: { frameworkId: fw.id } },
                select: { controlId: true },
            })
        );
        mappedControlIds = [...new Set(links.map((l) => l.controlId))];
    }

    // …narrowed to controls that are actually operating. If there is no
    // framework mapping, fall back to ALL operating controls (still
    // curated by status — never a full dump of not-started controls).
    const operatingControls = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { in: [...OPERATING_CONTROL_STATUSES] },
                ...(mappedControlIds.length > 0 ? { id: { in: mappedControlIds } } : {}),
            },
            // Shared coverage definition — status alone let archived,
            // expired and soft-deleted-but-APPROVED evidence count here
            // while coverage.ts excluded it.
            select: { id: true, evidenceControlLinks: { where: { evidence: coverageQualifyingEvidenceWhere() }, select: { evidenceId: true } } },
            take: 2000,
        })
    );
    const controlIds = operatingControls.map((c) => c.id);

    // PUBLISHED (issued) policies, preferring framework-relevant ones.
    const policies = await runInTenantContext(ctx, (tdb) =>
        tdb.policy.findMany({
            where: policyCountsWhere(ctx.tenantId),
            select: { id: true, title: true, category: true },
            take: 2000,
        })
    );
    const relevantPolicies = policies.filter((p) => {
        const text = `${p.title} ${p.category || ''}`.toLowerCase();
        return policyKeywords.some((kw) => text.includes(kw));
    });
    const policyIds = (relevantPolicies.length > 0 ? relevantPolicies : policies).map((p) => p.id);

    // APPROVED evidence linked to the selected operating controls (deduped:
    // one evidence can now be linked to several controls via the join).
    const evidenceIds = [...new Set(operatingControls.flatMap((c) => c.evidenceControlLinks.map((l) => l.evidenceId)))];

    // Open (non-terminal) findings / tasks — the live remediation backlog.
    const issues = await runInTenantContext(ctx, (tdb) =>
        tdb.task.findMany({
            where: { tenantId: ctx.tenantId, status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] } },
            select: { id: true },
            take: 2000,
        })
    );
    const issueIds = issues.map((i) => i.id);

    return {
        frameworkKey,
        selection: {
            controls: { count: controlIds.length, ids: controlIds },
            policies: { count: policyIds.length, ids: policyIds },
            evidence: { count: evidenceIds.length, ids: evidenceIds },
            issues: { count: issueIds.length, ids: issueIds },
        },
        totalItems: controlIds.length + policyIds.length + evidenceIds.length + issueIds.length,
    };
}

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Export Primitives РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function exportAuditPack(ctx: RequestContext, packId: string, format: 'json' | 'csv' = 'json') {
    assertCanViewPack(ctx);
    const pack = await getAuditPack(ctx, packId);
    if (pack.status === 'DRAFT') throw badRequest('Cannot export a draft pack');

    const items = pack.items.map((item) => ({
        entityType: item.entityType,
        entityId: item.entityId,
        sortOrder: item.sortOrder,
        snapshot: JSON.parse(item.snapshotJson || '{}'),
    }));

    if (format === 'json') {
        return {
            pack: { id: pack.id, name: pack.name, status: pack.status, frozenAt: pack.frozenAt },
            cycle: pack.cycle,
            items,
        };
    }

    // CSV
    const rows: string[][] = [
        ['Type', 'Entity ID', 'Name/Title', 'Status', 'Details'],
    ];
    for (const item of items) {
        const s = item.snapshot;
        rows.push([
            item.entityType,
            item.entityId,
            s.code || s.title || s.name || '',
            s.status || '',
            JSON.stringify(s),
        ]);
    }

    const csv = rows.map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return { csv, filename: `${pack.name.replace(/\s+/g, '-')}-audit-pack.csv` };
}
