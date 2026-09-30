/**
 * @jest-environment jsdom
 *
 * The inspector's text inputs stop where the server stops.
 *
 * ── The defect this closes ───────────────────────────────────────────
 *
 * `ProcessNodeInput.label` / `.subtitle` and `ProcessEdgeInput.labelOverride`
 * are bounded at 200 characters server-side. Nothing bounded them client-side:
 * the three inspector inputs carried no `maxLength`, and `processNodeShapeProps`
 * declares bare `T.string`. So a user could type a 300-character label, keep
 * working, and learn only at save time — the API refuses the write and the
 * autosave chip shows a zod string in its `title`.
 *
 * Measured on the live path, not hypothesised: the serializer passes the long
 * value through faithfully (round-trip identity holds) and
 * `SaveProcessMapSchema` refuses it with
 * `nodes.0.label: Too big: expected string to have <=200 characters`.
 *
 * The bound was four bare `200`s in the schema and nothing anywhere else. It is
 * now `MAX_GRAPH_TEXT_LENGTH`, exported, and the inputs import it.
 *
 * ── Why this test does not compare the constant to itself ─────────────
 *
 * The obvious assertion — `expect(input.maxLength).toBe(MAX_GRAPH_TEXT_LENGTH)`
 * — is a **tautology** once both sides read the same constant, and would hold
 * even if the schema had stopped enforcing anything. I made exactly that
 * mistake earlier in this migration: an assertion compared a shape id against
 * the function that produced it, so mutating the function moved both sides
 * together and the test stayed green.
 *
 * So the bound is read off the **rendered DOM** and checked against the
 * schema's **runtime behaviour** — accepts N, refuses N+1. Two different
 * mechanisms, and nothing in the chain is the constant itself.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react';

import {
    ProcessEdgeInputSchema,
    ProcessNodeInputSchema,
} from '@/app-layer/schemas/process-map';
import { ProcessInspector } from '@/components/processes/ProcessInspector';

const NODE = {
    id: 'node-1',
    type: 'processStep',
    position: { x: 0, y: 0 },
    data: { label: 'Receive order', subtitle: 'Step', kind: 'processStep' },
};

const EDGE = {
    id: 'edge-1',
    source: 'node-1',
    target: 'node-2',
    data: { edgeKind: 'flow', label: 'approved' },
};

const node = (over: Record<string, unknown> = {}) => ({ ...NODE, ...over }) as any;

/** A valid node payload with one field swapped for the string under test. */
function nodeAccepts(field: 'label' | 'subtitle', value: string): boolean {
    return ProcessNodeInputSchema.safeParse({
        nodeKey: 'n1',
        nodeType: 'processStep',
        label: 'ok',
        subtitle: null,
        posX: 0,
        posY: 0,
        parentNodeKey: null,
        dataJson: null,
        [field]: value,
    }).success;
}

function edgeAcceptsLabel(value: string): boolean {
    return ProcessEdgeInputSchema.safeParse({
        edgeKey: 'e1',
        sourceKey: 'n1',
        targetKey: 'n2',
        edgeKind: 'flow',
        labelOverride: value,
        dataJson: null,
        controls: [],
    }).success;
}

/** The bound the browser will actually enforce, read from the element. */
function boundOf(testId: string): number {
    const el = screen.getByTestId(testId) as HTMLInputElement;
    // `maxLength` is -1 when the attribute is absent, which is the state this
    // test exists to prevent — asserted explicitly so an unbounded input fails
    // here rather than passing a comparison against -1.
    expect(el.maxLength).toBeGreaterThan(0);
    return el.maxLength;
}

describe('node label and subtitle', () => {
    beforeEach(() => {
        render(<ProcessInspector node={node()} onUpdate={jest.fn()} />);
    });

    it.each<['label' | 'subtitle', string]>([
        ['label', 'inspector-label-input'],
        ['subtitle', 'inspector-subtitle-input'],
    ])('%s stops exactly where the schema stops', (field, testId) => {
        const bound = boundOf(testId);

        // Accepts a string of exactly the length the browser permits...
        expect({ field, at: bound, accepted: nodeAccepts(field, 'x'.repeat(bound)) }).toEqual({
            field,
            at: bound,
            accepted: true,
        });
        // ...and refuses one character more. Without this half, a `maxLength`
        // far BELOW the server's would pass — the input would silently truncate
        // text the API would have accepted.
        expect({
            field,
            at: bound + 1,
            accepted: nodeAccepts(field, 'x'.repeat(bound + 1)),
        }).toEqual({ field, at: bound + 1, accepted: false });
    });
});

describe('edge label', () => {
    it('stops exactly where the schema stops', () => {
        render(
            <ProcessInspector node={null} edge={EDGE as any} onUpdate={jest.fn()} />,
        );
        const bound = boundOf('inspector-edge-label-input');
        expect(edgeAcceptsLabel('x'.repeat(bound))).toBe(true);
        expect(edgeAcceptsLabel('x'.repeat(bound + 1))).toBe(false);
    });
});
