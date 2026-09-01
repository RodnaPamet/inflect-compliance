/**
 * VR-6 — the execution-overlay CONTEXT surface.
 *
 * `tests/unit/canvas-execution-overlay.test.ts` covers the pure
 * reducer. This file covers the two React exports, which were
 * previously unreached:
 *
 *   • `CanvasOverlayProvider` — the `enabled` flag has to switch BOTH
 *     the SWR key (to `null`, so no request is made at all) and the
 *     refresh interval (to 0). Switching only one of the two would
 *     leave Design Mode polling the live-executions endpoint every
 *     3 s for every open canvas.
 *   • `useNodeOverlayStatus` — must be safe to call with no provider
 *     above it (the node renderer is mounted bare in tests + SSR) and
 *     must not look up an undefined ruleId.
 */
import { render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';

interface LiveRow {
    ruleId: string;
    status: string;
    createdAt: string;
}
interface LiveResponse {
    running: LiveRow[];
    recent: LiveRow[];
}

const mockSWR = jest.fn<{ data: LiveResponse | undefined }, unknown[]>();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

import {
    CanvasOverlayProvider,
    useNodeOverlayStatus,
    type OverlayStatus,
} from '@/lib/processes/canvas-execution-overlay';
import { CACHE_KEYS } from '@/lib/swr-keys';

const LIVE_KEY = CACHE_KEYS.automation.executions.live();

function StatusProbe({ ruleId }: { ruleId: string | undefined }) {
    const status: OverlayStatus | undefined = useNodeOverlayStatus(ruleId);
    return <span data-testid="probe">{status ?? 'none'}</span>;
}

beforeEach(() => {
    mockSWR.mockReset();
    mockSWR.mockReturnValue({ data: undefined });
});

describe('CanvasOverlayProvider — poll wiring', () => {
    it('subscribes to the live-executions key on a 3s cadence when enabled', () => {
        render(
            <CanvasOverlayProvider enabled>
                <span>child</span>
            </CanvasOverlayProvider>,
        );
        expect(mockSWR).toHaveBeenCalledWith(LIVE_KEY, {
            refreshInterval: 3000,
        });
    });

    it('passes a NULL key AND a zero interval when disabled', () => {
        // Both halves matter: a null key is what actually suppresses
        // the request, and a non-zero interval on a null key would
        // still churn SWR's timer bookkeeping in Design Mode.
        render(
            <CanvasOverlayProvider enabled={false}>
                <span>child</span>
            </CanvasOverlayProvider>,
        );
        expect(mockSWR).toHaveBeenCalledWith(null, { refreshInterval: 0 });
        expect(mockSWR).not.toHaveBeenCalledWith(
            LIVE_KEY,
            expect.anything(),
        );
    });

    it('renders its children regardless of the poll result', () => {
        render(
            <CanvasOverlayProvider enabled>
                <span>canvas-child</span>
            </CanvasOverlayProvider>,
        );
        expect(screen.getByText('canvas-child')).toBeInTheDocument();
    });
});

describe('useNodeOverlayStatus', () => {
    it('returns undefined with no provider above it', () => {
        // The node renderer mounts bare in isolation tests and in SSR;
        // the default context value must be a real empty Map, not
        // undefined, or every such render would throw.
        const { result } = renderHook(() => useNodeOverlayStatus('rule-1'));
        expect(result.current).toBeUndefined();
    });

    it('returns undefined for an undefined ruleId even when the map is populated', () => {
        mockSWR.mockReturnValue({
            data: {
                running: [
                    {
                        ruleId: 'rule-1',
                        status: 'RUNNING',
                        createdAt: '2026-06-08T00:00:00Z',
                    },
                ],
                recent: [],
            },
        });
        render(
            <CanvasOverlayProvider enabled>
                <StatusProbe ruleId={undefined} />
            </CanvasOverlayProvider>,
        );
        expect(screen.getByTestId('probe')).toHaveTextContent('none');
    });

    it('projects the running status onto the node that owns the rule', () => {
        mockSWR.mockReturnValue({
            data: {
                running: [
                    {
                        ruleId: 'rule-1',
                        status: 'RUNNING',
                        createdAt: '2026-06-08T00:00:00Z',
                    },
                ],
                recent: [
                    {
                        ruleId: 'rule-2',
                        status: 'FAILED',
                        createdAt: '2026-06-08T00:00:00Z',
                    },
                ],
            },
        });
        render(
            <CanvasOverlayProvider enabled>
                <StatusProbe ruleId="rule-1" />
                <StatusProbe ruleId="rule-2" />
                <StatusProbe ruleId="rule-absent" />
            </CanvasOverlayProvider>,
        );
        const probes = screen.getAllByTestId('probe');
        expect(probes.map((p) => p.textContent)).toStrictEqual([
            'RUNNING',
            'FAILED',
            'none',
        ]);
    });

    it('reports no status while the poll has not returned yet', () => {
        mockSWR.mockReturnValue({ data: undefined });
        render(
            <CanvasOverlayProvider enabled>
                <StatusProbe ruleId="rule-1" />
            </CanvasOverlayProvider>,
        );
        expect(screen.getByTestId('probe')).toHaveTextContent('none');
    });
});
