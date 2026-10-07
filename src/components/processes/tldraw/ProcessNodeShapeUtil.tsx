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
import {
    HTMLContainer,
    Rectangle2d,
    ShapeUtil,
    stopEventPropagation,
    useMaybeEditor,
} from 'tldraw';

import { ChevronRight } from '@inflect/ui/components/ui/icons/nucleo/chevron-right';

import { isCollapsedFromDataJson } from './drill-scope-host';
import {
    overlayClassFor,
    useNodeOverlayStatus,
} from '@/lib/processes/canvas-execution-overlay';

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
 * The automation rule this node stands for, if it names one (VR-6).
 *
 * Pure and total, so "which rule is this node" is answerable without a store, a
 * provider or a network — the same reason `automationChipKey` is pure on the
 * edge side.
 *
 * `dataJson` is the opaque passthrough #2960 established: the server writes keys
 * the client does not enumerate, and `ruleId` is one of them. So this NARROWS
 * rather than casts. A cast would turn a row whose `ruleId` is a number, or
 * whose `dataJson` is a JSON array, into a render-time crash on the canvas — and
 * the deleted xyflow renderer narrowed for exactly this reason
 * (`ProcessTypedNode.tsx`: `typeof … === 'string' ? … : undefined`).
 *
 * `null` is a valid `dataJson` and `typeof null === 'object'`, which is why the
 * null check is explicit rather than left to the property read.
 */
export function ruleIdFromDataJson(dataJson: unknown): string | undefined {
    if (typeof dataJson !== 'object' || dataJson === null) return undefined;
    const id = (dataJson as { ruleId?: unknown }).ruleId;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
}

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

    /**
     * Rendered through a named function component, NOT inline.
     *
     * `component()` is a method on a `ShapeUtil`, and the body now reads React
     * context (`useNodeOverlayStatus`). A hook in a class method is outside what
     * `react-hooks/rules-of-hooks` can verify — tldraw does invoke this during a
     * render, so it would work, but "works and cannot be checked" is how a
     * conditional hook gets added later with nothing to catch it.
     *
     * This is the first shape util here to need a hook, so it sets the pattern
     * rather than following one.
     */
    override component(shape: ProcessNodeShape) {
        return <ProcessNodeBody shape={shape} />;
    }

    override indicator(shape: ProcessNodeShape) {
        return <rect width={shape.props.w} height={shape.props.h} rx={6} />;
    }
}

/**
 * The fold toggle on a group node (#3117).
 *
 * ═══ WHY A CHEVRON AND NOT A GESTURE ═══
 *
 * Double-clicking a group already means DRILL IN on this canvas. The xyflow
 * group node hit the same clash and resolved it the same way — its comment says
 * the chevron is "the only collapse affordance to avoid a gesture clash" — so
 * this carries that decision over rather than rediscovering it.
 *
 * ═══ useMaybeEditor, NOT useEditor ═══
 *
 * `useEditor()` throws without editor context, and `process-shape-render`
 * deliberately renders this util with no editor: its docblock says constructing
 * a real editor to render one box would test tldraw rather than this util.
 * `useMaybeEditor()` returns null there, so the control renders inert and that
 * file's 40 assertions keep working.
 *
 * It also makes the DISABLED state real rather than cosmetic — with no editor
 * there is nothing to write to, and saying so in the DOM beats a button that
 * silently no-ops.
 *
 * ═══ stopEventPropagation ═══
 *
 * Without it tldraw treats the pointer-down as a canvas gesture and starts
 * dragging the shape, so the click either drags or never lands. This is the
 * first interactive control inside a shape here, so there was no precedent.
 *
 * ═══ MERGED into dataJson, never replacing it ═══
 *
 * `dataJson` is the opaque passthrough (#2960) and already carries `size`,
 * `linkedEntityId` and `ruleId`. A whole-value write would drop every sibling
 * key — the same reason `useTldrawSelection` merges rather than assigns.
 */
function GroupFoldToggle({ shape }: { shape: ProcessNodeShape }) {
    const editor = useMaybeEditor();
    const collapsed = isCollapsedFromDataJson(shape.props.dataJson);

    return (
        <button
            type="button"
            // The accessible NAME is the group's own label and the STATE is
            // `aria-expanded`, so this needs no new copy — a shape util has no
            // translator, which is why the node reads per-kind text from
            // `NODE_TAXONOMY` constants rather than a message catalogue.
            aria-label={shape.props.label || undefined}
            aria-expanded={!collapsed}
            disabled={editor === null}
            data-testid={`group-fold-${shape.props.nodeKey || shape.id}`}
            data-collapsed={collapsed ? 'true' : 'false'}
            onPointerDown={stopEventPropagation}
            onClick={() => {
                if (!editor) return;
                const prev = (shape.props.dataJson ?? null) as Record<string, unknown> | null;
                editor.markHistoryStoppingPoint();
                editor.updateShape({
                    id: shape.id,
                    type: PROCESS_NODE_SHAPE_TYPE,
                    props: { dataJson: { ...(prev ?? {}), collapsed: !collapsed } },
                } as never);
            }}
            className="shrink-0 rounded-[3px] p-0.5 text-content-muted hover:bg-canvas-surface disabled:opacity-50"
            style={{ pointerEvents: 'all' }}
        >
            <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                aria-hidden="true"
            />
        </button>
    );
}

/**
 * A process node's chassis and contents.
 *
 * Split out of `ProcessNodeShapeUtil.component` so the overlay hook has a real
 * component to live in — see that method's note.
 */
function ProcessNodeBody({ shape }: { shape: ProcessNodeShape }) {
    const meta = metaForNodeType(shape.props.nodeType);
    const Icon = meta.icon;
    const isNote = meta.shape === 'note';

    /*
        VR-6 — live execution state, in Run Mode only.

        Read UNCONDITIONALLY, which is what keeps the hook rules satisfiable:
        without a `CanvasOverlayProvider` above this the context holds an empty
        map, `useNodeOverlayStatus` returns undefined, and `overlayClassFor`
        returns `''`. So a node still renders in isolation in a test and under
        SSR — the overlay module's header states that as a design property, and
        gating the hook on run mode would break it.

        That also means an assertion that merely renders a node and finds no
        overlay proves NOTHING: the empty-map path produces byte-identical
        output to a correctly-absent overlay. A test for this has to mount the
        provider with a populated map.
    */
    const overlayStatus = useNodeOverlayStatus(ruleIdFromDataJson(shape.props.dataJson));
    const overlayClass = overlayClassFor(overlayStatus);

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
                // Last, so the run-state ring wins over the accent border it
                // overlaps. `''` when there is no overlay, which `join` renders
                // as a harmless double space.
                overlayClass,
            ].join(' ')}
            data-testid={`process-node-${shape.props.nodeKey || shape.id}`}
            data-node-type={shape.props.nodeType}
            data-has-handles={meta.hasHandles ? 'true' : 'false'}
            // The STATUS, not the class. A Tailwind ring string is a
            // presentation detail a redesign may reword; the status is the
            // fact, and it is what a test should be able to read.
            data-overlay-status={overlayStatus}
        >
            <div className="flex items-center gap-tight">
                {/* Groups only — a step has nothing to fold. */}
                {meta.category === 'group' ? <GroupFoldToggle shape={shape} /> : null}
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
