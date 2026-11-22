/**
 * Governance graph builder (Visual Rule Editor VR-10).
 *
 * Builds the cross-map meta-graph: every automation-mode `ProcessMap` is a
 * node sized by rule volume + coloured by execution health; edges are the
 * sub-flow-call relationships (a rule in map A invoking a sub-flow group that
 * lives in map B) and shared-rule relationships. This is the enterprise-
 * architect, system-of-record view of the tenant's automation topology.
 *
 * The assembly core is pure + unit-tested; the usecase fetches the inputs.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';

export type GraphHealth = 'green' | 'amber' | 'red' | 'unknown';

export interface GovernanceNode {
    id: string;
    name: string;
    canvasMode: string;
    ruleCount: number;
    /** rule volume → relative node size (1–3). */
    size: number;
    successRate: number | null;
    health: GraphHealth;
}

export interface GovernanceEdge {
    id: string;
    source: string;
    target: string;
    kind: 'subflow-call' | 'shared-rule';
}

export interface MapStat {
    id: string;
    name: string;
    canvasMode: string;
    ruleCount: number;
    /** null when there were no terminal runs in the window. */
    successRate: number | null;
}

export interface GraphLink {
    sourceMapId: string;
    targetMapId: string;
    kind: 'subflow-call' | 'shared-rule';
}

/** Health ring thresholds — green ≥ 0.9, amber ≥ 0.7, else red; unknown when
 * the map has no terminal runs to score. */
export function healthFor(successRate: number | null): GraphHealth {
    if (successRate === null) return 'unknown';
    if (successRate >= 0.9) return 'green';
    if (successRate >= 0.7) return 'amber';
    return 'red';
}

function sizeFor(ruleCount: number): number {
    if (ruleCount >= 10) return 3;
    if (ruleCount >= 3) return 2;
    return 1;
}

/**
 * Pure assembler — maps + cross-map links → an xyflow-ready `{ nodes, edges }`.
 * Self-loops + links to/from unknown maps are dropped so the graph is always
 * renderable.
 */
export function buildGovernanceGraph(
    maps: MapStat[],
    links: GraphLink[],
): { nodes: GovernanceNode[]; edges: GovernanceEdge[] } {
    const known = new Set(maps.map((m) => m.id));
    const nodes: GovernanceNode[] = maps.map((m) => ({
        id: m.id,
        name: m.name,
        canvasMode: m.canvasMode,
        ruleCount: m.ruleCount,
        size: sizeFor(m.ruleCount),
        successRate: m.successRate,
        health: healthFor(m.successRate),
    }));
    const seen = new Set<string>();
    const edges: GovernanceEdge[] = [];
    for (const l of links) {
        if (l.sourceMapId === l.targetMapId) continue;
        if (!known.has(l.sourceMapId) || !known.has(l.targetMapId)) continue;
        const id = `${l.kind}:${l.sourceMapId}->${l.targetMapId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ id, source: l.sourceMapId, target: l.targetMapId, kind: l.kind });
    }
    return { nodes, edges };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Usecase — gather every process map + its rules + 30-day execution health,
 * derive cross-map sub-flow links, and assemble the meta-graph.
 */
export async function getGovernanceGraph(ctx: RequestContext, now: Date) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const since = new Date(now.getTime() - THIRTY_DAYS_MS);
        const [maps, nodes, rules, execs] = await Promise.all([
            db.processMap.findMany({
                where: { tenantId: ctx.tenantId, deletedAt: null, canvasMode: 'AUTOMATION' },
                select: { id: true, name: true, canvasMode: true },
                take: 500,
            }),
            // action nodes carry the map↔group↔rule linkage
            db.processNode.findMany({
                where: { tenantId: ctx.tenantId, nodeType: { in: ['action', 'group'] } },
                select: { processMapId: true, nodeKey: true, nodeType: true, dataJson: true },
                take: 5000,
            }),
            db.automationRule.findMany({
                where: { tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true, actionType: true, actionConfigJson: true },
                take: 5000,
            }),
            db.automationExecution.findMany({
                where: { tenantId: ctx.tenantId, createdAt: { gte: since } },
                select: { ruleId: true, status: true },
                take: 10000,
            }),
        ]);

        // map a rule id → its owning map (via the action node that references it)
        const ruleToMap = new Map<string, string>();
        // map a group nodeKey → its owning map
        const groupToMap = new Map<string, string>();
        for (const n of nodes) {
            if (n.nodeType === 'group') {
                groupToMap.set(n.nodeKey, n.processMapId);
            } else {
                const rid = (n.dataJson as { ruleId?: unknown } | null)?.ruleId;
                if (typeof rid === 'string') ruleToMap.set(rid, n.processMapId);
            }
        }

        // per-map rule count + execution health
        const ruleMapOf = (ruleId: string) => ruleToMap.get(ruleId);
        const perMap = new Map<string, { rules: Set<string>; succeeded: number; terminal: number }>();
        const ensure = (id: string) => {
            let s = perMap.get(id);
            if (!s) {
                s = { rules: new Set(), succeeded: 0, terminal: 0 };
                perMap.set(id, s);
            }
            return s;
        };
        for (const m of maps) ensure(m.id);
        for (const [ruleId, mapId] of ruleToMap) ensure(mapId).rules.add(ruleId);
        for (const e of execs) {
            const mapId = ruleMapOf(e.ruleId);
            if (!mapId) continue;
            const s = ensure(mapId);
            if (e.status === 'SUCCEEDED') {
                s.succeeded++;
                s.terminal++;
            } else if (e.status === 'FAILED') {
                s.terminal++;
            }
        }

        const mapStats: MapStat[] = maps.map((m) => {
            const s = perMap.get(m.id)!;
            return {
                id: m.id,
                name: m.name,
                canvasMode: m.canvasMode,
                ruleCount: s.rules.size,
                successRate: s.terminal > 0 ? s.succeeded / s.terminal : null,
            };
        });

        // sub-flow-call links: a rule whose action INVOKES a sub-flow → the map
        // holding that group (#5117). Keyed on the action's own
        // `targetGroupId`, the field the invocation actually reads; it used to
        // key on `subFlowGroupId`, which no writer sets, so the graph never drew
        // a sub-flow edge.
        const links: GraphLink[] = [];
        for (const r of rules) {
            if (r.actionType !== 'INVOKE_SUBFLOW') continue;
            const targetGroupId = (r.actionConfigJson as { targetGroupId?: unknown } | null)?.targetGroupId;
            if (typeof targetGroupId !== 'string' || !targetGroupId) continue;
            const sourceMapId = ruleToMap.get(r.id);
            const targetMapId = groupToMap.get(targetGroupId);
            if (sourceMapId && targetMapId) {
                links.push({ sourceMapId, targetMapId, kind: 'subflow-call' });
            }
        }

        return { ...buildGovernanceGraph(mapStats, links), generatedAt: now.toISOString() };
    });
}
