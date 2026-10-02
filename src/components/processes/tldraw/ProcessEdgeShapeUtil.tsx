/**
 * Draws a process edge, and makes it selectable.
 *
 * See `process-edge-shape.ts` for why an edge needs both a binding and a shape.
 * This is the shape half: pixels, hit-testing, and the selectability that gives
 * the edge inspector something to select.
 *
 * ═══ WHAT IT DELIBERATELY REFUSES ═══
 *
 * `canResize` and `canBind` are both false, and neither is caution:
 *
 *   • RESIZE — `dx` / `dy` are derived from where the bound nodes are, and are
 *     not persisted. A resize would therefore report success and be gone on
 *     reload, which is exactly the defect the node shape's `canResize(): false`
 *     was written to prevent (`w`/`h` had the same shape of problem).
 *   • BIND — an edge is not an endpoint. Allowing it would let a user draw an
 *     edge to an edge, which `ProcessEdge` cannot represent: `sourceKey` and
 *     `targetKey` are `nodeKey` values.
 */
import {
    Edge2d,
    HTMLContainer,
    ShapeUtil,
    Vec,
    type TLResizeInfo,
} from 'tldraw';

import { DEFAULT_EDGE_KIND } from './process-edge-binding';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeStrokeFor,
    processEdgeShapeProps,
    type ProcessEdgeShape,
} from './process-edge-shape';

/** Stroke width in page units. Matches the node border's weight. */
const EDGE_STROKE = 2;

export class ProcessEdgeShapeUtil extends ShapeUtil<ProcessEdgeShape> {
    static override type = PROCESS_EDGE_SHAPE_TYPE;
    static override props = processEdgeShapeProps;

    override getDefaultProps(): ProcessEdgeShape['props'] {
        return { edgeKey: '', edgeKind: DEFAULT_EDGE_KIND, label: '', chipLabel: '', dx: 0, dy: 0 };
    }

    /**
     * A line from the shape's origin to its far endpoint.
     *
     * `Edge2d` rather than `Rectangle2d`: hit-testing has to follow the line,
     * not its bounding box. A diagonal edge across a wide map would otherwise
     * claim a huge rectangle and swallow clicks meant for the nodes inside it.
     */
    override getGeometry(shape: ProcessEdgeShape): Edge2d {
        return new Edge2d({
            start: new Vec(0, 0),
            end: new Vec(shape.props.dx, shape.props.dy),
        });
    }

    override canBind(): boolean {
        return false;
    }

    override canResize(): boolean {
        return false;
    }

    override hideResizeHandles(): boolean {
        return true;
    }

    override hideRotateHandle(): boolean {
        return true;
    }

    /**
     * No `onResize`.
     *
     * Deleted rather than left unreachable, for the reason the node shape
     * records: re-enabling `canResize` must be a deliberate act that also has
     * to supply the handler AND the persistence, instead of finding a working
     * one already here.
     */
    override onResize(
        shape: ProcessEdgeShape,
        _info: TLResizeInfo<ProcessEdgeShape>,
    ): ProcessEdgeShape {
        return shape;
    }

    override component(shape: ProcessEdgeShape) {
        const { dx, dy, edgeKind, label, chipLabel } = shape.props;
        // Flow is solid; conditional dashes; reference dots. Spread rather than
        // branched inline so the three cases live in one pure, tested function.
        const variantStroke = edgeStrokeFor(edgeKind);
        // `overflow: visible` and a zero-size container: the line runs to an
        // offset that is frequently negative, and a sized SVG would clip every
        // edge pointing up or left.
        return (
            <HTMLContainer id={shape.id} style={{ width: 0, height: 0 }}>
                <svg
                    style={{ overflow: 'visible', position: 'absolute', pointerEvents: 'none' }}
                    aria-hidden="true"
                >
                    <line
                        x1={0}
                        y1={0}
                        x2={dx}
                        y2={dy}
                        strokeWidth={EDGE_STROKE}
                        // Token-driven, so an edge follows the theme the way
                        // the node borders do rather than pinning a hex here.
                        className="stroke-border-emphasis"
                        strokeLinecap="round"
                        /*
                            The automation COLOUR has to be an inline style, not
                            the `stroke` attribute, and the distinction is not
                            cosmetic: a CSS class beats a presentation
                            attribute, so `className="stroke-border-emphasis"`
                            below would keep painting the edge while a
                            `stroke="var(--content-error)"` attribute sat there
                            looking applied. The xyflow renderer used an inline
                            style for exactly this reason.

                            Document variants return no `stroke`, so they fall
                            through to the class and follow the theme.
                        */
                        style={variantStroke.stroke ? { stroke: variantStroke.stroke } : undefined}
                        // Last so a variant CAN override a default. Today
                        // nothing does: the only overlapping attribute is the
                        // linecap and both values are `round`, so moving this
                        // spread changes no output — a mutation that moved it
                        // before the defaults left all nine tests green, which
                        // is why there is no assertion claiming otherwise. The
                        // position is defensive, for a future variant wanting
                        // a `butt` cap, and nothing more.
                        {...variantStroke}
                    />
                </svg>
                {/*
                    The LABEL, at the line's midpoint (#3093).

                    `labelOverride` was stored, editable, applied and persisted
                    and drawn nowhere: a user typed a label on an edge, it
                    saved, it survived a reload, and the canvas never showed
                    it. The inspector even offers a clear button for it.

                    Outside the `<svg>` on purpose. An SVG `<text>` cannot wrap
                    or ellipsize, so a long label would run across the map; a
                    div takes the same type ramp as the node labels and can be
                    bounded. It is also why this is not `aria-hidden` like the
                    line is — the line is decoration, the label is content.

                    `translate(-50%, -50%)` after the midpoint offset so the
                    text is CENTRED on the line rather than hanging below and
                    right of it, which is what positioning alone would give.

                    Empty renders nothing at all rather than an empty box: an
                    unlabelled edge is the common case and a zero-height
                    element at every midpoint would still take a hit-test.
                */}
                {/*
                    The automation CHIP (VR-5). A fallback, not an addition: the
                    host sets `chipLabel` only when an edge has neither controls
                    nor an explicit label, which is the precedence the xyflow
                    renderer enforced with `!hasControls && !label && autoLabel`.

                    Rendered as a bordered pill rather than bare text, because
                    it is machine-derived — a reader should be able to tell
                    "Fail" that the system inferred from "Fail" that somebody
                    typed, and the label above is the one somebody typed.
                */}
                {chipLabel !== '' && label === '' && (
                    <div
                        data-edge-kind-chip={edgeKind}
                        style={{
                            position: 'absolute',
                            left: dx / 2,
                            top: dy / 2,
                            transform: 'translate(-50%, -50%)',
                            pointerEvents: 'none',
                        }}
                    >
                        <span className="inline-flex items-center rounded-[4px] border border-canvas-border bg-canvas-frame px-1.5 py-0.5 text-[10px] leading-4 text-content-muted">
                            {chipLabel}
                        </span>
                    </div>
                )}
                {label !== '' && (
                    <div
                        data-process-edge-label={label}
                        style={{
                            position: 'absolute',
                            left: dx / 2,
                            top: dy / 2,
                            transform: 'translate(-50%, -50%)',
                            maxWidth: 160,
                            pointerEvents: 'none',
                        }}
                        className="truncate rounded-[3px] bg-canvas-frame px-1 text-[10px] leading-4 text-content-muted"
                    >
                        {label}
                    </div>
                )}
            </HTMLContainer>
        );
    }

    override indicator(shape: ProcessEdgeShape) {
        const { dx, dy } = shape.props;
        // The selection affordance. Without it a selected edge shows nothing,
        // which reads as the click not having registered.
        return <line x1={0} y1={0} x2={dx} y2={dy} strokeWidth={EDGE_STROKE + 2} />;
    }
}
