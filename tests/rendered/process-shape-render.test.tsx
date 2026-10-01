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

// Imported AFTER the mock, so the util picks up the stubbed container.
const { ProcessNodeShapeUtil } = require('@/components/processes/tldraw/ProcessNodeShapeUtil') as typeof import('@/components/processes/tldraw/ProcessNodeShapeUtil');
const { NODE_TAXONOMY } = require('@/components/processes/node-taxonomy') as typeof import('@/components/processes/node-taxonomy');
const { PROCESS_NODE_SHAPE_TYPE } = require('@/components/processes/tldraw/process-node-shape') as typeof import('@/components/processes/tldraw/process-node-shape');

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
