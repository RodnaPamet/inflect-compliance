/**
 * `PERSISTED_NODE_PROPS` / `PERSISTED_EDGE_PROPS` match what the projection
 * actually reads — derived, not read off the lists.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * `classifyTldrawDiff` decides whether a store change is an edit by comparing
 * only the persisted keys. That makes the two lists load-bearing in both
 * directions, and both directions have already gone wrong once each:
 *
 *   - **A declared prop that is NOT persisted, treated as an edit.** `w` / `h`.
 *     A resize marked the document dirty, autosave fired, the write SUCCEEDED
 *     and bumped `version`, and the size was gone on reload — a save that
 *     reports success and discards.
 *   - **A persisted field the comparison could not see.** A binding's
 *     `fromId` / `toId`. Re-attaching an edge end changes those RECORD fields
 *     and no prop, so it read as `edge-untouched` and would never have saved.
 *
 * A hand-maintained list cannot catch either. So nothing here reads the lists
 * to decide what is right: it puts a **distinct sentinel in every declared
 * prop and every candidate record field**, runs the real `tldrawToRows`, and
 * derives the persisted set from which sentinels come out the other side.
 *
 * ── On `sourceKey` / `targetKey` ─────────────────────────────────────
 *
 * The projection prefers the binding's resolved endpoint and falls back to the
 * prop:
 *
 *     sourceKey: keyByShapeId.get(String(b.fromId)) ?? b.props.sourceKey
 *
 * So in the normal case the prop is ignored — the serializer calls it "a
 * denormalised convenience that goes stale the moment one moves". It is still
 * counted as persisted here, because the derivation takes the UNION over both
 * cases: a prop that CAN reach a row is one whose change must be able to claim
 * a save. Erring that way stores a redundant edit; erring the other way loses
 * a real one.
 */
import {
    PERSISTED_EDGE_PROPS,
    PERSISTED_NODE_PROPS,
    tldrawToRows,
    type ProcessEdgeBindingRecord,
    type ProcessNodeShapeRecord,
} from '@/components/processes/tldraw/serializer';
import {
    PROCESS_EDGE_BINDING_TYPE,
    processEdgeBindingProps,
} from '@/components/processes/tldraw/process-edge-binding';
import {
    PROCESS_NODE_SHAPE_TYPE,
    processNodeShapeProps,
    shapeIdForNodeKey,
} from '@/components/processes/tldraw/process-node-shape';

/** A value unique enough that finding it in the output proves where it came from. */
const mark = (name: string) => `SENTINEL_${name}`;

/** Which of `names` reached the serialised output. */
function reached(output: unknown, names: readonly string[]): string[] {
    const blob = JSON.stringify(output);
    return names.filter((n) => blob.includes(mark(n)));
}

const DECLARED_NODE_PROPS = Object.keys(processNodeShapeProps).sort();
const DECLARED_EDGE_PROPS = Object.keys(processEdgeBindingProps).sort();

describe('the declared props are known, so a new one has to be triaged', () => {
    it('the shape and binding prop sets are exactly what this file reasons about', () => {
        // Pinned so that ADDING a declared prop fails here first, rather than
        // silently falling into whichever bucket the comparison defaults to.
        expect(DECLARED_NODE_PROPS).toEqual([
            'dataJson',
            'h',
            'label',
            'nodeKey',
            'nodeType',
            'parentNodeKey',
            'subtitle',
            'w',
        ]);
        expect(DECLARED_EDGE_PROPS).toEqual([
            'controls',
            'dataJson',
            'edgeKey',
            'edgeKind',
            'labelOverride',
            'sourceKey',
            'targetKey',
        ]);
    });
});

describe('node props — derived from tldrawToRows', () => {
    /** Every declared prop carrying its own sentinel. */
    function sentinelShape(): ProcessNodeShapeRecord {
        return {
            id: shapeIdForNodeKey(mark('nodeKey')),
            type: PROCESS_NODE_SHAPE_TYPE,
            x: 111,
            y: 222,
            props: {
                // `w` / `h` are numbers by declaration, so they cannot carry a
                // string sentinel — distinctive numbers serve instead, checked
                // separately below.
                w: 987654,
                h: 876543,
                nodeKey: mark('nodeKey'),
                nodeType: mark('nodeType'),
                label: mark('label'),
                subtitle: mark('subtitle'),
                parentNodeKey: mark('parentNodeKey'),
                dataJson: mark('dataJson'),
            },
        };
    }

    it('reads exactly the props the constant names', () => {
        const rows = tldrawToRows({
            shapes: [sentinelShape()],
            bindings: [],
            freeform: [],
        });
        const stringy = DECLARED_NODE_PROPS.filter((p) => p !== 'w' && p !== 'h');
        expect(reached(rows, stringy).sort()).toEqual([...PERSISTED_NODE_PROPS].sort());
    });

    it('and does NOT read w or h — the whole reason the constant is narrower', () => {
        const rows = tldrawToRows({
            shapes: [sentinelShape()],
            bindings: [],
            freeform: [],
        });
        const blob = JSON.stringify(rows);
        expect(blob).not.toContain('987654');
        expect(blob).not.toContain('876543');
        expect(PERSISTED_NODE_PROPS).not.toContain('w');
        expect(PERSISTED_NODE_PROPS).not.toContain('h');
    });

    it('the declared-but-unpersisted set is EXACTLY w and h', () => {
        // The two-sided statement. A new declared prop that nobody persists
        // lands here, and a newly persisted prop that the constant does not
        // know about fails the derivation above.
        const unpersisted = DECLARED_NODE_PROPS.filter(
            (p) => !(PERSISTED_NODE_PROPS as readonly string[]).includes(p),
        );
        expect(unpersisted).toEqual(['h', 'w']);
    });

    it("a node's POSITION is read from the record, not from props", () => {
        const rows = tldrawToRows({
            shapes: [sentinelShape()],
            bindings: [],
            freeform: [],
        });
        // Dragging changes `s.x` / `s.y` and no prop, so the mapper has to
        // compare those record fields as well — `movedGeometry` does.
        expect(rows.nodes[0]).toMatchObject({ posX: 111, posY: 222 });
    });
});

describe('edge props — derived from tldrawToRows', () => {
    const N1 = 'n1';
    const N2 = 'n2';

    const endpoint = (key: string): ProcessNodeShapeRecord => ({
        id: shapeIdForNodeKey(key),
        type: PROCESS_NODE_SHAPE_TYPE,
        x: 0,
        y: 0,
        props: {
            w: 220,
            h: 88,
            nodeKey: key,
            nodeType: 'processStep',
            label: key,
            subtitle: null,
            parentNodeKey: null,
            dataJson: null,
        },
    });

    function sentinelBinding(resolvable: boolean): ProcessEdgeBindingRecord {
        return {
            id: `binding:${mark('edgeKey')}`,
            type: PROCESS_EDGE_BINDING_TYPE,
            // When resolvable, `keyByShapeId` wins and the sourceKey/targetKey
            // props are ignored; when not, the projection falls back to them.
            fromId: resolvable ? shapeIdForNodeKey(N1) : 'shape:not-on-the-canvas',
            toId: resolvable ? shapeIdForNodeKey(N2) : 'shape:also-absent',
            props: {
                edgeKey: mark('edgeKey'),
                sourceKey: resolvable ? N1 : mark('sourceKey'),
                targetKey: resolvable ? N2 : mark('targetKey'),
                edgeKind: mark('edgeKind'),
                labelOverride: mark('labelOverride'),
                dataJson: mark('dataJson'),
                controls: [
                    {
                        controlKey: mark('controls'),
                        label: 'c',
                        controlId: 'ctl_1',
                        dataJson: null,
                    },
                ],
            },
        };
    }

    it('reads exactly the props the constant names, over BOTH resolution paths', () => {
        // The union, because `sourceKey` / `targetKey` are reachable only on the
        // fallback path — see this file's header.
        const resolved = tldrawToRows({
            shapes: [endpoint(N1), endpoint(N2)],
            bindings: [sentinelBinding(true)],
            freeform: [],
        });

        let fellBack: unknown;
        try {
            fellBack = tldrawToRows({
                shapes: [endpoint(N1), endpoint(N2)],
                bindings: [sentinelBinding(false)],
                freeform: [],
            });
        } catch {
            // An unresolvable endpoint is refused by `validateEdge`, which is
            // correct behaviour and not what this test is about — the resolved
            // path alone then has to account for every persisted prop except
            // the two denormalised ones.
            fellBack = null;
        }

        const union = new Set([
            ...reached(resolved, DECLARED_EDGE_PROPS),
            ...reached(fellBack, DECLARED_EDGE_PROPS),
        ]);

        // Everything except the endpoint props must be reachable on the
        // resolved path; the endpoint props are covered by the constant's own
        // justification, asserted separately below so this stays honest about
        // which half proved which.
        const expectedOnResolved = [...PERSISTED_EDGE_PROPS].filter(
            (p) => p !== 'sourceKey' && p !== 'targetKey',
        );
        expect(reached(resolved, DECLARED_EDGE_PROPS).sort()).toEqual(
            expectedOnResolved.sort(),
        );
        // And nothing outside the constant ever reaches a row.
        for (const seen of union) {
            expect(PERSISTED_EDGE_PROPS).toContain(seen);
        }
    });

    it('every declared binding prop is persisted — bindings have no drift', () => {
        // The asymmetry with nodes, stated: this is why only the node side
        // needed a narrower comparison.
        expect(DECLARED_EDGE_PROPS).toEqual([...PERSISTED_EDGE_PROPS].sort());
    });

    it("an edge's ENDPOINTS are read from the record, not from props", () => {
        const rows = tldrawToRows({
            shapes: [endpoint(N1), endpoint(N2)],
            bindings: [sentinelBinding(true)],
            freeform: [],
        });
        // Resolved through `fromId` / `toId`, which is why the mapper compares
        // those record fields — a re-attachment changes no prop.
        expect(rows.edges[0]).toMatchObject({ sourceKey: N1, targetKey: N2 });
    });
});
