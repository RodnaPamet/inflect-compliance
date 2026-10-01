/**
 * ONE ShapeUtil for all twelve process node kinds.
 *
 * ═══ WHY ONE AND NOT TWELVE ═══
 *
 * #2960 left this conditional: "one `ShapeUtil` per node type, or one
 * parameterised util keyed on `nodeType` — prefer the latter if the taxonomy is
 * data-driven today, so adding a node type stays a data change."
 *
 * It is. `NODE_TAXONOMY` is a `Record<ProcessNodeKind, NodeTypeMeta>` and every
 * per-kind difference is a FIELD on that record — accent, shape, category,
 * hasHandles, icon, defaultLabel. Twelve utils would be twelve copies of one
 * renderer keyed by a lookup that already exists, and adding a kind would stop
 * being a data change on the day somebody forgot the thirteenth file.
 *
 * The shape VOCABULARY makes the same point from the other side: eleven of the
 * twelve kinds are `rect` and only `annotation` is `note`. The accent, the icon
 * and the corner sticker do the per-kind work, deliberately — the taxonomy says
 * so in as many words ("limiting the shape language keeps the canvas from
 * looking like a sticker sheet").
 *
 * ═══ AN UNKNOWN `nodeType` RENDERS, IT DOES NOT THROW ═══
 *
 * `ProcessNode.nodeType` is `z.string().min(1).max(64)` on the wire, not an
 * enum. A stored map may legitimately carry a kind this build has never heard
 * of — written by a newer client, or by one we have not shipped yet. The
 * renderer degrades to a neutral rect rather than refusing, because the
 * alternative is a canvas that will not open at all.
 *
 * ═══ `hasHandles` IS PER-KIND AND TWO KINDS ARE FALSE ═══
 *
 * `annotation` and `group`. Not one — that was a measurement error caused by a
 * grep window too small to reach `group`'s entry, corrected on #2960.
 *
 * They are false for DIFFERENT reasons, and the difference matters to anything
 * downstream that explains a refusal to a user:
 *
 *   - `annotation` floats free of the flow. It has no edges because it is not
 *     part of the process, only a note about it.
 *   - `group` is a CONTAINER. Its members are flow participants and reference
 *     it through `parentNodeKey`, but the box itself is not a step, so an edge
 *     to it names no point in the process.
 *
 * So a user told "this cannot take edges" needs a different next action in each
 * case: for an annotation, draw to the step it annotates; for a group, draw to
 * a node inside it.
 */
import { HTMLContainer, Rectangle2d, ShapeUtil } from 'tldraw';
import {
    NODE_ACCENT_BORDER,
    NODE_ACCENT_ICON_TONE,
    NODE_TAXONOMY,
    isProcessNodeKind,
    type NodeTypeMeta,
} from '../node-taxonomy';
import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
    PROCESS_NODE_SHAPE_TYPE,
    processNodeShapeProps,
    type ProcessNodeShape,
} from './process-node-shape';

/**
 * The taxonomy entry for a stored `nodeType`, or a safe stand-in.
 *
 * Exported because the same question is asked by the inspector, the palette
 * and the edge validator, and three copies of this fallback would disagree the
 * first time one of them was updated.
 */
export function metaForNodeType(nodeType: string): NodeTypeMeta {
    if (isProcessNodeKind(nodeType)) return NODE_TAXONOMY[nodeType];
    // Unknown kind: render as the quietest thing that is still a node. NOT
    // `processStep` — that would silently assert a flow participant, and an
    // unrecognised kind is precisely the case where we do not know that.
    return NODE_TAXONOMY.external;
}

/** Whether a kind participates in the graph as a source or target of edges. */
export function nodeTypeHasHandles(nodeType: string): boolean {
    return metaForNodeType(nodeType).hasHandles;
}

export class ProcessNodeShapeUtil extends ShapeUtil<ProcessNodeShape> {
    static override type = PROCESS_NODE_SHAPE_TYPE;
    static override props = processNodeShapeProps;

    override getDefaultProps(): ProcessNodeShape['props'] {
        return {
            w: PROCESS_NODE_DEFAULT_W,
            h: PROCESS_NODE_DEFAULT_H,
            // A node created by drawing has no key until one is minted for it.
            // Empty rather than a generated value: minting belongs to whatever
            // knows the rest of the map's keys, and a plausible-looking key
            // invented here would collide with a real one eventually.
            nodeKey: '',
            nodeType: 'processStep',
            label: NODE_TAXONOMY.processStep.defaultLabel,
            subtitle: null,
            parentNodeKey: null,
            dataJson: null,
        };
    }

    override getGeometry(shape: ProcessNodeShape): Rectangle2d {
        return new Rectangle2d({
            width: shape.props.w,
            height: shape.props.h,
            isFilled: true,
        });
    }

    override canBind(): boolean {
        // Binding is decided PER SHAPE by the edge layer, which knows the
        // taxonomy; this is the util-wide answer and must stay permissive or
        // no process node could ever take an edge. `nodeTypeHasHandles` is the
        // per-kind gate.
        return true;
    }

    /**
     * NO RESIZE, because a resize cannot be saved.
     *
     * This returned `true` with `onResize` wired to `resizeBox`, which writes
     * `props.w` / `props.h`. `tldrawToRows` reads neither — size is the
     * renderer's own (see `rowsToTldraw`) — so a resize marked the document
     * dirty, autosave fired, the write SUCCEEDED and bumped `version`, and the
     * size was gone on reload. A save that reports success and discards the
     * edit, which is worse than losing it quietly: the version bump asserts it
     * was stored.
     *
     * Locking is the owner's decision (#2961), chosen over teaching the
     * renderer to read `dataJson.size` — a column #2960 deliberately made an
     * opaque passthrough — and over inventing pixel dimensions for a preset
     * that, on xyflow, is CSS over intrinsic sizing (`min-w`/`max-w`, padding,
     * icon and text scale) rather than a width and a height.
     *
     * TO RE-ENABLE, persistence comes FIRST: give `ProcessNode` real `w` / `h`
     * columns, read them in both directions of the serializer, and add them to
     * `PERSISTED_NODE_PROPS`. Flipping this back on its own reinstates the
     * defect exactly as it was.
     *
     * `onResize` is deleted rather than left unreachable, so there is no
     * ready-made resize handler for a future flip to find and trust.
     */
    override canResize(): boolean {
        return false;
    }

    /** No handles either — `canResize` refuses the drag, this removes the grab. */
    override hideResizeHandles(): boolean {
        return true;
    }

    /**
     * Hide the rotate handle — and note this HIDES an affordance rather than
     * removing a capability.
     *
     * `ShapeUtil` has no `canRotate`; the API is this. `RotateCWMenuItem` and
     * `editor.rotateShapesBy()` stay reachable, so rotation is not locked the
     * way resize is.
     *
     * That is tolerable only because rotation cannot claim a save: `rotation`
     * is a tldraw base-record field, not a declared prop, so it is outside
     * `PERSISTED_NODE_PROPS` and `classifyTldrawDiff` reads a rotation-only
     * change as `node-untouched`. Nothing marks dirty, nothing saves, nothing
     * lies about having stored it — the user simply loses it on reload, which
     * is the same shape as before this change and not a regression it
     * introduces.
     */
    override hideRotateHandle(): boolean {
        return true;
    }

    override component(shape: ProcessNodeShape) {
        const meta = metaForNodeType(shape.props.nodeType);
        const Icon = meta.icon;
        const isNote = meta.shape === 'note';

        return (
            <HTMLContainer
                id={shape.id}
                style={{ width: shape.props.w, height: shape.props.h }}
                className={[
                    'flex h-full w-full flex-col gap-tight overflow-hidden border p-compact',
                    isNote ? 'rounded-sm' : 'rounded-md',
                    NODE_ACCENT_BORDER[meta.accent],
                    // `category` is the second-order signal the taxonomy
                    // describes: flow nodes read as solid, context nodes as
                    // annotations ON the flow rather than part of it.
                    meta.category === 'flow' ? 'bg-bg-default' : 'bg-bg-subtle',
                ].join(' ')}
                data-testid={`process-node-${shape.props.nodeKey || shape.id}`}
                data-node-type={shape.props.nodeType}
                data-has-handles={meta.hasHandles ? 'true' : 'false'}
            >
                <div className="flex items-center gap-tight">
                    <Icon
                        className={`h-4 w-4 shrink-0 ${NODE_ACCENT_ICON_TONE[meta.accent]}`}
                        // Decorative: the label below is the accessible name.
                        aria-hidden="true"
                    />
                    <span className="truncate text-sm font-medium text-content-emphasis">
                        {shape.props.label}
                    </span>
                </div>
                {shape.props.subtitle ? (
                    <span className="truncate text-xs text-content-muted">
                        {shape.props.subtitle}
                    </span>
                ) : null}
            </HTMLContainer>
        );
    }

    override indicator(shape: ProcessNodeShape) {
        return <rect width={shape.props.w} height={shape.props.h} rx={6} />;
    }
}
