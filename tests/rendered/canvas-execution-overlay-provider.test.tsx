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
 *     above it (the node renderer is mounted bare in tests + SSR).
 *
 * The `ruleId ? … : undefined` guard inside `useNodeOverlayStatus` is
 * NOT tested here: `map.get(undefined)` already returns `undefined`,
 * so removing the guard changes nothing an assertion could observe.
 */
import { render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';

/**
 * The two arrays `listLiveExecutions` returns (#3546).
 *
 * This said `running` / `recent` — and `running` is a field the endpoint has
 * never returned, so the mock, the reducer and two other test files all
 * described the same non-existent response and agreed with each other.
 *
 * Still a local shape rather than the derived one the overlay now uses: the
 * mock's job is to stand in for the WIRE, and spelling only the two fields the
 * provider reads keeps these fixtures legible. The derived type in the module
 * is what stops the NAMES drifting again.
 */
interface LiveRow {
    ruleId: string;
    status: string;
    createdAt: string;
}
interface LiveResponse {
    stuck: LiveRow[];
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

function StatusProbe({ ruleId }: { ruleId: string }) {
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
});

describe('useNodeOverlayStatus', () => {
    it('returns undefined with no provider above it', () => {
        // The node renderer mounts bare in isolation tests and in SSR;
        // the default context value must be a real empty Map, not
        // undefined, or every such render would throw.
        const { result } = renderHook(() => useNodeOverlayStatus('rule-1'));
        expect(result.current).toBeUndefined();
    });

    it('projects the status onto the node that owns the rule', () => {
        /*
            THE THIRD FIXTURE THAT CONSTRUCTED `running` (#3546).

            `listLiveExecutions` returns `{ stuck, recent }` and never a
            `running` key, so this fixture — like the reducer it exercised and
            the two other test files that built the same shape — described a
            response the endpoint has never produced. All three agreed with
            each other and none agreed with the API.

            `recent` is every execution newest-first, RUNNING ones included,
            which is how a running rule's node has always been painted in
            production; `stuck` is what the endpoint fills for an execution
            past that rule's own deadline.
        */
        mockSWR.mockReturnValue({
            data: {
                stuck: [],
                recent: [
                    {
                        ruleId: 'rule-1',
                        status: 'RUNNING',
                        createdAt: '2026-06-08T00:00:00Z',
                    },
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
});
