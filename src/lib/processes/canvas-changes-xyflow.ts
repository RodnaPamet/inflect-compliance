/**
 * xyflow's change unions, mapped into the engine-free vocabulary.
 *
 * The ONLY file that knows both xyflow's change types and the vocabulary in
 * `canvas-changes.ts`. A tldraw mapper is a sibling of this one, not an edit to
 * it — which is the point of splitting them: the host imports the vocabulary,
 * and exactly one mapper per engine imports the engine.
 *
 * Every classification here is lifted from the predicates that lived inline in
 * `PersistedProcessCanvas`, comments included, because the comments are the part
 * worth keeping. Where the original said something load-bearing, it is repeated
 * rather than summarised.
 */
import type { EdgeChange, NodeChange } from '@xyflow/react';
import type { ClassifiedChange } from './canvas-changes';

/**
 * Classify one xyflow node change.
 *
 * xyflow's union carries both substantive edits (add, remove, position-commit)
 * and transient flicker (selection, dimensions, position-during-drag).
 */
export function classifyXyflowNodeChange(c: NodeChange): ClassifiedChange {
    switch (c.type) {
        case 'add':
            return { significance: 'substantive', kind: 'node-added' };
        case 'remove':
            return { significance: 'substantive', kind: 'node-removed' };
        case 'position':
            // `dragging: false` marks the commit (mouse-up). Intermediate drag
            // ticks have `dragging: true` and must not push history.
            //
            // Note `dragging` is optional on the change, so this tests for the
            // literal `false` rather than falsiness — an ABSENT flag is not a
            // commit, and `!c.dragging` would classify it as one.
            return c.dragging === false
                ? { significance: 'substantive', kind: 'node-moved-committed' }
                : { significance: 'transient', kind: 'node-dragging' };
        case 'replace':
            // INSPECTOR EDITS, and the classification is what makes them work.
            // `updateNodeData` queues a store update which xyflow diffs into a
            // `replace` change and forwards here — so falling through to "not
            // substantive" meant label / subtitle / size / linked-entity edits
            // were neither autosaved NOR undoable, while ProcessInspector told
            // the user "Click off the field or press Enter to save the edit."
            //
            // Classified here rather than by calling history.push + markDirty
            // inside handleInspectorUpdate: doing both would push TWO undo
            // entries per edit, and this way any future updateNodeData caller is
            // covered by construction.
            return { significance: 'substantive', kind: 'node-data-replaced' };
        case 'dimensions':
            return { significance: 'transient', kind: 'node-measured' };
        case 'select':
            return { significance: 'transient', kind: 'node-selected' };
        default:
            // An engine that adds a variant gets TRANSIENT, not substantive.
            // Failing toward "do nothing" keeps an unknown event from spraying
            // undo entries; the cost is a missed dirty flag, which the next real
            // edit sets anyway.
            return { significance: 'transient', kind: 'node-unknown' };
    }
}

/**
 * Classify one xyflow edge change.
 *
 * ASYMMETRIC WITH NODES ON `replace`, and deliberately. `handleEdgeUpdate` calls
 * `history.push` and `markDirty` itself before `setEdges`, so classifying the
 * resulting `replace` as substantive would push a second undo entry for one
 * edit. The node path does the opposite — it relies on the classification and
 * pushes nothing directly.
 *
 * Both are correct only in combination with their own commit path. Changing
 * either half alone breaks undo.
 */
export function classifyXyflowEdgeChange(c: EdgeChange): ClassifiedChange {
    switch (c.type) {
        case 'add':
            return { significance: 'substantive', kind: 'edge-added' };
        case 'remove':
            return { significance: 'substantive', kind: 'edge-removed' };
        case 'replace':
            return { significance: 'handled-by-caller', kind: 'edge-data-replaced' };
        case 'select':
            return { significance: 'transient', kind: 'edge-selected' };
        default:
            return { significance: 'transient', kind: 'edge-unknown' };
    }
}
