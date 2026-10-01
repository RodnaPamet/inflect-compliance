/**
 * The binding util for process edges.
 *
 * Deliberately thin. A `BindingUtil` declares one abstract member —
 * `getDefaultProps` — and everything else it can do is a lifecycle hook. The
 * edge's meaning lives in two places that are NOT here:
 *
 *   - `process-edge-binding.ts`  the props and their validators;
 *   - `edge-validation.ts`       whether an endpoint may be connected at all.
 *
 * Keeping the rules out of the util is what lets them be tested without an
 * editor, and what stops "may this edge exist" from having two answers.
 *
 * ═══ NO onBeforeCreate REFUSAL, ON PURPOSE ═══
 *
 * tldraw's binding hooks can veto a create, and it is tempting to enforce
 * `validateEdge` there. That would make the refusal invisible: the binding
 * simply would not appear, with nowhere to say why, and the user would learn
 * that some drags produce an edge and others silently do not.
 *
 * The validator returns refusals rather than throwing precisely so the surface
 * can show one. The hook is the wrong place for a decision that has to be
 * EXPLAINED — see `describeRefusal`.
 */
import {
    BindingUtil,
    type BindingOnShapeChangeOptions,
    type BindingOnShapeDeleteOptions,
    type TLShapeId,
} from 'tldraw';

import {
    edgeLineGeometry,
    shapeIdForEdgeKey,
    PROCESS_EDGE_SHAPE_TYPE,
} from './process-edge-shape';
import {
    DEFAULT_EDGE_KIND,
    PROCESS_EDGE_BINDING_TYPE,
    processEdgeBindingProps,
    type ProcessEdgeBinding,
} from './process-edge-binding';

export class ProcessEdgeBindingUtil extends BindingUtil<ProcessEdgeBinding> {
    static override type = PROCESS_EDGE_BINDING_TYPE;
    static override props = processEdgeBindingProps;

    override getDefaultProps(): Partial<ProcessEdgeBinding['props']> {
        return {
            // An edge drawn in the editor has no key until one is minted for
            // it, exactly as a drawn node has no `nodeKey`. Empty rather than
            // generated: minting belongs to whatever knows the rest of the
            // map's keys, and a plausible key invented here would eventually
            // collide with a real one.
            edgeKey: '',
            sourceKey: '',
            targetKey: '',
            edgeKind: DEFAULT_EDGE_KIND,
            labelOverride: null,
            dataJson: null,
            controls: [],
        };
    }

    /**
     * Keep the drawn line attached when either endpoint moves.
     *
     * This is the half a binding CAN do that a shape cannot do for itself: the
     * line has no way to notice a node it is not watching. `BindingUtil` carries
     * thirteen lifecycle hooks, and these are why the derived-shape approach
     * works at all — without them the connector is correct on load and wrong the
     * moment anything is dragged.
     *
     * Both hooks, not one: a node→node binding fires `FromShape` for the source
     * and `ToShape` for the target, and either end moving changes the line.
     *
     * Each reads `options.binding` and moves ONE line. These fire continuously
     * through a drag, so walking every binding on each callback would make a
     * single node drag O(edges) per frame on a map where edges are the thing
     * there are most of.
     */
    override onAfterChangeFromShape({ binding }: BindingOnShapeChangeOptions<ProcessEdgeBinding>): void {
        this.repositionLine(binding);
    }

    override onAfterChangeToShape({ binding }: BindingOnShapeChangeOptions<ProcessEdgeBinding>): void {
        this.repositionLine(binding);
    }

    /**
     * Remove the line when an endpoint goes.
     *
     * tldraw deletes the BINDING when a bound shape is deleted, but the line is
     * a third record it knows nothing about — left alone it would survive as a
     * connector to a node that no longer exists.
     */
    override onBeforeDeleteFromShape({ binding }: BindingOnShapeDeleteOptions<ProcessEdgeBinding>): void {
        this.deleteLine(binding);
    }

    override onBeforeDeleteToShape({ binding }: BindingOnShapeDeleteOptions<ProcessEdgeBinding>): void {
        this.deleteLine(binding);
    }

    /** Recompute one line from its endpoints' current bounds. */
    private repositionLine(binding: ProcessEdgeBinding): void {
        const lineId = shapeIdForEdgeKey(binding.props.edgeKey);
        // No line yet is the normal case during seeding, when bindings exist
        // before the lines derived from them — not an error to report.
        if (!this.editor.getShape(lineId)) return;
        const from = this.editor.getShapePageBounds(binding.fromId as TLShapeId);
        const to = this.editor.getShapePageBounds(binding.toId as TLShapeId);
        if (!from || !to) return;
        const g = edgeLineGeometry(from, to);
        this.editor.updateShape({
            id: lineId,
            type: PROCESS_EDGE_SHAPE_TYPE,
            x: g.x,
            y: g.y,
            props: { dx: g.dx, dy: g.dy },
        });
    }

    /** Delete one line, when its binding is losing an endpoint. */
    private deleteLine(binding: ProcessEdgeBinding): void {
        const lineId = shapeIdForEdgeKey(binding.props.edgeKey);
        if (this.editor.getShape(lineId)) this.editor.deleteShapes([lineId]);
    }
}
