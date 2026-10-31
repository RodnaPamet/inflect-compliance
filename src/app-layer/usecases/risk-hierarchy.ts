/**
 * RQ-5 — risk aggregation & hierarchy.
 *
 * Tenant-defined org trees (BU / geography / asset class) with M:N risk
 * membership, and recursive ALE roll-up so executives see where loss
 * concentrates. A risk in two child nodes is counted ONCE at the parent.
 *
 * The roll-up is a pure function (`aggregateTree`) — unit-testable.
 *
 * @module usecases/risk-hierarchy
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { resolveALE } from './fair-calculator';

export interface HierarchyAggregation {
    nodeId: string;
    nodeName: string;
    riskCount: number;
    totalAle: number;
    /**
     * #4772 — the risks attached to THIS node (not its children), so the page
     * can show what a node holds and detach one; it used to show only a count.
     */
    risks: Array<{ id: string; title: string }>;
    children: HierarchyAggregation[];
}

interface NodeLite { id: string; name: string }

/**
 * Recursively aggregate ALE under each root (pure). Risks are deduped by
 * id across the subtree, so a risk linked to two children is counted once
 * at the parent.
 */
export function aggregateTree(
    roots: NodeLite[],
    childrenByParent: Map<string, NodeLite[]>,
    riskIdsByNode: Map<string, string[]>,
    aleByRisk: Map<string, number>,
    titleByRisk: Map<string, string> = new Map(),
): HierarchyAggregation[] {
    function visit(node: NodeLite): { agg: HierarchyAggregation; riskIds: Set<string> } {
        const childResults = (childrenByParent.get(node.id) ?? []).map(visit);
        const riskIds = new Set<string>(riskIdsByNode.get(node.id) ?? []);
        for (const cr of childResults) cr.riskIds.forEach((id) => riskIds.add(id));
        let totalAle = 0;
        riskIds.forEach((id) => { totalAle += aleByRisk.get(id) ?? 0; });
        return {
            agg: {
                nodeId: node.id,
                nodeName: node.name,
                riskCount: riskIds.size,
                totalAle,
                risks: (riskIdsByNode.get(node.id) ?? []).map((id) => ({ id, title: titleByRisk.get(id) ?? '' })),
                children: childResults.map((c) => c.agg),
            },
            riskIds,
        };
    }
    return roots.map((r) => visit(r).agg);
}

// ── CRUD ──────────────────────────────────────────────────────────────

export async function createNode(ctx: RequestContext, input: { name: string; type: string; parentId?: string | null; sortOrder?: number }) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, (db) =>
        db.riskHierarchyNode.create({
            data: { tenantId: ctx.tenantId, name: input.name, type: input.type, parentId: input.parentId ?? null, sortOrder: input.sortOrder ?? 0 },
        }),
    );
}

export async function updateNode(ctx: RequestContext, nodeId: string, patch: { name?: string; parentId?: string | null; sortOrder?: number }) {
    assertCanWrite(ctx);
    if (patch.parentId === nodeId) throw badRequest('A node cannot be its own parent');
    await runInTenantContext(ctx, (db) =>
        db.riskHierarchyNode.updateMany({
            where: { id: nodeId, tenantId: ctx.tenantId },
            data: { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}), ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}) },
        }),
    );
}

export async function deleteNode(ctx: RequestContext, nodeId: string) {
    assertCanWrite(ctx);
    await runInTenantContext(ctx, (db) => db.riskHierarchyNode.deleteMany({ where: { id: nodeId, tenantId: ctx.tenantId } }));
}

export async function getTree(ctx: RequestContext, type: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.riskHierarchyNode.findMany({ where: { tenantId: ctx.tenantId, type }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 5000 }),
    );
}

export async function linkRisk(ctx: RequestContext, riskId: string, nodeId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const node = await db.riskHierarchyNode.findFirst({ where: { id: nodeId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!node) throw notFound('Hierarchy node not found');
        await db.riskHierarchyLink.upsert({
            where: { tenantId_riskId_nodeId: { tenantId: ctx.tenantId, riskId, nodeId } },
            create: { tenantId: ctx.tenantId, riskId, nodeId },
            update: {},
        });
    });
}

export async function unlinkRisk(ctx: RequestContext, riskId: string, nodeId: string) {
    assertCanWrite(ctx);
    await runInTenantContext(ctx, (db) => db.riskHierarchyLink.deleteMany({ where: { tenantId: ctx.tenantId, riskId, nodeId } }));
}

// ── Aggregation ───────────────────────────────────────────────────────

interface LoadedTree {
    roots: NodeLite[];
    childrenByParent: Map<string, NodeLite[]>;
    riskIdsByNode: Map<string, string[]>;
    aleByRisk: Map<string, number>;
    titleByRisk: Map<string, string>;
}

async function loadTree(ctx: RequestContext, type: string): Promise<LoadedTree> {
    return runInTenantContext(ctx, async (db) => {
        const nodes = await db.riskHierarchyNode.findMany({ where: { tenantId: ctx.tenantId, type }, select: { id: true, name: true, parentId: true }, take: 5000 });
        const nodeIds = nodes.map((n) => n.id);
        const links = nodeIds.length
            ? await db.riskHierarchyLink.findMany({ where: { tenantId: ctx.tenantId, nodeId: { in: nodeIds } }, select: { nodeId: true, riskId: true }, take: 50000 })
            : [];
        const riskIds = Array.from(new Set(links.map((l) => l.riskId)));
        const risks = riskIds.length
            ? await db.risk.findMany({ where: { tenantId: ctx.tenantId, id: { in: riskIds } }, select: { id: true, title: true, fairAle: true, sleAmount: true, aroAmount: true } })
            : [];

        const childrenByParent = new Map<string, NodeLite[]>();
        const roots: NodeLite[] = [];
        for (const n of nodes) {
            const lite = { id: n.id, name: n.name };
            if (n.parentId) {
                const arr = childrenByParent.get(n.parentId) ?? [];
                arr.push(lite);
                childrenByParent.set(n.parentId, arr);
            } else {
                roots.push(lite);
            }
        }
        const riskIdsByNode = new Map<string, string[]>();
        for (const l of links) {
            const arr = riskIdsByNode.get(l.nodeId) ?? [];
            arr.push(l.riskId);
            riskIdsByNode.set(l.nodeId, arr);
        }
        const aleByRisk = new Map<string, number>();
        const titleByRisk = new Map<string, string>();
        for (const r of risks) {
            aleByRisk.set(r.id, resolveALE({ fairAle: r.fairAle, sleAmount: r.sleAmount, aroAmount: r.aroAmount }) ?? 0);
            titleByRisk.set(r.id, r.title);
        }
        return { roots, childrenByParent, riskIdsByNode, aleByRisk, titleByRisk };
    });
}

/** Full treemap data — all roots of a type with recursive aggregation. */
export async function getTreemapData(ctx: RequestContext, type: string): Promise<HierarchyAggregation[]> {
    assertCanRead(ctx);
    const t = await loadTree(ctx, type);
    return aggregateTree(t.roots, t.childrenByParent, t.riskIdsByNode, t.aleByRisk, t.titleByRisk);
}

/** Aggregation rooted at a single node. */
export async function aggregateByHierarchy(ctx: RequestContext, nodeId: string): Promise<HierarchyAggregation> {
    assertCanRead(ctx);
    const node = await runInTenantContext(ctx, (db) => db.riskHierarchyNode.findFirst({ where: { id: nodeId, tenantId: ctx.tenantId }, select: { id: true, name: true, type: true } }));
    if (!node) throw notFound('Hierarchy node not found');
    const t = await loadTree(ctx, node.type);
    const all = aggregateTree([{ id: node.id, name: node.name }], t.childrenByParent, t.riskIdsByNode, t.aleByRisk, t.titleByRisk);
    return all[0];
}

// ── Per-risk hierarchy membership (for the risk form) ──

export async function getRiskNodes(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const links = await db.riskHierarchyLink.findMany({ where: { tenantId: ctx.tenantId, riskId }, select: { nodeId: true }, take: 1000 });
        const ids = links.map((l) => l.nodeId);
        if (!ids.length) return [];
        return db.riskHierarchyNode.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, name: true, type: true } });
    });
}
