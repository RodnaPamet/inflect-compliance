/**
 * Which canvas steps own a rule, and where a rule's step is.
 *
 * A leaf on purpose: `canvas-rule-sync` imports the rules usecase (for the
 * chain-cycle guard), and the rules usecase needs `findCanvasStepForRule`. Kept
 * here, neither import makes a cycle.
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';

// One set for the server and the canvas: the browser decides which step a
// Trigger configures from the same answer the sync uses to create rules.
import { RULE_OWNING_KINDS } from '@/lib/processes/canvas-rule-wiring';
export { RULE_OWNING_KINDS };

/** Where a rule lives on a canvas, for the Rules tab's "Open on canvas". */
export interface CanvasStepRef {
    mapId: string;
    mapName: string;
    nodeKey: string;
    stepLabel: string;
}

/**
 * The canvas step that owns a rule, if any.
 *
 * The link lives on the NODE (`dataJson.ruleId`, the VR-3 invariant keeps it
 * there and only there), so this reads it from that side. A rule written on
 * the Rules tab has no step; a step on a deleted map is not offered.
 */
export async function findCanvasStepForRule(
    db: PrismaTx,
    ctx: RequestContext,
    ruleId: string,
): Promise<CanvasStepRef | null> {
    const node = await db.processNode.findFirst({
        where: {
            tenantId: ctx.tenantId,
            nodeType: { in: [...RULE_OWNING_KINDS] },
            dataJson: { path: ['ruleId'], equals: ruleId },
            processMap: { deletedAt: null },
        },
        orderBy: { updatedAt: 'desc' },
        select: { nodeKey: true, label: true, processMap: { select: { id: true, name: true } } },
    });
    if (!node) return null;
    return {
        mapId: node.processMap.id,
        mapName: node.processMap.name,
        nodeKey: node.nodeKey,
        stepLabel: node.label,
    };
}
