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
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { TERMINAL_TASK_STATUSES } from '../../domain/task-status';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { coverageQualifyingEvidenceWhere } from '@/lib/compliance/coverage-evidence';
import { frameworkHasStatementOfApplicability } from '@/lib/compliance/statement-of-applicability';
import { toCsv } from '@/lib/csv/format-csv';
import { logger } from '@/lib/observability/logger';

/**
 * The item types that reference ONE owned row (ISSUE → Task). Their snapshot is
 * that row as it stood at freeze, built by `freezeAuditPack` and by nothing
 * else; the other types (READINESS_REPORT, FRAMEWORK_COVERAGE, FILE, TEST_RUN)
 * carry a computed artefact whose snapshot IS the content, written when the
 * item is attached.
 */
const ROW_BACKED_ITEM_TYPES: ReadonlySet<string> = new Set(['CONTROL', 'POLICY', 'EVIDENCE', 'ISSUE']);

/** The name a stored snapshot carries, the same fields every pack view reads. */
function snapshotName(snapshotJson: string | null | undefined): string | null {
    try {
        const snap = JSON.parse(snapshotJson || '{}') as { code?: unknown; title?: unknown; name?: unknown };
        const name = snap.code || snap.title || snap.name;
        return typeof name === 'string' && name.trim() !== '' ? name : null;
    } catch {
        return null;
    }
}

/**
 * #4129 — the live names of a pack's row-backed items that carry no name of
 * their own yet: a draft's items are stored with an empty snapshot until the
 * freeze, so the page listed them by raw id. One batched read per type, inside
 * the caller's transaction. Soft-deleted rows still answer: the name is a label
 * for the reader, and the freeze reports the missing source separately.
 */
async function resolveItemNames(
    tdb: PrismaTx,
    tenantId: string,
    items: ReadonlyArray<{ id: string; entityType: string; entityId: string; snapshotJson: string | null }>,
): Promise<Map<string, string>> {
    const unnamed = items.filter((it) => ROW_BACKED_ITEM_TYPES.has(it.entityType) && snapshotName(it.snapshotJson) === null);
    const idsOf = (t: string) => [...new Set(unnamed.filter((it) => it.entityType === t).map((it) => it.entityId))];
    const controlIds = idsOf('CONTROL');
    const policyIds = idsOf('POLICY');
    const evidenceIds = idsOf('EVIDENCE');
    const issueIds = idsOf('ISSUE');
    const [controls, policies, evidence, tasks] = await Promise.all([
        controlIds.length ? tdb.control.findMany({ where: { id: { in: controlIds }, tenantId }, select: { id: true, code: true, name: true }, take: controlIds.length }) : [],
        policyIds.length ? tdb.policy.findMany({ where: { id: { in: policyIds }, tenantId }, select: { id: true, title: true }, take: policyIds.length }) : [],
        evidenceIds.length ? tdb.evidence.findMany({ where: { id: { in: evidenceIds }, tenantId }, select: { id: true, title: true }, take: evidenceIds.length }) : [],
        issueIds.length ? tdb.task.findMany({ where: { id: { in: issueIds }, tenantId }, select: { id: true, title: true }, take: issueIds.length }) : [],
    ]);
    // The same field a frozen snapshot is read by: a control's code where it
    // has one, so a draft row and its frozen row read alike.
    const byType: Record<string, Map<string, string>> = {
        CONTROL: new Map(controls.map((c) => [c.id, c.code || c.name])),
        POLICY: new Map(policies.map((p) => [p.id, p.title])),
        EVIDENCE: new Map(evidence.map((e) => [e.id, e.title])),
        ISSUE: new Map(tasks.map((t) => [t.id, t.title])),
    };
    const names = new Map<string, string>();
    for (const it of unnamed) {
        const name = byType[it.entityType]?.get(it.entityId);
        if (name) names.set(it.id, name);
    }
    return names;
}

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
    const pack = await runInTenantContext(ctx, async (tdb) => {
        const row = await tdb.auditPack.findFirst({
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
        });
        if (!row) return null;
        // `displayName` — the live name of an item whose snapshot names
        // nothing yet (every row-backed item of a draft). A frozen item's
        // snapshot is the record and is read first; this is the fallback.
        const names = await resolveItemNames(tdb, ctx.tenantId, row.items ?? []);
        return { ...row, items: (row.items ?? []).map((it) => ({ ...it, displayName: names.get(it.id) ?? null })) };
    });
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
            // #4129 — a row-backed item's snapshot is built by the freeze from
            // the source row, never taken from the caller. The pack page used
            // to send `{ title }` here, and because the freeze kept any
            // non-empty snapshot, the frozen item carried its title and
            // nothing else — and a caller could have put any content in front
            // of the auditor under a real control's id.
            snapshotJson: ROW_BACKED_ITEM_TYPES.has(item.entityType) ? '{}' : (item.snapshotJson || '{}'),
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

/**
 * #4129 — take one item out of a DRAFT pack. Same writers as adding (OWNER,
 * ADMIN, EDITOR); a frozen or exported pack is immutable and refuses.
 *
 * The DRAFT check is re-asserted by a predicated `updateMany` on the pack row
 * in the same transaction as the delete, the interlock `storeExportArtifact`
 * uses: it takes the pack's row lock, so a freeze committing in between makes
 * it match nothing and refuse, and a freeze that has not yet flipped the status
 * waits for this transaction rather than snapshotting an item that is leaving.
 */
export async function removeAuditPackItem(ctx: RequestContext, packId: string, itemId: string) {
    assertCanManageAuditPacks(ctx);
    const outcome = await runInTenantContext(ctx, async (tdb) => {
        const pack = await tdb.auditPack.findFirst({
            where: { id: packId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true },
        });
        if (!pack) throw notFound('Audit pack not found');
        if (pack.status !== 'DRAFT') throw badRequest('Cannot remove items from a frozen or exported pack');
        const item = await tdb.auditPackItem.findFirst({
            where: { id: itemId, auditPackId: packId, tenantId: ctx.tenantId },
            select: { id: true, entityType: true, entityId: true },
        });
        if (!item) throw notFound('Pack item not found');

        const stillDraft = await tdb.auditPack.updateMany({
            where: { id: packId, tenantId: ctx.tenantId, status: 'DRAFT' },
            data: { updatedAt: new Date() },
        });
        if (stillDraft.count === 0) throw badRequest('Cannot remove items from a frozen or exported pack');
        await tdb.auditPackItem.delete({ where: { id: item.id } });

        await logEvent(tdb, ctx, {
            action: 'AUDIT_PACK_ITEM_REMOVED',
            entityType: 'AuditPack',
            entityId: packId,
            details: JSON.stringify({ itemId: item.id, entityType: item.entityType, entityId: item.entityId }),
            detailsJson: {
                category: 'relationship',
                operation: 'unlinked',
                sourceEntity: 'AuditPack',
                sourceId: packId,
                targetEntity: item.entityType,
                targetId: item.entityId,
                relation: 'pack_item',
            },
        });
        return { removed: true, itemId: item.id };
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

/** Options for {@link freezeAuditPack}. */
export interface FreezeAuditPackOptions {
    /**
     * Attach the cycle framework's Statement of Applicability before freezing.
     * Default true. The reliance pack passes false: what it holds is decided by
     * its planner alone (`agent-audit-reliance.ts`).
     */
    readonly attachStatementOfApplicability?: boolean;
}

/** `AuditPackItem.entityId` of the Statement of Applicability a freeze attaches. */
export function soaItemEntityId(frameworkKey: string): string {
    return `soa-${frameworkKey}`;
}

/**
 * Attach the Statement of Applicability of the pack's cycle framework as an
 * item, WHILE THE PACK IS STILL DRAFT (Phase 1 of the freeze).
 *
 * #4129 — this used to insert an item of type `EXPORT_ARTIFACT`, a value
 * `AuditPackItemEntityType` has never had, inside a `catch {}`, so the database
 * refused it on every freeze and nothing said so: no pack ever carried its SoA.
 * Adding the value would be a two-deploy enum migration (a running container
 * whose client predates a value fails every read of a row carrying it), and an
 * existing value already says what this is: `FRAMEWORK_COVERAGE`. A Statement
 * of Applicability is the framework's coverage, requirement by requirement —
 * whether it applies, how far it is implemented, which controls cover it. The
 * snapshot's `type: 'SOA_REPORT'` tells it apart from the reliance pack's
 * summary item, which shares the type.
 *
 * Two more corrections: the SoA is now the CYCLE's framework (`getSoA` with no
 * `framework` reports on whatever the workspace installed, ISO 27001 first,
 * whatever the cycle is about), and only for a framework that has one
 * (`frameworkHasStatementOfApplicability`). It is an upsert on the item's
 * unique key, so a pack cloned for retest, which carries the old SoA item
 * forward, gets it refreshed rather than a duplicate refused.
 *
 * Still best-effort — an SoA that cannot be built must not stop the freeze —
 * but a failure is now logged with the pack and the framework.
 */
async function attachStatementOfApplicability(ctx: RequestContext, packId: string): Promise<void> {
    let frameworkKey: string | undefined;
    try {
        const pack = await runInTenantContext(ctx, (tdb) =>
            tdb.auditPack.findFirst({
                where: { id: packId, tenantId: ctx.tenantId, deletedAt: null },
                select: { status: true, _count: { select: { items: true } }, cycle: { select: { frameworkKey: true } } },
            }),
        );
        // Only a still-DRAFT, non-empty pack; Phase 2 is the authority that
        // raises the real not-found / already-frozen / empty error.
        if (!pack || pack.status !== 'DRAFT' || !pack._count?.items) return;
        frameworkKey = pack.cycle?.frameworkKey;
        if (!frameworkKey || !frameworkHasStatementOfApplicability(frameworkKey)) return;

        const { getSoA } = await import('../soa');
        const soaReport = await getSoA(ctx, {
            framework: frameworkKey,
            includeEvidence: true,
            includeTasks: true,
            includeTests: true,
        });
        const snapshotJson = JSON.stringify({
            type: 'SOA_REPORT',
            title: `Statement of Applicability — ${soaReport.frameworkName || soaReport.framework}`,
            framework: soaReport.framework,
            frameworkName: soaReport.frameworkName,
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
        const entityId = soaItemEntityId(frameworkKey);
        const sortOrder = pack._count.items + 1;
        await runInTenantContext(ctx, async (tdb) => {
            // The predicated write takes the pack's row lock, so a freeze that
            // committed meanwhile makes this match nothing and attach nothing.
            const stillDraft = await tdb.auditPack.updateMany({
                where: { id: packId, tenantId: ctx.tenantId, status: 'DRAFT' },
                data: { updatedAt: new Date() },
            });
            if (stillDraft.count === 0) return;
            await tdb.auditPackItem.upsert({
                where: { auditPackId_entityType_entityId: { auditPackId: packId, entityType: 'FRAMEWORK_COVERAGE', entityId } },
                create: {
                    tenantId: ctx.tenantId,
                    auditPackId: packId,
                    entityType: 'FRAMEWORK_COVERAGE',
                    entityId,
                    snapshotJson,
                    sortOrder,
                },
                update: { snapshotJson },
            });
        });
    } catch (err) {
        logger.warn('audit pack freeze: Statement of Applicability not attached', {
            component: 'audit-pack-freeze',
            packId,
            frameworkKey,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Whether the freeze must (re)build this item's snapshot. Any item with none;
 * and a row-backed item whose snapshot the server did not build — every
 * builder below stamps `snapshotAt`, and a caller-supplied one (the `{ title }`
 * the pack page used to send, still stored on drafts made before #4129) lacks
 * it. A computed artefact's snapshot is its content and is kept.
 */
function needsSnapshot(item: { entityType: string; snapshotJson: string | null }): boolean {
    if (!item.snapshotJson || item.snapshotJson === '{}') return true;
    if (!ROW_BACKED_ITEM_TYPES.has(item.entityType)) return false;
    try {
        const parsed: unknown = JSON.parse(item.snapshotJson);
        return !(parsed && typeof parsed === 'object' && typeof (parsed as { snapshotAt?: unknown }).snapshotAt === 'string');
    } catch {
        return true;
    }
}

export async function freezeAuditPack(ctx: RequestContext, packId: string, opts: FreezeAuditPackOptions = {}) {
    assertCanFreezePack(ctx);

    // ── Phase 1 (#2, #4129): attach the cycle framework's Statement of
    // Applicability WHILE THE PACK IS STILL DRAFT — before the status flip in
    // Phase 2. `getSoA` opens its own tenant transactions, so it cannot run
    // inside an interactive transaction; the append lands in a short,
    // isolated one. See `attachStatementOfApplicability`.
    if (opts.attachStatementOfApplicability !== false) {
        await attachStatementOfApplicability(ctx, packId);
    }

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

        // Items still lacking a server-built snapshot need one (`needsSnapshot`).
        // Batch one findMany per concrete entity type, then serialise from a map.
        const needing = pack.items.filter(needsSnapshot);
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

    // #4129 — every framework a cycle can be on has a default pack. This used
    // to refuse anything but ISO27001 and NIS2, and nothing else in the page
    // builds a pack, so a cycle on any other framework could never get one.
    // The selection is framework-neutral (mapped controls, their evidence,
    // open tasks); only the policy keyword bias is framework-specific.
    return buildCuratedDefaultPack(
        ctx,
        cycle.frameworkKey,
        DEFAULT_PACK_POLICY_KEYWORDS.get(cycle.frameworkKey) ?? null,
    );
}

/**
 * The frameworks whose default pack prefers policies by keyword. Any other
 * framework takes every published policy: there is no keyword list that is
 * right for a framework nobody has written one for.
 */
const DEFAULT_PACK_POLICY_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
    ['ISO27001', ['security', 'information security', 'access control']],
    ['NIS2', ['incident', 'business continuity', 'disaster recovery', 'access control', 'supplier', 'supply chain']],
]);

/**
 * Curated default-pack selection shared by every framework.
 * `policyKeywords` biases policy selection toward framework-relevant
 * titles/categories among the PUBLISHED set; `null` takes them all.
 */
async function buildCuratedDefaultPack(ctx: RequestContext, frameworkKey: string, policyKeywords: readonly string[] | null) {
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
    const relevantPolicies = policyKeywords === null ? policies : policies.filter((p) => {
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
