/**
 * Audit Readiness — Pack CRUD, Freeze, Snapshots, Export, Default Pack Preview
 */
import { AuditPackItemEntityType, TaskStatus, ControlStatus } from '@prisma/client';
import { RequestContext } from '../../types';
import { policyCountsWhere } from '@/lib/policy/coverage-predicate';
import {
    assertCanManageAuditPacks, assertCanFreezePack, assertCanViewPack,
} from '../../policies/audit-readiness.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { TERMINAL_TASK_STATUSES } from '../../domain/task-status';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { coverageQualifyingEvidenceWhere } from '@/lib/compliance/coverage-evidence';
import { toCsv } from '@/lib/csv/format-csv';

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
            // Soft-deleted packs are never listed (the column + index exist
            // on AuditPack but nothing filtered it before).
            where: { tenantId: ctx.tenantId, deletedAt: null, ...(cycleId ? { auditCycleId: cycleId } : {}) },
            include: { _count: { select: { items: true } }, cycle: { select: { frameworkKey: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            // Bounded read — a tenant realistically has far fewer than 1000
            // packs; this caps the query rather than returning the whole table.
            take: 1000,
        })
    );
}

export async function getAuditPack(ctx: RequestContext, packId: string) {
    assertCanViewPack(ctx);
    const pack = await runInTenantContext(ctx, (tdb) =>
        tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                // Safety ceiling far above any realistic pack (the add-items
                // route caps 2000/call, packs are curated) — bounds the
                // relation load without truncating a genuine export.
                items: { orderBy: { sortOrder: 'asc' }, take: 10000 },
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
        const existing = await tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId, deletedAt: null } });
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
        const pack = await tdb.auditPack.findFirst({ where: { id: packId, tenantId: ctx.tenantId, deletedAt: null } });
        if (!pack) throw notFound('Audit pack not found');
        // #2 — a frozen/exported pack is immutable; never write items to it.
        if (pack.status !== 'DRAFT') throw badRequest('Cannot add items to a frozen or exported pack');
        if (!items || items.length === 0) throw badRequest('At least one item required');

        // #4 — validate every body-supplied entityId belongs to THIS tenant
        // BEFORE inserting (mirrors createAudit's cycle-ref check). Previously
        // the id was stamped with ctx.tenantId and linked without checking the
        // referenced row exists — a foreign/absent id created a dangling item.
        // One batched lookup per concrete entity type (no per-item N+1). The
        // ISSUE type maps to Task; synthetic types (READINESS_REPORT /
        // FRAMEWORK_COVERAGE / FILE / TEST_RUN) reference computed artefacts or
        // storage keys, not a single owned row, so they are not FK-checked.
        const idsOf = (t: string) => items.filter((it) => it.entityType === t).map((it) => it.entityId);
        const controlIds = idsOf('CONTROL');
        const policyIds = idsOf('POLICY');
        const evidenceIds = idsOf('EVIDENCE');
        const issueIds = idsOf('ISSUE');
        const [foundControls, foundPolicies, foundEvidence, foundTasks] = await Promise.all([
            controlIds.length ? tdb.control.findMany({ where: { id: { in: controlIds }, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } }) : [],
            policyIds.length ? tdb.policy.findMany({ where: { id: { in: policyIds }, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } }) : [],
            // EVIDENCE items reference an Evidence row (the freeze snapshot reads
            // Evidence); FILE items — validated separately — reference FileRecord.
            evidenceIds.length ? tdb.evidence.findMany({ where: { id: { in: evidenceIds }, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } }) : [],
            issueIds.length ? tdb.task.findMany({ where: { id: { in: issueIds }, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } }) : [],
        ]);
        const known: Record<string, Set<string>> = {
            CONTROL: new Set(foundControls.map((r) => r.id)),
            POLICY: new Set(foundPolicies.map((r) => r.id)),
            EVIDENCE: new Set(foundEvidence.map((r) => r.id)),
            ISSUE: new Set(foundTasks.map((r) => r.id)),
        };
        for (const item of items) {
            const set = known[item.entityType];
            if (set && !set.has(item.entityId)) {
                throw badRequest('INVALID_PACK_ITEM_REF', `${item.entityType} ${item.entityId} not found in this tenant`);
            }
        }

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

// Snapshot serialisation is inlined into freezeAuditPack below. The
// per-item source rows are BATCH-loaded there (one findMany per entity
// type) rather than one findFirst per item, so the JSON shaping runs
// over an in-memory map — no per-item round-trip inside the freeze
// transaction. The shapes below are preserved verbatim from the former
// createControl/Policy/Evidence/IssueSnapshot helpers.

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Freeze Pack РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function freezeAuditPack(ctx: RequestContext, packId: string) {
    assertCanFreezePack(ctx);

    // ── Phase 1 (#2): attach the SoA snapshot as an EXPORT_ARTIFACT item
    // WHILE THE PACK IS STILL DRAFT — before the status flip in Phase 2. It
    // used to run AFTER the freeze, writing to an already-FROZEN pack.
    // `getSoA` opens its own tenant transactions, so it cannot run inside an
    // interactive transaction; the append therefore lands in a short,
    // ISOLATED transaction. Best-effort by design: a SoA failure (or the
    // not-yet-migrated EXPORT_ARTIFACT enum value, which the DB rejects) must
    // never abort the freeze — keeping it in its own try-caught transaction
    // is what guarantees that. The DRAFT + non-empty guards mirror Phase 2 so
    // nothing is ever written to a frozen or empty pack.
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
        await runInTenantContext(ctx, async (tdb) => {
            const pack = await tdb.auditPack.findFirst({
                where: { id: packId, tenantId: ctx.tenantId, deletedAt: null },
                select: { status: true, _count: { select: { items: true } } },
            });
            // Only append to a still-DRAFT, non-empty pack; Phase 2 is the
            // authority that raises the real not-found / already-frozen /
            // empty error to the caller.
            if (!pack || pack.status !== 'DRAFT' || pack._count.items === 0) return;
            await tdb.auditPackItem.create({
                data: {
                    tenantId: ctx.tenantId,
                    auditPackId: packId,
                    // EXPORT_ARTIFACT not yet in AuditPackItemEntityType enum; pending schema migration
                    entityType: 'EXPORT_ARTIFACT' as AuditPackItemEntityType,
                    entityId: `soa-${soaReport.framework}`,
                    snapshotJson: soaSnapshot,
                    sortOrder: pack._count.items + 1,
                },
            });
        });
    } catch { /* SoA attachment is best-effort */ }

    // ── Phase 2: snapshot every item + flip status → FROZEN in one transaction.
    // Extended 60s timeout because large packs (500+ items) need a snapshot
    // write per item. The source rows are BATCH-loaded (one findMany per
    // entity type) BEFORE the write loop — the previous code ran ~1 findFirst
    // per item inside this 60s transaction (an N+1). Snapshot failures are
    // COLLECTED and surfaced (#8) instead of being swallowed into a silent
    // '{}' while still reporting "frozen with N items".
    const frozen = await runInTenantContext(ctx, async (tdb) => {
        const pack = await tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId, deletedAt: null },
            include: { items: true },
        });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status !== 'DRAFT') throw badRequest('Pack is already frozen or exported');
        if (pack.items.length === 0) throw badRequest('Cannot freeze an empty pack');

        // Items still lacking a snapshot ('{}' or empty) need one built. Batch
        // one findMany per concrete entity type, then serialise from a map.
        const needing = pack.items.filter((it) => !it.snapshotJson || it.snapshotJson === '{}');
        const idsFor = (t: string) => needing.filter((it) => it.entityType === t).map((it) => it.entityId);
        const controlIds = idsFor('CONTROL');
        const policyIds = idsFor('POLICY');
        const evidenceIds = idsFor('EVIDENCE');
        const issueIds = idsFor('ISSUE');

        const [controls, policies, evidences, issues] = await Promise.all([
            controlIds.length
                ? tdb.control.findMany({
                    where: { id: { in: controlIds }, tenantId: ctx.tenantId },
                    include: {
                        tasks: { select: { id: true, title: true, status: true, dueAt: true } },
                        // Evidence↔Control is many-to-many; the snapshot only
                        // needs the linked-evidence count.
                        evidenceControlLinks: { where: { tenantId: ctx.tenantId }, select: { id: true } },
                        requirementLinks: { include: { requirement: { select: { code: true, title: true, frameworkId: true } } } },
                    },
                })
                : [],
            policyIds.length
                ? tdb.policy.findMany({
                    where: { id: { in: policyIds }, tenantId: ctx.tenantId },
                    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { versionNumber: true } } },
                })
                : [],
            evidenceIds.length
                ? tdb.evidence.findMany({ where: { id: { in: evidenceIds }, tenantId: ctx.tenantId } })
                : [],
            issueIds.length
                ? tdb.task.findMany({ where: { id: { in: issueIds }, tenantId: ctx.tenantId } })
                : [],
        ]);
        const controlMap = new Map(controls.map((c) => [c.id, c]));
        const policyMap = new Map(policies.map((p) => [p.id, p]));
        const evidenceMap = new Map(evidences.map((e) => [e.id, e]));
        const issueMap = new Map(issues.map((i) => [i.id, i]));

        // A "snapshot failure" = the item's source row was gone at freeze time.
        // The item still gets an explicit error-shape snapshot (so the pack
        // freezes and the auditor sees the missing source), and the item is
        // recorded here so the operator sees WHICH items degraded — the whole
        // point of #8. Any OTHER error (a batched read / the update itself
        // throwing) is no longer swallowed: it aborts the transaction loudly.
        const snapshotFailures: Array<{ itemId: string; entityType: string; entityId: string; reason: string }> = [];

        for (const item of needing) {
            let snapshot: string;
            switch (item.entityType) {
                case 'CONTROL': {
                    const rec = controlMap.get(item.entityId);
                    if (!rec) {
                        snapshot = JSON.stringify({ error: 'Control not found', entityId: item.entityId });
                        snapshotFailures.push({ itemId: item.id, entityType: item.entityType, entityId: item.entityId, reason: 'Control not found' });
                    } else {
                        snapshot = JSON.stringify({
                            code: rec.code, name: rec.name, status: rec.status,
                            objective: rec.objective,
                            owner: rec.ownerUserId,
                            taskCompletion: { total: rec.tasks.length, done: rec.tasks.filter((t) => t.status === TaskStatus.RESOLVED || t.status === TaskStatus.CLOSED).length },
                            evidenceCount: rec.evidenceControlLinks.length,
                            mappedRequirements: (rec.requirementLinks || []).map((l) => ({ code: l.requirement.code, title: l.requirement.title })),
                            snapshotAt: new Date().toISOString(),
                        });
                    }
                    break;
                }
                case 'POLICY': {
                    const rec = policyMap.get(item.entityId);
                    if (!rec) {
                        snapshot = JSON.stringify({ error: 'Policy not found', entityId: item.entityId });
                        snapshotFailures.push({ itemId: item.id, entityType: item.entityType, entityId: item.entityId, reason: 'Policy not found' });
                    } else {
                        snapshot = JSON.stringify({
                            title: rec.title, status: rec.status, category: rec.category,
                            currentVersion: rec.versions[0]?.versionNumber,
                            snapshotAt: new Date().toISOString(),
                        });
                    }
                    break;
                }
                case 'EVIDENCE': {
                    const rec = evidenceMap.get(item.entityId);
                    if (!rec) {
                        snapshot = JSON.stringify({ error: 'Evidence not found', entityId: item.entityId });
                        snapshotFailures.push({ itemId: item.id, entityType: item.entityType, entityId: item.entityId, reason: 'Evidence not found' });
                    } else {
                        snapshot = JSON.stringify({
                            title: rec.title, type: rec.type, status: rec.status,
                            snapshotAt: new Date().toISOString(),
                        });
                    }
                    break;
                }
                case 'ISSUE': {
                    const rec = issueMap.get(item.entityId);
                    if (!rec) {
                        snapshot = JSON.stringify({ error: 'Issue not found', entityId: item.entityId });
                        snapshotFailures.push({ itemId: item.id, entityType: item.entityType, entityId: item.entityId, reason: 'Issue not found' });
                    } else {
                        snapshot = JSON.stringify({
                            title: rec.title, type: rec.type, severity: rec.severity,
                            status: rec.status, dueAt: rec.dueAt,
                            snapshotAt: new Date().toISOString(),
                        });
                    }
                    break;
                }
                default:
                    snapshot = JSON.stringify({ entityType: item.entityType, entityId: item.entityId, snapshotAt: new Date().toISOString() });
            }
            await tdb.auditPackItem.update({ where: { id: item.id }, data: { snapshotJson: snapshot } });
        }

        const result = await tdb.auditPack.update({
            where: { id: packId },
            data: { status: 'FROZEN', frozenAt: new Date(), frozenByUserId: ctx.userId },
        });

        await logEvent(tdb, ctx, { action: 'AUDIT_PACK_FROZEN', entityType: 'AuditPack', entityId: packId, details: JSON.stringify({ itemCount: pack.items.length, snapshotFailures: snapshotFailures.length }), detailsJson: { category: 'status_change', entityName: 'AuditPack', fromStatus: 'DRAFT', toStatus: 'FROZEN', reason: `Pack frozen with ${pack.items.length} items${snapshotFailures.length ? `; ${snapshotFailures.length} snapshot failure(s)` : ''}` } });

        return { frozenPack: result, snapshotFailures };
    }, { timeout: 60000, maxWait: 10000 });

    await bumpEntityCacheVersion(ctx, 'audit');
    // #8 — surface snapshot failures alongside the frozen pack so the caller
    // (and the operator) can see exactly which items did not snapshot cleanly,
    // instead of a silent "frozen with N items".
    return { ...frozen.frozenPack, snapshotFailures: frozen.snapshotFailures };
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
                // Bounded — feeds a deduped id set into the control.findMany
                // below (itself take:2000); a framework never has this many links.
                take: 5000,
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
            where: { tenantId: ctx.tenantId, status: { notIn: [...TERMINAL_TASK_STATUSES] } },
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

    const csv = toCsv(rows);
    return { csv, filename: `${pack.name.replace(/\s+/g, '-')}-audit-pack.csv` };
}
