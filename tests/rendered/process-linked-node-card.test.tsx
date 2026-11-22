/**
 * A control, risk or asset node's card shows its linked record's live state.
 *
 * The facts come from `GET /processes/:id/<kind>-facts` through `useTenantSWR`,
 * which is stubbed here with what each route returns (the provider asks for
 * controls, then risks, then assets, on every render); everything between
 * those responses and the DOM — the state choice, the translated text, the
 * shape's rendering — runs for real, in English.
 *
 * `HTMLContainer` is a plain div for the reason `process-shape-render.test.tsx`
 * gives: it needs a live editor, and the subject is the util's output.
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
const { CanvasLinkedFactsProvider } =
    require('@/lib/processes/canvas-linked-facts') as typeof import('@/lib/processes/canvas-linked-facts');
const { useTenantSWR } = require('@/lib/hooks/use-tenant-swr') as { useTenantSWR: jest.Mock };

const util = Object.create(ProcessNodeShapeUtil.prototype) as InstanceType<typeof ProcessNodeShapeUtil>;

function shape(nodeType: string, link: Record<string, string | null> = {}) {
    return {
        id: `shape:${nodeType}-1`,
        type: PROCESS_NODE_SHAPE_TYPE,
        x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false,
        opacity: 1, meta: {}, typeName: 'shape',
        props: {
            w: 220, h: 88, nodeKey: 'n1', nodeType, label: 'Approve payment',
            subtitle: null, parentNodeKey: null, dataJson: null,
            controlId: null, riskId: null, assetId: null,
            ...link,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

type Read = { data?: unknown; error?: unknown };

/** Renders one node under the provider, answering the three reads in order. */
function renderCard(
    node: ReturnType<typeof shape>,
    reads: { control?: Read; risk?: Read; asset?: Read } = {},
) {
    const order: Read[] = [reads.control ?? {}, reads.risk ?? {}, reads.asset ?? {}];
    let call = 0;
    useTenantSWR.mockImplementation(() => order[call++ % 3]);
    render(
        <NextIntlClientProvider locale="en" messages={EN}>
            <CanvasLinkedFactsProvider editor={null} mapId="map-1" version={3}>
                {util.component(node)}
            </CanvasLinkedFactsProvider>
        </NextIntlClientProvider>,
    );
    return screen.queryByTestId('process-node-link-n1');
}

const CONTROL = {
    id: 'ctl-1', code: 'A.5.15', name: 'Access control', status: 'IMPLEMENTED',
    effectiveness: 72, lastTested: '2026-10-03T09:00:00.000Z',
};
const RISK = {
    id: 'risk-1', key: 'R-12', title: 'Ransomware on payroll', status: 'MITIGATING',
    treatment: 'TREAT', score: 12, scoreKind: 'RESIDUAL', inherentScore: 20,
    band: { name: 'High', color: '#ef4444' }, reviewOverdue: false,
    mitigation: { onMap: 1, total: 3 },
};
const ASSET = {
    id: 'asset-1', key: 'A-3', name: 'Payroll DB', type: 'DATA_STORE',
    criticality: 'HIGH', status: 'ACTIVE',
};
const riskRead = (over: Record<string, unknown> = {}): Read => ({
    data: { restricted: false, risks: { 'risk-1': { ...RISK, ...over } }, missing: [] },
});

afterEach(() => {
    cleanup();
    useTenantSWR.mockReset();
});

describe("a control node's card", () => {
    it('linked: code and name, then status, effectiveness and last test', () => {
        const card = renderCard(shape('control', { controlId: 'ctl-1' }), {
            control: { data: { restricted: false, controls: { 'ctl-1': CONTROL }, missing: [] } },
        });
        expect(card).toHaveAttribute('data-link-state', 'linked');
        expect(card).toHaveAttribute('data-link-status', 'IMPLEMENTED');
        expect(card).toHaveTextContent('A.5.15 · Access control');
        expect(card).toHaveTextContent('Implemented · 72% effective · tested');
        expect(screen.getByTestId('process-node-n1')).toHaveTextContent('Approve payment');
    });

    it('unlinked: asks for a control and draws the node dashed', () => {
        const card = renderCard(shape('control'));
        expect(card).toHaveAttribute('data-link-state', 'unlinked');
        expect(card).toHaveTextContent('Pick a control');
        expect(screen.getByTestId('process-node-n1').className).toContain('border-dashed');
    });

    it('removed, restricted, loading and unavailable are four different things', () => {
        const node = () => shape('control', { controlId: 'ctl-1' });
        expect(renderCard(node(), { control: { data: { restricted: false, controls: {}, missing: ['ctl-1'] } } }))
            .toHaveTextContent('Control removed');
        cleanup();
        const restricted = renderCard(node(), { control: { data: { restricted: true, controls: {}, missing: [] } } });
        expect(restricted).toHaveTextContent('Control (restricted)');
        expect(restricted).not.toHaveAttribute('data-link-status');
        cleanup();
        expect(renderCard(node(), { control: { data: { restricted: false, controls: {}, missing: [] } } }))
            .toHaveAttribute('data-link-state', 'loading');
        cleanup();
        const failed = renderCard(node(), { control: { error: new Error('503') } });
        expect(failed).toHaveAttribute('data-link-state', 'unavailable');
        expect(failed).not.toHaveTextContent('removed');
    });
});

describe("a risk node's card", () => {
    it('linked: key and title, the tenant band, residual score with inherent, status, treatment and mitigation', () => {
        const card = renderCard(shape('risk', { riskId: 'risk-1' }), { risk: riskRead() });
        expect(card).toHaveAttribute('data-link-state', 'linked');
        expect(card).toHaveTextContent('R-12 · Ransomware on payroll');
        expect(screen.getByTestId('process-node-band-n1')).toHaveTextContent('High');
        expect(card).toHaveTextContent('12 residual (inherent 20) · Mitigating · Treat');
        expect(screen.getByTestId('process-node-link-note-n1')).toHaveTextContent(
            'mitigated here by 1 of 3 controls',
        );
    });

    it('leads with the inherent score when no residual is assessed, and shows no chip outside every band', () => {
        renderCard(shape('risk', { riskId: 'risk-1' }), {
            risk: riskRead({ scoreKind: 'INHERENT', score: 20, band: null }),
        });
        expect(screen.getByTestId('process-node-link-n1')).toHaveTextContent('20 inherent');
        expect(screen.queryByTestId('process-node-band-n1')).toBeNull();
    });

    it.each([
        [{ mitigation: { onMap: 0, total: 2 } }, 'no mitigating control on this map'],
        [{ mitigation: { onMap: 0, total: 0 } }, 'no mitigating control'],
    ])('warns when the map carries none of its controls (%#)', (over, text) => {
        renderCard(shape('risk', { riskId: 'risk-1' }), { risk: riskRead(over) });
        const note = screen.getByTestId('process-node-link-note-n1');
        expect(note).toHaveTextContent(text);
        expect(note.className).toContain('text-content-warning');
    });

    it('says when its review is overdue', () => {
        renderCard(shape('risk', { riskId: 'risk-1' }), { risk: riskRead({ reviewOverdue: true }) });
        expect(screen.getByTestId('process-node-link-note-n1')).toHaveTextContent('review overdue');
    });

    it('unlinked and restricted, as for controls, in the risk words', () => {
        expect(renderCard(shape('risk'))).toHaveTextContent('Pick a risk');
        cleanup();
        const restricted = renderCard(shape('risk', { riskId: 'risk-1' }), {
            risk: { data: { restricted: true, risks: {}, missing: [] } },
        });
        expect(restricted).toHaveTextContent('Risk (restricted)');
        expect(restricted).not.toHaveTextContent('Ransomware');
    });
});

describe("an asset node's card", () => {
    it('linked: key and name, then type and criticality', () => {
        const card = renderCard(shape('asset', { assetId: 'asset-1' }), {
            asset: { data: { restricted: false, assets: { 'asset-1': ASSET }, missing: [] } },
        });
        expect(card).toHaveTextContent('A-3 · Payroll DB');
        expect(card).toHaveTextContent('Data store · High criticality');
    });

    it('a retired asset still on a map says so, in warning tone', () => {
        const card = renderCard(shape('asset', { assetId: 'asset-1' }), {
            asset: { data: { restricted: false, assets: { 'asset-1': { ...ASSET, status: 'RETIRED' } }, missing: [] } },
        });
        expect(card).toHaveTextContent('Retired');
        expect(card?.querySelector('.text-content-warning')).not.toBeNull();
    });

    it('a deleted asset reads as removed', () => {
        expect(
            renderCard(shape('asset', { assetId: 'asset-9' }), {
                asset: { data: { restricted: false, assets: {}, missing: ['asset-9'] } },
            }),
        ).toHaveTextContent('Asset removed');
    });
});

describe('every other kind', () => {
    it('shows no card, even if a link field were somehow set', () => {
        expect(renderCard(shape('processStep', { riskId: 'risk-1' }), { risk: riskRead() })).toBeNull();
    });

    it('with no provider mounted, a linked node draws its label and no card', () => {
        render(util.component(shape('risk', { riskId: 'risk-1' })));
        expect(screen.getByTestId('process-node-n1')).toHaveTextContent('Approve payment');
        expect(screen.queryByTestId('process-node-link-n1')).toBeNull();
    });
});
