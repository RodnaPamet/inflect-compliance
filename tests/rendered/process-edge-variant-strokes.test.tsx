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
// The real catalogue, `require`d to match the pattern this file already uses
// below the `jest.mock` — a top-level `import` would be hoisted above it.
const en = require('../../messages/en.json') as {
    automation: { edges: Record<string, string> };
};

const { PROCESS_EDGE_SHAPE_TYPE, edgeStrokeFor, automationChipKey } =
    require('@/components/processes/tldraw/process-edge-shape') as typeof import('@/components/processes/tldraw/process-edge-shape');

const util = Object.create(
    ProcessEdgeShapeUtil.prototype,
) as InstanceType<typeof ProcessEdgeShapeUtil>;

function shapeWith(over: Record<string, unknown>) {
    return {
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
        props: { edgeKey: 'e1', edgeKind: 'flow', label: '', chipLabel: '', dx: 120, dy: 80, ...over },
    };
}

function renderEdge(over: Record<string, unknown>) {
    cleanup();
    const { container } = render(
        <>{util.component(shapeWith(over) as never)}</>,
    );
    return container;
}

function lineFor(edgeKind: string): SVGLineElement {
    const line = renderEdge({ edgeKind }).querySelector('line');
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

/**
 * The LABEL (#3093).
 *
 * `labelOverride` was stored, editable, applied and persisted, and drawn
 * nowhere — the second value on this surface to be settable and invisible,
 * after the variant above. The inspector offers a CLEAR button for it, which
 * is the detail that makes the absence hard to read as deliberate.
 */
describe('an edge draws its label', () => {
    it('renders the label text at all', () => {
        expect(renderEdge({ label: 'approves' }).textContent).toContain('approves');
    });

    it('positions it at the MIDPOINT of the line, centred on it', () => {
        // Half of dx/dy, then translated back by half its own box. Without the
        // translate the text hangs below and right of the line it belongs to,
        // which reads as a label for something else.
        const el = renderEdge({ label: 'approves' }).querySelector(
            '[data-process-edge-label]',
        ) as HTMLElement | null;
        expect(el).not.toBeNull();
        expect(el!.style.left).toBe('60px');
        expect(el!.style.top).toBe('40px');
        expect(el!.style.transform).toBe('translate(-50%, -50%)');
    });

    it('renders NOTHING for an empty label, not an empty box', () => {
        // The common case. A zero-height element at every midpoint would still
        // be in the tree, and `toContain('')` passes against anything.
        const c = renderEdge({ label: '' });
        expect(c.querySelector('[data-process-edge-label]')).toBeNull();
    });

    it('and the line is still drawn when there is no label', () => {
        // Teeth: a conditional that swallowed the whole return would satisfy
        // the assertion above.
        expect(renderEdge({ label: '' }).querySelector('line')).not.toBeNull();
    });

    it('is not aria-hidden — the line is decoration, the label is content', () => {
        const el = renderEdge({ label: 'approves' }).querySelector(
            '[data-process-edge-label]',
        ) as HTMLElement;
        expect(el.closest('[aria-hidden="true"]')).toBeNull();
    });

    it('truncates rather than running across the map', () => {
        const el = renderEdge({
            label: 'a label considerably longer than any sensible edge caption',
        }).querySelector('[data-process-edge-label]') as HTMLElement;
        expect(el.className).toContain('truncate');
        expect(el.style.maxWidth).toBe('160px');
    });

    it('a labelled CONDITIONAL edge keeps both its dash and its label', () => {
        // The two derived props are independent; a reader could reasonably
        // wonder whether one overwrote the other.
        const c = renderEdge({ label: 'if rejected', edgeKind: 'conditional' });
        expect(c.querySelector('line')!.getAttribute('stroke-dasharray')).toBe('7 5');
        expect(c.textContent).toContain('if rejected');
    });
});

/**
 * VR-5 — the automation edge kinds (#3093).
 *
 * ═══ WHY THESE ARE MORE ARMS, NOT A SECOND MECHANISM ═══
 *
 * `edgeKind` is ONE overloaded field. An edge carries either a document variant
 * (`flow`/`conditional`/`reference`) or an automation kind, never both — and on
 * the deleted xyflow renderer the automation style OVERRODE the variant style on
 * exactly the same read. So porting VR-5 meant extending the switch the
 * document variants already dispatch through, which is why these assertions sit
 * in this file rather than a new one.
 *
 * ═══ THE ONE THING THAT WOULD SILENTLY NOT WORK ═══
 *
 * Automation kinds carry a COLOUR, and a colour cannot be a `stroke` attribute
 * here: a CSS class beats a presentation attribute, so the element's
 * `className="stroke-border-emphasis"` would keep painting while a
 * `stroke="var(--content-error)"` attribute sat there looking applied. It has to
 * be an inline style. That is asserted on `style.stroke` rather than
 * `getAttribute('stroke')` for precisely that reason — the attribute form is the
 * version that passes while doing nothing.
 */
describe('automation edge kinds carry a colour', () => {
    const CASES: Array<[string, string]> = [
        ['trigger-flow', 'var(--brand-default)'],
        ['condition-pass', 'var(--content-success)'],
        ['condition-fail', 'var(--content-error)'],
        ['chain-delay', 'var(--canvas-edge)'],
        ['sla-breach', 'var(--content-warning)'],
        ['sla-pass', 'var(--content-success)'],
    ];

    it('each kind paints its token, as an inline style not an attribute', () => {
        for (const [kind, token] of CASES) {
            const line = renderEdge({ edgeKind: kind }).querySelector('line') as SVGLineElement;
            expect(line.style.stroke).toBe(token);
        }
    });

    it('and a DOCUMENT variant sets no stroke, so it follows the theme', () => {
        // The teeth for the above: if every kind returned a colour, the three
        // document variants would stop following the canvas-edge token and a
        // map would become a colour chart.
        for (const kind of ['flow', 'conditional', 'reference']) {
            const line = renderEdge({ edgeKind: kind }).querySelector('line') as SVGLineElement;
            expect(line.style.stroke).toBe('');
            expect(line.getAttribute('class')).toContain('stroke-border-emphasis');
        }
    });

    it('condition-fail and chain-delay also dash, and differently', () => {
        // Colour alone is not enough: these two are the pair a colour-blind
        // reader most needs told apart from their positive counterparts.
        const fail = renderEdge({ edgeKind: 'condition-fail' }).querySelector('line')!;
        const chain = renderEdge({ edgeKind: 'chain-delay' }).querySelector('line')!;
        expect(fail.getAttribute('stroke-dasharray')).toBe('6 4');
        expect(chain.getAttribute('stroke-dasharray')).toBe('2 5');
        expect(fail.getAttribute('stroke-dasharray')).not.toBe(
            chain.getAttribute('stroke-dasharray'),
        );
    });

    it('pass and breach are distinguishable from each other', () => {
        // `condition-pass` and `sla-pass` share a token deliberately — both mean
        // "the good path". `sla-breach` must not share with either.
        const pass = renderEdge({ edgeKind: 'condition-pass' }).querySelector('line')!;
        const breach = renderEdge({ edgeKind: 'sla-breach' }).querySelector('line')!;
        expect((pass as SVGLineElement).style.stroke).not.toBe(
            (breach as SVGLineElement).style.stroke,
        );
    });
});

describe('the automation CHIP', () => {
    it('renders the host-resolved text, tagged with its kind', () => {
        const c = renderEdge({ edgeKind: 'condition-fail', chipLabel: 'Fail' });
        const chip = c.querySelector('[data-edge-kind-chip]') as HTMLElement | null;
        expect(chip).not.toBeNull();
        expect(chip!.getAttribute('data-edge-kind-chip')).toBe('condition-fail');
        expect(chip!.textContent).toContain('Fail');
    });

    it('is suppressed by an explicit label — the precedence that matters', () => {
        // A label the user TYPED wins over one the system inferred. Both
        // rendering would stack two captions on one line.
        const c = renderEdge({ edgeKind: 'condition-fail', chipLabel: 'Fail', label: 'if over limit' });
        expect(c.querySelector('[data-edge-kind-chip]')).toBeNull();
        expect(c.textContent).toContain('if over limit');
    });

    it('renders nothing when the host supplied no chip', () => {
        expect(renderEdge({ edgeKind: 'flow' }).querySelector('[data-edge-kind-chip]')).toBeNull();
    });

    it('sits at the midpoint, like the label it stands in for', () => {
        const chip = renderEdge({ edgeKind: 'sla-pass', chipLabel: 'On time' })
            .querySelector('[data-edge-kind-chip]') as HTMLElement;
        expect(chip.style.left).toBe('60px');
        expect(chip.style.top).toBe('40px');
        expect(chip.style.transform).toBe('translate(-50%, -50%)');
    });
});

describe('automationChipKey — the pure mapping the host resolves through', () => {
    it('names a key for the five kinds that get a chip', () => {
        expect(automationChipKey('condition-pass')).toBe('autoPass');
        expect(automationChipKey('condition-fail')).toBe('autoFail');
        expect(automationChipKey('chain-delay')).toBe('autoChain');
        expect(automationChipKey('sla-breach')).toBe('autoSlaBreach');
        expect(automationChipKey('sla-pass')).toBe('autoOnTime');
    });

    it('and NULL for trigger-flow, which is the default automation flow', () => {
        // The xyflow renderer gave it an empty label for the same reason: a pill
        // on every ordinary automation edge is noise, and the colour already
        // says the edge is automated.
        expect(automationChipKey('trigger-flow')).toBeNull();
    });

    it('and null for every document variant and anything unknown', () => {
        for (const k of ['flow', 'conditional', 'reference', 'nonsense', '']) {
            expect(automationChipKey(k)).toBeNull();
        }
    });

    it('every key it returns exists in the catalogue', () => {
        // The chip resolves through `t(key)`, so a key the catalogue lacks
        // renders "undefined" into the pill.
        const edges = en.automation.edges;
        for (const k of ['condition-pass', 'condition-fail', 'chain-delay', 'sla-breach', 'sla-pass']) {
            const key = automationChipKey(k)!;
            expect(typeof edges[key]).toBe('string');
            expect(edges[key]!.length).toBeGreaterThan(0);
        }
    });
});
