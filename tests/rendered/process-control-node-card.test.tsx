/**
 * A `control` node's card shows its linked Control's live state, and only that.
 *
 * The card's facts come from `GET /processes/:id/control-facts` through
 * `useTenantSWR`, which is stubbed here with the response the route returns;
 * everything between that response and the DOM (the provider's state choice,
 * its translated text, the shape's rendering) runs for real, in English.
 *
 * `HTMLContainer` is replaced with a plain div for the reason
 * `process-shape-render.test.tsx` gives: it needs a live editor to mount, and
 * the subject is the util's output, not tldraw's container.
 */
import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

jest.mock('tldraw', () => ({
    ...jest.requireActual('tldraw'),
    HTMLContainer: ({
        children,
        ...rest
    }: { children?: React.ReactNode } & Record<string, unknown>) => (
        <div {...(rest as Record<string, unknown>)}>{children}</div>
    ),
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: jest.fn(() => ({ data: undefined })),
}));

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown>;

const { ProcessNodeShapeUtil } =
    require('@/components/processes/tldraw/ProcessNodeShapeUtil') as typeof import('@/components/processes/tldraw/ProcessNodeShapeUtil');
const { PROCESS_NODE_SHAPE_TYPE } =
    require('@/components/processes/tldraw/process-node-shape') as typeof import('@/components/processes/tldraw/process-node-shape');
const { CanvasControlFactsProvider } =
    require('@/lib/processes/canvas-control-facts') as typeof import('@/lib/processes/canvas-control-facts');
const { useTenantSWR } = require('@/lib/hooks/use-tenant-swr') as { useTenantSWR: jest.Mock };

const util = Object.create(ProcessNodeShapeUtil.prototype) as InstanceType<typeof ProcessNodeShapeUtil>;

function shape(nodeType: string, controlId: string | null) {
    return {
        id: `shape:${nodeType}-1`,
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
            nodeKey: 'n1',
            nodeType,
            label: 'Approve payment',
            subtitle: null,
            parentNodeKey: null,
            dataJson: null,
            controlId,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function renderCard(nodeType: string, controlId: string | null, response: unknown, error?: unknown) {
    useTenantSWR.mockReturnValue({ data: response, error });
    render(
        <NextIntlClientProvider locale="en" messages={EN}>
            <CanvasControlFactsProvider editor={null} mapId="map-1">
                {util.component(shape(nodeType, controlId))}
            </CanvasControlFactsProvider>
        </NextIntlClientProvider>,
    );
    return screen.queryByTestId('process-node-control-n1');
}

const FACT = {
    id: 'ctl-1',
    code: 'A.5.15',
    name: 'Access control',
    status: 'IMPLEMENTED',
    effectiveness: 72,
    lastTested: '2026-10-03T09:00:00.000Z',
};

afterEach(() => {
    cleanup();
    useTenantSWR.mockReset();
});

describe("a control node's card", () => {
    it('linked: the control’s code and name, then status, effectiveness and last test', () => {
        const card = renderCard('control', 'ctl-1', {
            restricted: false,
            controls: { 'ctl-1': FACT },
            missing: [],
        });
        expect(card).toHaveAttribute('data-control-state', 'linked');
        expect(card).toHaveAttribute('data-control-status', 'IMPLEMENTED');
        expect(card).toHaveTextContent('A.5.15 · Access control');
        expect(card).toHaveTextContent('Implemented · 72% effective · tested');
        // The node's own label still heads the box; the card sits under it.
        expect(screen.getByTestId('process-node-n1')).toHaveTextContent('Approve payment');
    });

    it('unlinked: asks for a control and draws the node dashed', () => {
        const card = renderCard('control', null, undefined);
        expect(card).toHaveAttribute('data-control-state', 'unlinked');
        expect(card).toHaveTextContent('Pick a control');
        expect(screen.getByTestId('process-node-n1').className).toContain('border-dashed');
    });

    it('removed: a control the read did not find says so, and shows no name', () => {
        const card = renderCard('control', 'ctl-gone', {
            restricted: false,
            controls: {},
            missing: ['ctl-gone'],
        });
        expect(card).toHaveAttribute('data-control-state', 'missing');
        expect(card).toHaveTextContent('Control removed');
    });

    it('restricted: a viewer who cannot read controls sees no name or status', () => {
        const card = renderCard('control', 'ctl-1', { restricted: true, controls: {}, missing: [] });
        expect(card).toHaveAttribute('data-control-state', 'restricted');
        expect(card).toHaveTextContent('Control (restricted)');
        expect(card).not.toHaveTextContent('Access control');
        expect(card).not.toHaveAttribute('data-control-status');
    });

    it('loading: a link not yet answered for is loading, never "removed"', () => {
        const card = renderCard('control', 'ctl-new', {
            restricted: false,
            controls: { 'ctl-1': FACT },
            missing: [],
        });
        expect(card).toHaveAttribute('data-control-state', 'loading');
    });

    it('a failed read is "unavailable", never "removed"', () => {
        const card = renderCard('control', 'ctl-1', undefined, new Error('503'));
        expect(card).toHaveAttribute('data-control-state', 'unavailable');
        expect(card).not.toHaveTextContent('Control removed');
    });

    it('any other kind of node shows no card, even when a link is present', () => {
        expect(
            renderCard('risk', 'ctl-1', { restricted: false, controls: { 'ctl-1': FACT }, missing: [] }),
        ).toBeNull();
    });

    it('with no provider mounted, a control node draws its label and no card', () => {
        render(util.component(shape('control', 'ctl-1')));
        expect(screen.getByTestId('process-node-n1')).toHaveTextContent('Approve payment');
        expect(screen.queryByTestId('process-node-control-n1')).toBeNull();
    });
});
