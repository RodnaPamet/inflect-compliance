/**
 * Every node kind renders its label, subtitle and type signalling.
 *
 * ═══ WHAT IS MOCKED, AND WHY ONLY THAT ═══
 *
 * `HTMLContainer` is tldraw's positioning wrapper and needs an live editor
 * context to mount. It is replaced with a plain `div` that forwards className
 * and data-attributes, because the thing under test is not tldraw's container —
 * it is whether ONE parameterised util produces the right per-kind output from
 * `NODE_TAXONOMY`. Mocking the util itself would leave nothing.
 *
 * The mock uses `...jest.requireActual('tldraw')` rather than listing exports.
 * A mock that ENUMERATES a module's exports is a snapshot of that module as it
 * looked the day it was written, and the next import from the same module
 * resolves to undefined with no error that names the cause.
 *
 * ═══ THE POPULATION IS THE TAXONOMY ═══
 *
 * The cases are generated from `NODE_TAXONOMY`, so a kind added later is
 * covered the day it is added rather than the day somebody remembers this
 * file. The count is asserted so an empty or shrunken population cannot pass
 * by vacuity.
 */
import { render, screen, cleanup } from '@testing-library/react';

jest.mock('tldraw', () => ({
    ...jest.requireActual('tldraw'),
    HTMLContainer: ({
        children,
        ...rest
    }: { children?: React.ReactNode } & Record<string, unknown>) => (
        <div {...(rest as Record<string, unknown>)}>{children}</div>
    ),
}));

/*
    VR-6 — the overlay provider polls through `useTenantSWR`, so it is stubbed
    here and its return value set per test. Stubbed rather than avoided: the
    alternative is reaching into the context directly, and `OverlayContext` is
    deliberately not exported — a test that bypassed the provider would stop
    exercising `buildOverlayMap`, which is the part that decides what a node
    actually shows.
*/
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: jest.fn(() => ({ data: undefined })),
}));

// Imported AFTER the mock, so the util picks up the stubbed container.
const { ProcessNodeShapeUtil } = require('@/components/processes/tldraw/ProcessNodeShapeUtil') as typeof import('@/components/processes/tldraw/ProcessNodeShapeUtil');
const { NODE_TAXONOMY, NODE_ACCENT_BORDER } = require('@/components/processes/node-taxonomy') as typeof import('@/components/processes/node-taxonomy');
const { PROCESS_NODE_SHAPE_TYPE } = require('@/components/processes/tldraw/process-node-shape') as typeof import('@/components/processes/tldraw/process-node-shape');

const { CanvasOverlayProvider } =
    require('@/lib/processes/canvas-execution-overlay') as typeof import('@/lib/processes/canvas-execution-overlay');
const { ruleIdFromDataJson } =
    require('@/components/processes/tldraw/ProcessNodeShapeUtil') as typeof import('@/components/processes/tldraw/ProcessNodeShapeUtil');
const { useTenantSWR } =
    require('@/lib/hooks/use-tenant-swr') as { useTenantSWR: jest.Mock };

type Kind = keyof typeof NODE_TAXONOMY;

/**
 * A prototype-bound instance WITHOUT running the constructor, which wants a
 * live editor. `component()` reads only its argument and the taxonomy, so it
 * needs no instance state — and constructing a real editor to render one box
 * would test tldraw rather than this util.
 */
const util = Object.create(
    ProcessNodeShapeUtil.prototype,
) as InstanceType<typeof ProcessNodeShapeUtil>;

function shapeOf(kind: Kind, over: Partial<Record<string, unknown>> = {}) {
    return {
        id: `shape:${kind}-1`,
        type: PROCESS_NODE_SHAPE_TYPE,
        x: 0,
        y: 0,
        rotation: 0,
        index: 'a1',
        parentId: 'page:page',
        isLocked: false,
        opacity: 1,
        meta: {},
        typeName: 'shape',
        props: {
            w: 220,
            h: 88,
            nodeKey: `${kind}-1`,
            nodeType: kind,
            label: `${kind} label`,
            subtitle: null,
            parentNodeKey: null,
            dataJson: null,
            ...over,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

const KINDS = Object.keys(NODE_TAXONOMY) as Kind[];

afterEach(cleanup);

describe('the process node shape renders every kind', () => {
    it('the population is the whole taxonomy — an empty sweep proves nothing', () => {
        expect(KINDS.length).toBe(12);
    });

    it.each(KINDS)('%s renders its label and declares its type', (kind) => {
        render(util.component(shapeOf(kind)));
        const el = screen.getByTestId(`process-node-${kind}-1`);

        expect(el).toBeInTheDocument();
        expect(el).toHaveTextContent(`${kind} label`);
        // The stored kind reaches the DOM verbatim, so anything downstream
        // (E2E, the inspector) can select on what the ROW says rather than on
        // a rendering detail.
        expect(el).toHaveAttribute('data-node-type', kind);
    });

    it.each(KINDS)('%s signals its handle capability in the DOM', (kind) => {
        render(util.component(shapeOf(kind)));
        const el = screen.getByTestId(`process-node-${kind}-1`);
        expect(el).toHaveAttribute(
            'data-has-handles',
            NODE_TAXONOMY[kind].hasHandles ? 'true' : 'false',
        );
    });

    it('renders a subtitle when the row has one, and omits it otherwise', () => {
        render(util.component(shapeOf('processStep', { subtitle: 'Finance team' })));
        expect(screen.getByTestId('process-node-processStep-1')).toHaveTextContent(
            'Finance team',
        );
        cleanup();
        render(util.component(shapeOf('processStep')));
        expect(screen.getByTestId('process-node-processStep-1')).not.toHaveTextContent(
            'Finance team',
        );
    });

    it('renders an UNKNOWN kind rather than throwing', () => {
        // `nodeType` is `z.string()` on the wire, so this is a state the
        // product can be in — a map written by a newer client. A canvas that
        // will not open is worse than one that draws a plain box.
        expect(() =>
            render(util.component(shapeOf('processStep' as Kind, { nodeType: 'notAKind' }))),
        ).not.toThrow();
        const el = screen.getByTestId('process-node-processStep-1');
        // The stored value is still what reaches the DOM — the fallback
        // affects how it LOOKS, never what it claims to be.
        expect(el).toHaveAttribute('data-node-type', 'notAKind');
    });

    it('keeps `dataJson` out of the DOM entirely', () => {
        // It is a forward-compatibility slot, opaque by contract. Rendering
        // any of it would make this component a consumer of a payload that
        // exists so it has none — and could leak a value nobody meant to show.
        render(
            util.component(
                shapeOf('processStep', { dataJson: { secretish: 'DO-NOT-RENDER-7f3a' } }),
            ),
        );
        expect(screen.getByTestId('process-node-processStep-1').outerHTML).not.toContain(
            'DO-NOT-RENDER-7f3a',
        );
    });
});

/**
 * VR-6 — the live execution overlay, on the real node renderer (#3115).
 *
 * The provider's own gating and the pure reducer are covered in
 * `canvas-execution-overlay-provider` and `canvas-execution-overlay`. What is
 * only reachable here is the node: that it resolves its rule from the opaque
 * `dataJson`, reads the context, and paints — which is the wire the cutover
 * left disconnected.
 *
 * Every positive case MOUNTS THE PROVIDER, and that is not ceremony. Without
 * one the context holds an empty map, so `useNodeOverlayStatus` returns
 * undefined and the node renders byte-identically to a correctly-unpainted
 * node. An assertion written without the provider would pass for the wrong
 * reason, permanently.
 */
describe('a node paints its rule\'s live execution state', () => {
    const RUNNING_RULE = 'rule-running-9';
    const FAILED_RULE = 'rule-failed-4';

    beforeEach(() => {
        useTenantSWR.mockReturnValue({
            data: {
                running: [
                    { ruleId: RUNNING_RULE, status: 'RUNNING', createdAt: '2026-10-02T00:00:00Z' },
                ],
                recent: [
                    { ruleId: FAILED_RULE, status: 'FAILED', createdAt: '2026-10-02T00:00:00Z' },
                ],
            },
        });
    });

    const renderInRunMode = (dataJson: unknown) =>
        render(
            <CanvasOverlayProvider enabled>
                {util.component(shapeOf('action' as Kind, { dataJson }))}
            </CanvasOverlayProvider>,
        );
    const node = () => screen.getByTestId('process-node-action-1');

    it('paints RUNNING on the node whose rule is executing', () => {
        renderInRunMode({ ruleId: RUNNING_RULE });
        expect(node()).toHaveAttribute('data-overlay-status', 'RUNNING');
        // The class too, because the attribute is for tests and the class is
        // what a user sees — asserting only the attribute would let the paint
        // be dropped while the test stayed green.
        expect(node().className).toContain('animate-pulse');
    });

    it('and FAILED from a recently-finished run, so a node still flashes', () => {
        renderInRunMode({ ruleId: FAILED_RULE });
        expect(node()).toHaveAttribute('data-overlay-status', 'FAILED');
        expect(node().className).toContain('ring-content-error');
    });

    it('leaves a node whose rule is NOT in the response unpainted', () => {
        renderInRunMode({ ruleId: 'rule-nobody-is-running' });
        expect(node()).not.toHaveAttribute('data-overlay-status');
        expect(node().className).not.toContain('animate-pulse');
    });

    it('and a node naming no rule at all is never painted', () => {
        // Every node on a DOCUMENT map is this case.
        renderInRunMode(null);
        expect(node()).not.toHaveAttribute('data-overlay-status');
    });

    it('the ring is applied ON TOP of the accent border, not instead of it', () => {
        // The overlay is appended last to the class list. If it replaced the
        // chassis classes a running node would lose its type signalling at
        // exactly the moment someone is watching it.
        renderInRunMode({ ruleId: RUNNING_RULE });
        const cls = node().className;
        expect(cls).toContain('animate-pulse');
        expect(cls).toContain(NODE_ACCENT_BORDER[NODE_TAXONOMY.action.accent]);
    });

    it('still keeps `dataJson` out of the DOM — the id is READ, not rendered', () => {
        /*
            The sibling assertion above calls `dataJson` "opaque by contract",
            and this change makes the node a reader of it. Those are compatible
            and the distinction is the whole point: what reaches the DOM is the
            STATUS, never the id. A debugging attribute carrying the ruleId
            would publish a payload the component exists not to render.
        */
        renderInRunMode({ ruleId: RUNNING_RULE, secretish: 'DO-NOT-RENDER-9b2c' });
        const html = node().outerHTML;
        expect(html).not.toContain(RUNNING_RULE);
        expect(html).not.toContain('DO-NOT-RENDER-9b2c');
        // …and it did resolve, so this is not passing by rendering nothing.
        expect(node()).toHaveAttribute('data-overlay-status', 'RUNNING');
    });

    it('renders with NO provider above it, which is why the above mount one', () => {
        // The module's header states this as a design property: a node must
        // still render in isolation and under SSR. It is also the control for
        // every assertion in this describe.
        expect(() =>
            render(util.component(shapeOf('action' as Kind, { dataJson: { ruleId: RUNNING_RULE } }))),
        ).not.toThrow();
        expect(node()).not.toHaveAttribute('data-overlay-status');
    });
});

/** The pure half: which rule a node names, given an opaque payload. */
describe('ruleIdFromDataJson', () => {
    it('reads a string ruleId', () => {
        expect(ruleIdFromDataJson({ ruleId: 'rule-1' })).toBe('rule-1');
    });

    it('returns undefined for null, which is the common case', () => {
        // `typeof null === 'object'`, so this is the arm a property read alone
        // would turn into a TypeError on every document node.
        expect(ruleIdFromDataJson(null)).toBeUndefined();
    });

    it('and for every shape that is not an object carrying a string', () => {
        for (const v of [undefined, 'rule-1', 42, true, [], {}, { ruleId: 7 }, { ruleId: null }]) {
            expect(ruleIdFromDataJson(v)).toBeUndefined();
        }
    });

    it('treats an EMPTY string as no rule', () => {
        // `''` would be a falsy id that still passes a typeof check, and
        // `map.get('')` is a lookup that can only ever miss.
        expect(ruleIdFromDataJson({ ruleId: '' })).toBeUndefined();
    });

    it('ignores sibling keys, because the payload is a passthrough', () => {
        expect(ruleIdFromDataJson({ size: 'lg', linkedEntityId: 'x', ruleId: 'rule-2' })).toBe(
            'rule-2',
        );
    });
});
