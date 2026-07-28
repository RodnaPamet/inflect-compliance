/**
 * Evidence Bundle + Subprocessor Usecases
 */
import { RequestContext } from '../types';
import { Prisma } from '@prisma/client';
import { assertCanManageVendors, assertCanReadVendors, assertCanManageVendorDocs, assertCanExportVendors } from '../policies/vendor.policies';
import { assertBundleTargetInTenant } from './vendor-link-targets';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';

// ─── Evidence Bundles ───

export async function listEvidenceBundles(ctx: RequestContext, vendorId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) =>
        db.vendorEvidenceBundle.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            include: { createdBy: { select: { id: true, name: true } }, _count: { select: { items: true } } },
            orderBy: { createdAt: 'desc' },
        })
    );
}

export async function createEvidenceBundle(ctx: RequestContext, vendorId: string, input: { name: string; description?: string }) {
    assertCanManageVendorDocs(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await db.vendorEvidenceBundle.create({
            data: { tenantId: ctx.tenantId, vendorId, name: input.name, description: input.description, createdByUserId: ctx.userId },
        });
        await logEvent(db, ctx, {
            action: 'VENDOR_EVIDENCE_BUNDLE_CREATED',
            entityType: 'Vendor',
            entityId: vendorId,
            details: `Evidence bundle "${input.name}" created`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'VendorEvidenceBundle', operation: 'created', after: { name: input.name, vendorId }, summary: `Evidence bundle "${input.name}" created` },
            metadata: { bundleId: bundle.id },
        });
        return bundle;
    });
}

export async function addBundleItem(ctx: RequestContext, bundleId: string, item: { entityType: string; entityId: string }) {
    assertCanManageVendorDocs(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await db.vendorEvidenceBundle.findFirst({ where: { id: bundleId, tenantId: ctx.tenantId } });
        if (!bundle) throw notFound('Bundle not found');
        if (bundle.frozenAt) throw badRequest('Cannot add items to a frozen bundle');

        // The item row carries ctx.tenantId, but nothing checked the id it
        // POINTS AT. freezeBundle later tenant-scopes its snapshot lookup,
        // so a foreign entityId produced an EMPTY snapshot with no error at
        // all — fail-silent, which is worse than fail-closed for a frozen
        // audit artefact that is supposed to be evidence.
        await assertBundleTargetInTenant(db, ctx, item.entityType, item.entityId);

        const bundleItem = await db.vendorEvidenceBundleItem.create({
            data: { bundleId, tenantId: ctx.tenantId, entityType: item.entityType, entityId: item.entityId },
        });
        return bundleItem;
    });
}

export async function removeBundleItem(ctx: RequestContext, bundleId: string, itemId: string) {
    assertCanManageVendorDocs(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await db.vendorEvidenceBundle.findFirst({ where: { id: bundleId, tenantId: ctx.tenantId } });
        if (!bundle) throw notFound('Bundle not found');
        if (bundle.frozenAt) throw badRequest('Cannot remove items from a frozen bundle');

        const item = await db.vendorEvidenceBundleItem.deleteMany({ where: { id: itemId, bundleId } });
        if (item.count === 0) throw notFound('Item not found');
        return { deleted: true };
    });
}

export async function freezeBundle(ctx: RequestContext, bundleId: string) {
    assertCanManageVendorDocs(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await db.vendorEvidenceBundle.findFirst({
            where: { id: bundleId, tenantId: ctx.tenantId },
            include: { items: true },
        });
        if (!bundle) throw notFound('Bundle not found');
        if (bundle.frozenAt) throw badRequest('Bundle is already frozen');
        if (bundle.items.length === 0) throw badRequest('Cannot freeze an empty bundle');

        // Freeze: snapshot entity metadata into each item
        for (const item of bundle.items) {
            let snapshot:
                | { type: string; title: string | null; externalUrl: string | null; validTo: Date | null }
                | { status: string; score: number | null; riskRating: string | null; startedAt: Date }
                | null = null;
            if (item.entityType === 'VENDOR_DOCUMENT') {
                const doc = await db.vendorDocument.findFirst({ where: { id: item.entityId, tenantId: ctx.tenantId } });
                if (doc) snapshot = { type: doc.type, title: doc.title, externalUrl: doc.externalUrl, validTo: doc.validTo };
            } else if (item.entityType === 'ASSESSMENT') {
                const a = await db.vendorAssessment.findFirst({ where: { id: item.entityId, tenantId: ctx.tenantId } });
                if (a) snapshot = { status: a.status, score: a.score, riskRating: a.riskRating, startedAt: a.startedAt };
            }
            if (snapshot) {
                await db.vendorEvidenceBundleItem.update({ where: { id: item.id }, data: { snapshotJson: snapshot as Prisma.InputJsonValue } });
            }
        }

        const frozen = await db.vendorEvidenceBundle.update({
            where: { id: bundleId },
            data: { frozenAt: new Date() },
            include: { items: true, createdBy: { select: { id: true, name: true } } },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_EVIDENCE_BUNDLE_FROZEN',
            entityType: 'Vendor',
            entityId: bundle.vendorId,
            details: `Evidence bundle "${bundle.name}" frozen with ${bundle.items.length} items`,
            detailsJson: { category: 'status_change', entityName: 'VendorEvidenceBundle', fromStatus: 'DRAFT', toStatus: 'FROZEN', reason: `Frozen with ${bundle.items.length} items` },
            metadata: { bundleId, itemCount: bundle.items.length },
        });

        return frozen;
    });
}

export async function getEvidenceBundle(ctx: RequestContext, bundleId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await db.vendorEvidenceBundle.findFirst({
            where: { id: bundleId, tenantId: ctx.tenantId },
            include: { items: true, createdBy: { select: { id: true, name: true } }, vendor: { select: { id: true, name: true } } },
        });
        if (!bundle) throw notFound('Bundle not found');
        return bundle;
    });
}

// ─── Subprocessors ───

export async function listSubprocessors(ctx: RequestContext, vendorId: string) {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, (db) =>
        db.vendorRelationship.findMany({
            where: { tenantId: ctx.tenantId, primaryVendorId: vendorId },
            include: { subprocessor: { select: { id: true, name: true, country: true, criticality: true, inherentRisk: true } } },
            orderBy: { createdAt: 'desc' },
        })
    );
}

export interface SubprocessorChainNode {
    id: string;
    name: string;
    country: string | null;
    criticality: string;
    inherentRisk: string | null;
    depth: number;
    /** True when this node repeats an ancestor on the path (cycle) — not expanded further. */
    cyclical?: boolean;
    subprocessors: SubprocessorChainNode[];
}

/**
 * Recursive nth-party (4th-party and beyond) subprocessor chain for a vendor.
 * Walks the `VendorRelationship` graph transitively, bounded by `maxDepth`
 * and cycle-safe (a vendor already on the ancestor path is marked `cyclical`
 * and not expanded). Loads the tenant's relationship edges in ONE query and
 * builds the tree in memory — no per-node round-trip.
 */
export async function listSubprocessorChain(
    ctx: RequestContext,
    vendorId: string,
    maxDepth = 4,
): Promise<SubprocessorChainNode> {
    assertCanReadVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const root = await db.vendor.findFirst({
            where: { id: vendorId, tenantId: ctx.tenantId },
            select: { id: true, name: true, country: true, criticality: true, inherentRisk: true },
        });
        if (!root) throw notFound('Vendor not found');

        const rels = await db.vendorRelationship.findMany({
            where: { tenantId: ctx.tenantId },
            include: { subprocessor: { select: { id: true, name: true, country: true, criticality: true, inherentRisk: true } } },
            take: 5000,
        });
        const adjacency = new Map<string, typeof rels>();
        for (const r of rels) {
            const list = adjacency.get(r.primaryVendorId) ?? [];
            list.push(r);
            adjacency.set(r.primaryVendorId, list);
        }

        type V = { id: string; name: string; country: string | null; criticality: string; inherentRisk: string | null };
        const build = (v: V, depth: number, ancestors: Set<string>): SubprocessorChainNode => {
            const node: SubprocessorChainNode = { ...v, depth, subprocessors: [] };
            if (depth >= maxDepth) return node;
            for (const r of adjacency.get(v.id) ?? []) {
                const child = r.subprocessor;
                if (ancestors.has(child.id)) {
                    node.subprocessors.push({ ...child, depth: depth + 1, cyclical: true, subprocessors: [] });
                    continue;
                }
                node.subprocessors.push(build(child, depth + 1, new Set([...ancestors, child.id])));
            }
            return node;
        };
        return build(root, 0, new Set([root.id]));
    });
}

export async function addSubprocessor(ctx: RequestContext, vendorId: string, input: { subprocessorVendorId: string; purpose?: string; dataTypes?: string; country?: string }) {
    assertCanManageVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        if (input.subprocessorVendorId === vendorId) throw badRequest('A vendor cannot be its own subprocessor');
        const sub = await db.vendor.findFirst({ where: { id: input.subprocessorVendorId, tenantId: ctx.tenantId } });
        if (!sub) throw notFound('Subprocessor vendor not found');
        // The TARGET was validated above; the PRIMARY never was. vendorId
        // comes straight off the URL path and is written as primaryVendorId,
        // so a foreign primary would anchor a relationship row in this
        // tenant pointing at a vendor this tenant cannot see.
        const primary = await db.vendor.findFirst({
            where: { id: vendorId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!primary) throw notFound('Vendor not found');

        const rel = await db.vendorRelationship.create({
            data: {
                tenantId: ctx.tenantId,
                primaryVendorId: vendorId,
                subprocessorVendorId: input.subprocessorVendorId,
                purpose: input.purpose,
                dataTypes: input.dataTypes,
                country: input.country,
            },
            include: { subprocessor: { select: { id: true, name: true, country: true, criticality: true } } },
        });
        await logEvent(db, ctx, {
            action: 'VENDOR_SUBPROCESSOR_ADDED',
            entityType: 'Vendor',
            entityId: vendorId,
            details: `Subprocessor "${sub.name}" added`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Vendor', sourceId: vendorId, targetEntity: 'Vendor', targetId: sub.id, relation: 'subprocessor' },
            metadata: { relationId: rel.id, subprocessorId: sub.id },
        });
        return rel;
    });
}

export async function removeSubprocessor(ctx: RequestContext, relationId: string) {
    assertCanManageVendors(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rel = await db.vendorRelationship.findFirst({ where: { id: relationId, tenantId: ctx.tenantId } });
        if (!rel) throw notFound('Relationship not found');
        await db.vendorRelationship.delete({ where: { id: relationId } });
        await logEvent(db, ctx, {
            action: 'VENDOR_SUBPROCESSOR_REMOVED',
            entityType: 'Vendor',
            entityId: rel.primaryVendorId,
            details: 'Subprocessor relationship removed',
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Vendor', sourceId: rel.primaryVendorId, targetEntity: 'Vendor', targetId: rel.subprocessorVendorId, relation: 'subprocessor' },
            metadata: { relationId },
        });
        return { deleted: true };
    });
}

// ─── Exports ───

export async function exportVendorsRegister(ctx: RequestContext) {
    assertCanExportVendors(ctx);
    return runInTenantContext(ctx, (db) =>
        db.vendor.findMany({
            take: 10000,
            where: { tenantId: ctx.tenantId },
            select: {
                id: true, name: true, legalName: true, status: true, criticality: true,
                inherentRisk: true, country: true, domain: true, isSubprocessor: true,
                nextReviewAt: true, contractRenewalAt: true, dataAccess: true, createdAt: true,
            },
            orderBy: { name: 'asc' },
        })
    );
}

export async function exportAssessments(ctx: RequestContext) {
    assertCanExportVendors(ctx);
    return runInTenantContext(ctx, (db) =>
        db.vendorAssessment.findMany({
            take: 10000,
            where: { tenantId: ctx.tenantId },
            select: {
                id: true, vendorId: true, status: true, score: true, riskRating: true,
                startedAt: true, submittedAt: true, decidedAt: true,
                vendor: { select: { name: true } },
                requestedBy: { select: { name: true } },
            },
            orderBy: { startedAt: 'desc' },
        })
    );
}

export async function exportDocumentExpiry(ctx: RequestContext) {
    assertCanExportVendors(ctx);
    return runInTenantContext(ctx, (db) =>
        db.vendorDocument.findMany({
            take: 10000,
            where: { tenantId: ctx.tenantId, validTo: { not: null } },
            select: {
                id: true, type: true, title: true, validTo: true, externalUrl: true,
                vendor: { select: { id: true, name: true } },
            },
            orderBy: { validTo: 'asc' },
        })
    );
}
