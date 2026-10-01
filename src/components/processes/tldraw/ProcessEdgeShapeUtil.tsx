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

import {
    PROCESS_EDGE_SHAPE_TYPE,
    processEdgeShapeProps,
    type ProcessEdgeShape,
} from './process-edge-shape';

/** Stroke width in page units. Matches the node border's weight. */
const EDGE_STROKE = 2;

export class ProcessEdgeShapeUtil extends ShapeUtil<ProcessEdgeShape> {
    static override type = PROCESS_EDGE_SHAPE_TYPE;
    static override props = processEdgeShapeProps;

    override getDefaultProps(): ProcessEdgeShape['props'] {
        return { edgeKey: '', dx: 0, dy: 0 };
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
        const { dx, dy } = shape.props;
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
                    />
                </svg>
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
