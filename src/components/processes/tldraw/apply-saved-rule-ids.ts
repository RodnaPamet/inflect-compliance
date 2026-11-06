/**
 * Give the open canvas the rule each step was linked to by the save.
 *
 * Saving an automation map creates a rule for each NEW Action or Agent step,
 * and the save's response says which (`dataJson.ruleId` on each returned
 * node). The canvas never read it back, so the step it had just saved still
 * had no rule: the inspector said "save the map" again, and the next save sent
 * the step without a link. The server now keeps the stored link when a save
 * omits it (`prepareCanvasNodesForSave`), which stops the duplicate rules; this
 * is the other half, so the open canvas knows the link at once.
 *
 * Applied as a REMOTE change with history ignored: it is the server's answer,
 * not an edit. A user-sourced change would mark the map dirty and start
 * another autosave; a recorded one would let undo take the link away.
 */
import type { Editor, TLShapeId } from 'tldraw';

import { ruleIdOfDataJson } from '@/lib/processes/canvas-rule-wiring';
import { PROCESS_NODE_SHAPE_TYPE } from './process-node-shape';

interface SavedNode {
    nodeKey?: unknown;
    dataJson?: unknown;
}

/** Returns how many steps were given a rule. */
export function applySavedRuleIds(editor: Editor, savedNodes: unknown[]): number {
    const ruleIdByKey = new Map<string, string>();
    for (const raw of savedNodes) {
        const n = raw as SavedNode;
        const ruleId = ruleIdOfDataJson(n?.dataJson);
        if (typeof n?.nodeKey === 'string' && ruleId) ruleIdByKey.set(n.nodeKey, ruleId);
    }
    if (ruleIdByKey.size === 0) return 0;

    const updates: Array<{ id: TLShapeId; type: string; props: { dataJson: Record<string, unknown> } }> = [];
    for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== PROCESS_NODE_SHAPE_TYPE) continue;
        const props = shape.props as { nodeKey?: unknown; dataJson?: unknown };
        const ruleId = typeof props.nodeKey === 'string' ? ruleIdByKey.get(props.nodeKey) : undefined;
        if (!ruleId || ruleIdOfDataJson(props.dataJson) === ruleId) continue;
        const prev =
            props.dataJson && typeof props.dataJson === 'object' && !Array.isArray(props.dataJson)
                ? (props.dataJson as Record<string, unknown>)
                : {};
        updates.push({
            id: shape.id,
            type: PROCESS_NODE_SHAPE_TYPE,
            props: { dataJson: { ...prev, ruleId } },
        });
    }
    if (updates.length === 0) return 0;
    editor.store.mergeRemoteChanges(() => {
        editor.run(() => editor.updateShapes(updates as never), { history: 'ignore' });
    });
    return updates.length;
}
