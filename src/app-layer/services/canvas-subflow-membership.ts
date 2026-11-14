/**
 * Sub-flow group membership, derived from canvas nesting (#5477).
 *
 * `INVOKE_SUBFLOW` names a group by its `nodeKey`, and the sub-flow dispatcher
 * starts the group's entry rule: the highest-priority ENABLED rule whose
 * `AutomationRule.subFlowGroupId` is that key. Nothing ever wrote the column,
 * so every invocation found no entry rule and started nothing.
 *
 * Owner decision (2026-11-14): membership IS canvas nesting. A rule belongs to
 * a group when the canvas step that owns it sits inside that group node
 * (`parentNodeKey`). The canvas save is therefore the column's only writer:
 * it sets the key when a step is inside a group and clears it when the step
 * leaves the group, the group is removed, or the step is removed.
 *
 * ═══ WHY THIS IS NOT IN canvas-rule-sync.ts ═══
 *
 * The VR-3 invariant keeps geometry out of rule writes, and its guard holds the
 * sync file to never naming `parentNodeKey`. Group membership is the one fact
 * the canvas's STRUCTURE decides about a rule, by owner decision, so it lives
 * here, where the guard can hold that the only rule column this module writes
 * is `subFlowGroupId` and no position ever reaches a rule.
 *
 * ═══ NESTED GROUPS ═══
 *
 * A step belongs to its NEAREST enclosing group only. A step inside G2, which
 * is inside G1, is a member of G2 and not of G1: invoking G1 starts G1's own
 * highest-priority step, and G2 runs when something invokes G2. Membership in
 * every ancestor would let an outer invocation start a step buried in an inner
 * sub-flow because it happened to carry the highest priority.
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { assertCanManageAutomation } from '../automation/policies';
import { RULE_OWNING_KINDS } from './canvas-rule-link';

const GROUP_KIND = 'group';

interface NestingNode {
    nodeKey: string;
    nodeType: string;
    parentNodeKey: string | null;
}

/**
 * The key of the nearest group enclosing `nodeKey`, or null at root.
 *
 * Walks `parentNodeKey` upwards. A parent that is not a group (no other kind
 * is a container today, but the column does not say so) is passed through. The
 * repository refuses a self-parent and an unknown parent, but not a longer
 * cycle, so the walk stops at the first key it has already seen.
 */
export function nearestEnclosingGroup(
    nodeKey: string,
    byKey: ReadonlyMap<string, NestingNode>,
): string | null {
    const seen = new Set<string>([nodeKey]);
    let parent = byKey.get(nodeKey)?.parentNodeKey ?? null;
    while (parent && !seen.has(parent)) {
        seen.add(parent);
        const node = byKey.get(parent);
        if (!node) return null;
        if (node.nodeType === GROUP_KIND) return node.nodeKey;
        parent = node.parentNodeKey;
    }
    return null;
}

/** The map's group keys as stored now. Read BEFORE a save replaces the graph. */
export async function readMapGroupKeys(
    db: PrismaTx,
    ctx: RequestContext,
    processMapId: string,
): Promise<string[]> {
    const rows = await db.processNode.findMany({
        where: { processMapId, tenantId: ctx.tenantId, nodeType: GROUP_KIND },
        select: { nodeKey: true },
        take: 5000,
    });
    return rows.map((r) => r.nodeKey);
}

/**
 * Write each canvas rule's `subFlowGroupId` from the saved graph, and clear it
 * on every rule that was in one of this map's groups and no longer is.
 *
 * Run by the canvas sync AFTER the graph is persisted, with the rule each
 * rule-owning step is linked to (`ruleByNodeKey`, verified in-tenant by the
 * sync) and the group keys the map held before the save (`priorGroupKeys`),
 * so a rule whose group or step was deleted in this save is cleared too.
 *
 * A rule not on this canvas is cleared only when no live map has a step that
 * owns it: that step's own map decides its membership. Writes nothing when
 * nothing changes; any write asserts `assertCanManageAutomation`, the gate
 * every canvas rule write takes, so a save that would only CLEAR membership is
 * gated too.
 *
 * Returns the ids of the rules whose membership changed, for the sync's audit.
 */
export async function reconcileSubFlowMembership(
    db: PrismaTx,
    ctx: RequestContext,
    processMapId: string,
    ruleByNodeKey: ReadonlyMap<string, string>,
    priorGroupKeys: readonly string[],
): Promise<string[]> {
    const nodes = await db.processNode.findMany({
        where: { processMapId, tenantId: ctx.tenantId },
        select: { nodeKey: true, nodeType: true, parentNodeKey: true },
        take: 5000,
    });
    const byKey = new Map(nodes.map((n) => [n.nodeKey, n]));

    const desired = new Map<string, string | null>();
    for (const [nodeKey, ruleId] of ruleByNodeKey) {
        desired.set(ruleId, nearestEnclosingGroup(nodeKey, byKey));
    }
    const groupKeys = new Set(priorGroupKeys);
    for (const n of nodes) if (n.nodeType === GROUP_KIND) groupKeys.add(n.nodeKey);

    if (desired.size === 0 && groupKeys.size === 0) return [];

    // The canvas's own rules, plus every rule that names one of this map's
    // groups (before or after the save) — the population whose membership
    // this save decides.
    const rows = await db.automationRule.findMany({
        where: {
            tenantId: ctx.tenantId,
            OR: [
                ...(desired.size > 0 ? [{ id: { in: [...desired.keys()] } }] : []),
                ...(groupKeys.size > 0 ? [{ subFlowGroupId: { in: [...groupKeys] } }] : []),
            ],
        },
        select: { id: true, subFlowGroupId: true },
        take: 5000,
    });

    const changes = new Map<string, string | null>();
    const offCanvas: string[] = [];
    for (const r of rows) {
        if (desired.has(r.id)) {
            const target = desired.get(r.id) ?? null;
            if (r.subFlowGroupId !== target) changes.set(r.id, target);
        } else if (r.subFlowGroupId !== null) {
            offCanvas.push(r.id);
        }
    }

    // A rule off this canvas that still names one of its group keys: its step
    // was removed, or its group was. Before clearing, keep any rule a step on
    // ANOTHER live map owns. nodeKeys are unique per map, not per tenant, so
    // another map's group may share a key; that map's save owns that rule.
    if (offCanvas.length > 0) {
        const ownedElsewhere = await db.processNode.findMany({
            where: {
                tenantId: ctx.tenantId,
                processMapId: { not: processMapId },
                nodeType: { in: [...RULE_OWNING_KINDS] },
                processMap: { deletedAt: null },
                OR: offCanvas.map((id) => ({ dataJson: { path: ['ruleId'], equals: id } })),
            },
            select: { dataJson: true },
            take: 5000,
        });
        const kept = new Set<string>();
        for (const n of ownedElsewhere) {
            const id = (n.dataJson as { ruleId?: unknown } | null)?.ruleId;
            if (typeof id === 'string') kept.add(id);
        }
        for (const id of offCanvas) if (!kept.has(id)) changes.set(id, null);
    }

    if (changes.size === 0) return [];
    assertCanManageAutomation(ctx);

    // One write per distinct target group (null included), not per rule.
    const byTarget = new Map<string | null, string[]>();
    for (const [id, target] of changes) {
        const ids = byTarget.get(target) ?? [];
        ids.push(id);
        byTarget.set(target, ids);
    }
    for (const [target, ids] of byTarget) {
        await db.automationRule.updateMany({
            where: { tenantId: ctx.tenantId, id: { in: ids } },
            data: { subFlowGroupId: target },
        });
    }
    return [...changes.keys()];
}
