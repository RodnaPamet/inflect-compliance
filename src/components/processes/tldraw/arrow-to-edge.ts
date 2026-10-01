/**
 * Drawing a process edge, by borrowing tldraw's arrow gesture.
 *
 * ═══ THE CANVAS COULD NOT CREATE AN EDGE AT ALL ═══
 *
 * Found while scoping phase 4, and it was not on #2962's regression list:
 * `editor.createBindings` was called from exactly ONE place, the load path, and
 * `ProcessNodeShapeUtil` exposed no handles. Edges were materialised from saved
 * rows and by nothing else, so a user could not draw one. The xyflow canvas has
 * two ways — `onConnect` from a node handle, and proximity auto-bind.
 *
 * ═══ AND IT COULD DRAW A CONVINCING FAKE ═══
 *
 * Worse than the absence. `canBind()` returns true and `<Tldraw>` mounts with
 * no `hideUi`, so the default toolbar — including the arrow tool — is live. An
 * arrow drawn between two steps falls into `partitionCanvas`'s default arm,
 * which is `freeform`, which IS persisted to `ProcessMap.freeformJson`. It
 * looked exactly like an edge, survived reload, and was invisible to every
 * `ProcessEdge`-based compliance query: no row, no `ProcessEdgeControl`,
 * nothing for coverage to find.
 *
 * ═══ SO THE ARROW BECOMES THE GESTURE, RATHER THAN THE PROBLEM ═══
 *
 * Instead of building a custom tool and leaving the arrow tool to produce
 * lookalikes, an arrow bound at BOTH ends to process nodes is converted into a
 * real `ProcessEdge` binding and the arrow is removed.
 *
 * That buys tldraw's whole targeting UX for nothing: `arrowTargetState` carries
 * `snapDistance`, `snap` and `precise`, and `HandleSnaps.nearestShape` finds the
 * shape under the handle. Which is to say the proximity behaviour this canvas
 * was missing already exists upstream — it was attached to arrows, and our
 * edges deliberately are not arrows (`process-edge-binding.ts`: "The process
 * edge as a tldraw BINDING, not an arrow", because a row is what
 * `ProcessEdgeControl` hangs off). Converting is how we reach it without
 * becoming an arrow.
 *
 * An arrow bound at one end or neither is LEFT ALONE. That is a real
 * annotation — a callout pointing at a step — and the annotation layer is a
 * feature, not a mistake.
 *
 * ═══ WHY CONVERSION WAITS FOR THE POINTER ═══
 *
 * tldraw creates an arrow binding while the endpoint merely HOVERS a shape, so
 * a conversion driven straight off binding-creation fires mid-drag: the arrow
 * would vanish under the cursor the moment it grazed a second node, and the
 * user's gesture would be stolen. Candidates are therefore collected as their
 * bindings appear and drained once `editor.inputs.isPointing` is false.
 */
import type { Editor, TLShapeId } from 'tldraw';

import {
    DEFAULT_EDGE_KIND,
    PROCESS_EDGE_BINDING_TYPE,
} from './process-edge-binding';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeLineGeometry,
    shapeIdForEdgeKey,
} from './process-edge-shape';
import { PROCESS_NODE_SHAPE_TYPE } from './process-node-shape';
import {
    validateEdge,
    type EdgeRefusal,
    type KnownEdge,
    type KnownNode,
} from './edge-validation';

/**
 * tldraw's own arrow binding type, and its arrow SHAPE type. Not ours.
 *
 * Both are the literal `'arrow'`, which is why they are two named constants
 * rather than one: the first draft used a single name in both roles and the
 * drain loop read `if (type === ARROW_BINDING_TYPE) continue;` immediately
 * before `if (type === 'arrow') convert(id)`. Same string, so the guard
 * swallowed every shape the next line existed to convert, and nothing would
 * ever have been converted. Two names make the two meanings visible.
 */
const ARROW_BINDING_TYPE = 'arrow';
const ARROW_SHAPE_TYPE = 'arrow';

/**
 * A fresh edge key.
 *
 * Mirrors `mintNodeKey`'s shape, including the random suffix, for the reason
 * recorded there: a timestamp alone collides when two are minted in the same
 * millisecond, which a drag that binds both ends at once can do.
 */
export function mintEdgeKey(): string {
    return `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One end of a candidate arrow, resolved to the node it is bound to. */
export interface ArrowEnd {
    terminal: 'start' | 'end';
    /** `null` when the bound shape is not a process node. */
    nodeKey: string | null;
}

export type ArrowVerdict =
    /** Both ends are process nodes and the edge is legal. */
    | { kind: 'convert'; sourceKey: string; targetKey: string }
    /** Not an edge at all — leave it on the annotation layer. */
    | { kind: 'annotation'; why: 'FEWER_THAN_TWO_ENDS' | 'END_IS_NOT_A_NODE' }
    /** Both ends are nodes, but the edge is not allowed. */
    | { kind: 'refuse'; refusals: EdgeRefusal[] };

/**
 * Decide what an arrow is, without touching an editor.
 *
 * Split out from the plumbing because this is where the decisions are, and a
 * decision reachable only through a mounted editor and a simulated drag is a
 * decision nobody tests the edges of.
 */
export function classifyArrow(
    ends: readonly ArrowEnd[],
    nodes: readonly KnownNode[],
    edges: readonly KnownEdge[],
): ArrowVerdict {
    /**
     * An arrow needs a bound node at BOTH terminals to be an edge. One free end
     * is a callout, which is what the annotation layer is for, and this is
     * checked before validation — the alternative reports `UNKNOWN_NODE_KEY`
     * for a perfectly good annotation and toasts an error at a user who did
     * nothing wrong.
     *
     * ONE guard, not two. A first draft also tested `ends.length < 2` above
     * this, which read as defensive and was dead: mutating it away left all 25
     * tests green, because any arrow that fails the length test also fails to
     * produce both terminals here. A guard whose removal changes no behaviour
     * is not protecting anything, and it splits the decision across two places
     * that can disagree later.
     */
    const start = ends.find((e) => e.terminal === 'start');
    const end = ends.find((e) => e.terminal === 'end');
    if (!start || !end) return { kind: 'annotation', why: 'FEWER_THAN_TWO_ENDS' };

    // Bound to a sticky note, a group frame, or anything else on the canvas.
    if (start.nodeKey === null || end.nodeKey === null) {
        return { kind: 'annotation', why: 'END_IS_NOT_A_NODE' };
    }

    // DIRECTION comes from the terminal, not from binding order. An arrow drawn
    // right-to-left binds its `end` first, so ordering by creation would invert
    // half of all edges — and an inverted process edge is still a valid edge,
    // so nothing downstream would complain.
    const refusals = validateEdge(start.nodeKey, end.nodeKey, nodes, edges);
    if (refusals.length > 0) return { kind: 'refuse', refusals };

    return { kind: 'convert', sourceKey: start.nodeKey, targetKey: end.nodeKey };
}

interface InstallOptions {
    /** Told why an arrow between two nodes was refused, for a toast. */
    onRefuse?: (refusals: EdgeRefusal[]) => void;
    /** Called after a successful conversion, so the host can mark dirty. */
    onConverted?: (edgeKey: string) => void;
}

/**
 * Watch for arrows worth converting, and convert them.
 *
 * Returns a disposer. Registers two handlers rather than one: the first
 * collects candidates as arrow bindings appear, the second drains them once the
 * gesture is over — see the header on why mid-drag conversion is wrong.
 */
export function installArrowToEdgeConversion(
    editor: Editor,
    opts: InstallOptions = {},
): () => void {
    const pending = new Set<string>();

    const nodeKeyOf = (shapeId: string): string | null => {
        const s = editor.getShape(shapeId as TLShapeId) as
            | { type?: string; props?: { nodeKey?: unknown } }
            | undefined;
        if (!s || s.type !== PROCESS_NODE_SHAPE_TYPE) return null;
        const key = s.props?.nodeKey;
        return typeof key === 'string' && key.length > 0 ? key : null;
    };

    /** Every process node currently on the page, for the validator. */
    const knownNodes = (): KnownNode[] =>
        editor
            .getCurrentPageShapes()
            .filter((s) => (s as { type?: string }).type === PROCESS_NODE_SHAPE_TYPE)
            .map((s) => {
                const p = (s as unknown as { props: { nodeKey: string; nodeType: string } }).props;
                return { nodeKey: p.nodeKey, nodeType: p.nodeType };
            });

    /** Every process edge currently bound, for the duplicate check. */
    const knownEdges = (): KnownEdge[] =>
        editor.store
            .allRecords()
            .filter(
                (r) =>
                    r.typeName === 'binding' &&
                    (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE,
            )
            .map((r) => {
                const b = r as unknown as { props: { sourceKey: string; targetKey: string } };
                return { sourceKey: b.props.sourceKey, targetKey: b.props.targetKey };
            });

    const convert = (arrowId: string): void => {
        const arrow = editor.getShape(arrowId as TLShapeId);
        if (!arrow) return;

        const arrowBindings = editor.getBindingsInvolvingShape(
            arrowId as TLShapeId,
            ARROW_BINDING_TYPE,
        ) as unknown as Array<{
            id: string;
            fromId: string;
            toId: string;
            props: { terminal: 'start' | 'end' };
        }>;

        const ends: ArrowEnd[] = arrowBindings.map((b) => ({
            terminal: b.props.terminal,
            // The arrow is one side of its own binding; the NODE is the other.
            // Taking "the id that is not the arrow" rather than assuming
            // `toId`: the convention is tldraw's to change, and an inverted
            // assumption here would resolve every node to null and silently
            // turn every drawn edge into an annotation.
            nodeKey: nodeKeyOf(b.fromId === arrowId ? b.toId : b.fromId),
        }));

        const verdict = classifyArrow(ends, knownNodes(), knownEdges());
        if (verdict.kind === 'annotation') return;
        if (verdict.kind === 'refuse') {
            opts.onRefuse?.(verdict.refusals);
            return;
        }

        const fromId = editor
            .getCurrentPageShapes()
            .find(
                (s) =>
                    (s as { type?: string }).type === PROCESS_NODE_SHAPE_TYPE &&
                    (s as unknown as { props: { nodeKey: string } }).props.nodeKey ===
                        verdict.sourceKey,
            )?.id;
        const toId = editor
            .getCurrentPageShapes()
            .find(
                (s) =>
                    (s as { type?: string }).type === PROCESS_NODE_SHAPE_TYPE &&
                    (s as unknown as { props: { nodeKey: string } }).props.nodeKey ===
                        verdict.targetKey,
            )?.id;
        if (!fromId || !toId) return;

        const edgeKey = mintEdgeKey();

        /**
         * `editor.run` is what makes this undoable. The option pins a default.
         *
         * The three writes run from inside a side-effect handler, and loose
         * writes there are the store REACTING to an operation rather than
         * performing one — so they never reach the undo stack. This first said
         * `markHistoryStoppingPoint()`, with a comment claiming it collapsed
         * the swap into one entry. Measured, the truth was worse than "the mark
         * is redundant": a converted edge survived FOUR undos and
         * `getCanUndo()` was already false after two. **A user could draw an
         * edge and had no way to take it back.**
         *
         * Wrapping in `run` fixes that, and the mutation proof is specific
         * about which half does the work:
         *
         *   markHistoryStoppingPoint() only   undo does nothing
         *   run(fn)                           undo removes the edge and line
         *   run(fn, { history: 'record' })    same — the option is the default
         *   run(fn, { history: 'ignore' })    undo does nothing again
         *
         * So the option is NOT what fixed it, and saying otherwise would repeat
         * the mistake above. It is kept to pin a default this now depends on:
         * if recording ever stopped being the default, undo would break
         * silently, and the `'ignore'` row is the evidence that dependency is
         * real rather than decorative.
         */
        editor.run(() => {
            editor.createBindings([
            {
                type: PROCESS_EDGE_BINDING_TYPE,
                fromId,
                toId,
                props: {
                    edgeKey,
                    sourceKey: verdict.sourceKey,
                    targetKey: verdict.targetKey,
                    edgeKind: DEFAULT_EDGE_KIND,
                    labelOverride: null,
                    dataJson: null,
                    controls: [],
                },
            },
            ] as never);

            // The line is NOT seeded by the binding util: `repositionLine`
            // returns early when the shape is absent, documented there as "the
            // normal case during seeding". On load the serializer creates it;
            // on a live draw, here.
            const from = editor.getShapePageBounds(fromId);
            const to = editor.getShapePageBounds(toId);
            if (from && to) {
                const g = edgeLineGeometry(from, to);
                editor.createShapes([
                    {
                        id: shapeIdForEdgeKey(edgeKey),
                        type: PROCESS_EDGE_SHAPE_TYPE,
                        x: g.x,
                        y: g.y,
                        props: { edgeKey, dx: g.dx, dy: g.dy },
                    },
                ] as never);
            }

            // The arrow goes last. Deleting it first would fire the arrow
            // binding's own delete hooks in the middle of creating ours.
            editor.deleteShapes([arrowId as TLShapeId]);
        }, { history: 'record' });

        opts.onConverted?.(edgeKey);
    };

    const offCreate = editor.sideEffects.registerAfterCreateHandler(
        'binding',
        (binding) => {
            const b = binding as unknown as { type?: string; fromId: string; toId: string };
            if (b.type !== ARROW_BINDING_TYPE) return;
            // Either end may be the arrow; remember both and let `convert`
            // decide. A non-arrow id simply resolves to no arrow shape.
            pending.add(b.fromId);
            pending.add(b.toId);
        },
    );

    const offComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
        if (pending.size === 0) return;
        // Still dragging: the user has not finished the gesture.
        if (editor.inputs.isPointing) return;
        const ids = [...pending];
        pending.clear();
        for (const id of ids) {
            // A binding id resolves to no shape, so the lookup is also the
            // filter: `pending` holds both ends of every arrow binding and only
            // one of them is ever the arrow.
            const s = editor.getShape(id as TLShapeId);
            if (s && (s as { type?: string }).type === ARROW_SHAPE_TYPE) convert(id);
        }
    });

    return () => {
        offCreate();
        offComplete();
        pending.clear();
    };
}
