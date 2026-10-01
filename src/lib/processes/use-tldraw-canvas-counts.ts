'use client';

/**
 * How many process nodes exist, and how many are selected.
 *
 * The command palette's enablement rules read both — align needs two selected,
 * distribute three, a whole-map arrange needs at least one node. Those have to
 * be FRESH when the palette opens, so they cannot be computed once at mount.
 *
 * ── Why this does not re-render on every drag frame ──────────────────
 *
 * `store.listen` fires for every change, and a node drag emits one per frame.
 * Recomputing is O(shapes), which is fine for the map sizes this page targets,
 * but calling `setState` each time would re-render the whole workspace at frame
 * rate for two numbers that did not move — a drag changes positions, not counts.
 *
 * So the counts are compared before they are set. React bails out of a
 * same-value `setState`, which turns the common case into an O(n) read and no
 * render at all. The alternative — throttling — would make the palette's
 * enablement lag the selection, which is exactly when it is read.
 */
import { useEffect, useState } from 'react';
import type { Editor } from 'tldraw';

import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';

export interface TldrawCanvasCounts {
    /** Process nodes on the current page. Excludes edge lines and freeform. */
    nodeCount: number;
    /** Selected PROCESS nodes, not selected shapes. */
    selectionCount: number;
}

const ZERO: TldrawCanvasCounts = { nodeCount: 0, selectionCount: 0 };

export function useTldrawCanvasCounts(editor: Editor | null): TldrawCanvasCounts {
    const [counts, setCounts] = useState<TldrawCanvasCounts>(ZERO);

    useEffect(() => {
        if (!editor) {
            setCounts(ZERO);
            return;
        }
        const read = (): TldrawCanvasCounts => {
            const isNode = (s: { type?: string }) => s.type === PROCESS_NODE_SHAPE_TYPE;
            return {
                nodeCount: editor.getCurrentPageShapes().filter(isNode).length,
                // Counted over PROCESS nodes only. A selection of three sticky
                // notes must not enable `distribute`, which acts on nodes.
                selectionCount: editor.getSelectedShapes().filter(isNode).length,
            };
        };
        const sync = () => {
            const next = read();
            setCounts((prev) =>
                prev.nodeCount === next.nodeCount &&
                prev.selectionCount === next.selectionCount
                    ? prev
                    : next,
            );
        };
        sync();
        return editor.store.listen(sync);
    }, [editor]);

    return counts;
}
