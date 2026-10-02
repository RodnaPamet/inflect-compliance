/**
 * An edge's VARIANT is visible — flow solid, conditional dashed, reference
 * dotted.
 *
 * ═══ THE BUG THIS PINS (#3090) ═══
 *
 * `ProcessEdgeShapeUtil.component()` rendered one line and never read
 * `edgeKind`. The inspector offers the variant cycle, `useTldrawSelection`
 * applies it and the serializer persists it — so the value was settable,
 * saved and round-tripped, and invisible. All three kinds looked identical.
 *
 * That is not a cosmetic gap on this surface. `ProcessEdge.tsx` states the
 * semantics the xyflow canvas draws: conditional is "an optional / branch
 * path", reference "a non-flow informational dependency". On a compliance
 * process map, an optional branch indistinguishable from a required step
 * misrepresents the process to whoever reads it.
 *
 * ═══ WHY THE RENDERER IS EXERCISED DIRECTLY ═══
 *
 * Same arrangement as `process-shape-render.test.tsx`: `HTMLContainer` is
 * tldraw's positioning wrapper and wants a live editor, so it is stubbed to a
 * plain div, and the util is prototype-bound without its constructor because
 * `component()` reads only its argument.
 *
 * The assertions are on the rendered ATTRIBUTES rather than on
 * `edgeStrokeFor`'s return value alone, because the defect was precisely a
 * correct mapping that nothing applied. A unit test of the pure function would
 * have passed against the broken renderer.
 *
 * One thing deliberately NOT asserted: the spread's position. It sits after
 * the element's defaults so a variant can override one, and I wrote a test
 * claiming that was load-bearing — then the mutation that moves the spread
 * before them stayed green. It is unobservable today, because the only
 * overlapping attribute is the linecap and the default and `reference`'s
 * override are both `round`. An assertion over a difference that does not
 * exist is the kind that passes in both worlds.
 */
import { render, cleanup } from '@testing-library/react';

jest.mock('tldraw', () => ({
    ...jest.requireActual('tldraw'),
    HTMLContainer: ({
        children,
        ...rest
    }: { children?: React.ReactNode } & Record<string, unknown>) => (
        <div {...(rest as Record<string, unknown>)}>{children}</div>
    ),
}));

// Imported AFTER the mock so the util picks up the stubbed container.
const { ProcessEdgeShapeUtil } =
    require('@/components/processes/tldraw/ProcessEdgeShapeUtil') as typeof import('@/components/processes/tldraw/ProcessEdgeShapeUtil');
const { PROCESS_EDGE_SHAPE_TYPE, edgeStrokeFor } =
    require('@/components/processes/tldraw/process-edge-shape') as typeof import('@/components/processes/tldraw/process-edge-shape');

const util = Object.create(
    ProcessEdgeShapeUtil.prototype,
) as InstanceType<typeof ProcessEdgeShapeUtil>;

function lineFor(edgeKind: string): SVGLineElement {
    cleanup();
    const shape = {
        id: 'shape:edge-e1',
        type: PROCESS_EDGE_SHAPE_TYPE,
        x: 0,
        y: 0,
        rotation: 0,
        index: 'a1',
        parentId: 'page:page',
        isLocked: false,
        opacity: 1,
        meta: {},
        typeName: 'shape',
        props: { edgeKey: 'e1', edgeKind, dx: 120, dy: 80 },
    };
    const { container } = render(
        <>{util.component(shape as never)}</>,
    );
    const line = container.querySelector('line');
    if (!line) throw new Error('the util rendered no line');
    return line as SVGLineElement;
}

describe('the three variants are drawn differently', () => {
    it('flow is SOLID — no dash pattern at all', () => {
        expect(lineFor('flow').getAttribute('stroke-dasharray')).toBeNull();
    });

    it('conditional is DASHED', () => {
        // xyflow's exact pattern, so the two canvases agree during the cutover.
        expect(lineFor('conditional').getAttribute('stroke-dasharray')).toBe('7 5');
    });

    it('reference is DOTTED, and round-capped so the dots read as dots', () => {
        const line = lineFor('reference');
        expect(line.getAttribute('stroke-dasharray')).toBe('1 6');
        // True, but note it would also hold with no variant style at all: the
        // element already defaults to a round cap. The DASH above is what
        // distinguishes reference; this guards the cap not being dropped.
        expect(line.getAttribute('stroke-linecap')).toBe('round');
    });

    it('and no two of them render the same — the actual product property', () => {
        // Each assertion above passes on its own against a renderer that
        // returned one shared style; this is the one that cannot.
        const seen = ['flow', 'conditional', 'reference'].map((k) =>
            String(lineFor(k).getAttribute('stroke-dasharray')),
        );
        expect(new Set(seen).size).toBe(3);
    });
});

describe('an unrecognised kind still draws', () => {
    it('renders as flow rather than vanishing', () => {
        // `edgeKind` is `z.string().min(1).max(64)` on the wire, not an enum,
        // so an unknown value is reachable from the database. xyflow asserts
        // the same fallback as "an unknown / missing variant falls back to
        // flow (solid)".
        const line = lineFor('something-new');
        expect(line.getAttribute('stroke-dasharray')).toBeNull();
        expect(line.getAttribute('x2')).toBe('120');
    });

    it('and an EMPTY kind does too', () => {
        expect(lineFor('').getAttribute('stroke-dasharray')).toBeNull();
    });
});

describe('the line is still a line', () => {
    it('keeps its geometry and token-driven colour across variants', () => {
        // Teeth for the spread: a variant style that replaced the whole
        // attribute set would drop the class and the endpoints.
        for (const k of ['flow', 'conditional', 'reference']) {
            const line = lineFor(k);
            expect(line.getAttribute('x2')).toBe('120');
            expect(line.getAttribute('y2')).toBe('80');
            expect(line.getAttribute('class')).toContain('stroke-border-emphasis');
        }
    });
});

describe('edgeStrokeFor, the pure mapping', () => {
    it('returns nothing for flow, so the element keeps its defaults', () => {
        expect(edgeStrokeFor('flow')).toEqual({});
    });

    it('is total — every kind returns an object, never undefined', () => {
        for (const k of ['flow', 'conditional', 'reference', 'nonsense', '']) {
            expect(typeof edgeStrokeFor(k)).toBe('object');
        }
    });
});
