/**
 * @jest-environment jsdom
 *
 * Version history, restore and the row-level diff, on the tldraw canvas.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * The regression list on #2962 records snapshots / restore / row-level diff as
 * unported, and that item BLOCKS the cutover rather than the flag: deleting
 * `PersistedProcessCanvas` while it is the only host offering restore would
 * remove a shipped capability from the product.
 *
 * All three turned out to be reusable as-is. `CanvasHistorySidebar` (246 lines),
 * `CanvasDiffOverlay` (297) and `canvas-diff.ts` (157) each carry ZERO xyflow
 * references, measured against `PersistedProcessCanvas`'s 19 as the control —
 * the same control that found the bar, palette and inspector reusable. So the
 * port is prop wiring and the server side is untouched.
 *
 * ── The one deliberate difference from the xyflow host ───────────────
 *
 * That host passes `currentSnapshot={buildLiveSnapshot(nodes, edges)}`,
 * recomputed in its render body on every pass. Doing the same here would be
 * wrong twice, and the first way is a crash: `serializeEditorCanvas` THROWS
 * `EdgeEndpointError`, where `serializeGraphForSave` contains no `throw` at
 * all. A throw from a render body takes the page down, and this is a read-only
 * "show me what changed" surface.
 *
 * So the live snapshot is captured ONCE, at click time, inside a try/catch.
 * Both halves of that are asserted below, because both are the point.
 */
import { act, render, screen } from '@testing-library/react';

import { TldrawProcessWorkspace } from '@/components/processes/TldrawProcessWorkspace';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';

/* ── the serializer seam ─────────────────────────────────────────── */

/** Swapped per test; the default is a well-formed two-node graph. */
let serializeImpl: () => { rows: GraphRows; freeform: unknown[] };
/** One entry per call, so "captured once" is measurable. */
const serializeCalls: number[] = [];

jest.mock('@/components/processes/tldraw/editor-canvas', () => ({
    serializeEditorCanvas: () => {
        serializeCalls.push(1);
        return serializeImpl();
    },
}));

/* ── the two components under wiring ─────────────────────────────── */

/** Props the sidebar was handed, plus handles to fire its callbacks. */
let sidebarMounts = 0;
let fireDiff: ((version: number) => void) | undefined;
let fireRestored: (() => void) | undefined;
let sidebarCurrentVersion: number | null | undefined;

jest.mock('@/components/processes/CanvasHistorySidebar', () => ({
    CanvasHistorySidebar: (props: {
        currentVersion?: number | null;
        onDiffRequest?: (version: number) => void;
        onRestored?: () => void;
    }) => {
        sidebarMounts += 1;
        fireDiff = props.onDiffRequest;
        fireRestored = props.onRestored;
        sidebarCurrentVersion = props.currentVersion;
        return <div data-testid="history-stub" />;
    },
}));

/** Every snapshot the overlay was given, in order. */
const overlayProps: Array<{
    targetVersion: number;
    currentVersion: number;
    snapshot: unknown;
}> = [];

jest.mock('@/components/processes/CanvasDiffOverlay', () => ({
    CanvasDiffOverlay: (props: {
        targetVersion: number;
        currentVersion: number;
        currentSnapshot: unknown;
    }) => {
        overlayProps.push({
            targetVersion: props.targetVersion,
            currentVersion: props.currentVersion,
            snapshot: props.currentSnapshot,
        });
        return <div data-testid="diff-stub" />;
    },
}));

/* ── the rest of the composition, irrelevant here ───────────────── */

/**
 * The minimum `Editor` the workspace's own hooks touch.
 *
 * ENUMERATED from the two hooks rather than grown one failure at a time:
 * `useTldrawDocumentBar` reads `getCanUndo` / `getCanRedo`, and
 * `useTldrawSelection` reads `getSelectedShapes` and subscribes via
 * `store.listen`. Both run on mount, so an editor missing any of them throws
 * during the first render and every test in the file fails on a stack that has
 * nothing to do with what it asserts — which is exactly what happened with a
 * one-property placeholder here.
 *
 * `updateShape` / `updateBinding` / `markHistoryStoppingPoint` are reachable
 * only through inspector edits, which this file does not exercise; they are
 * present so a future test that does exercise them fails on its assertion
 * rather than on the stub.
 */
const FAKE_EDITOR = {
    getCanUndo: () => false,
    getCanRedo: () => false,
    getSelectedShapes: () => [],
    getCurrentPageShapes: () => [],
    markHistoryStoppingPoint: () => {},
    updateShape: () => {},
    updateBinding: () => {},
    store: {
        // Returns the unsubscriber the effect's cleanup calls.
        listen: () => () => {},
        allRecords: () => [],
    },
};

/** Counts renders of the map, so a restore's remount is observable. */
const mapKeys: string[] = [];

jest.mock('@/components/processes/TldrawProcessMap', () => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    return {
        TldrawProcessMap: ({
            onEditorReady,
            onStateChange,
        }: {
            onEditorReady?: (e: unknown) => void;
            onStateChange?: (s: {
                version: number | undefined;
                autosaveStatus: AutosaveStatus;
            }) => void;
        }) => {
            // In an EFFECT, for the reason the sibling suite records: reporting
            // during render sets state in the parent mid-render, and the real
            // component does not do that.
            useEffect(() => {
                onEditorReady?.(FAKE_EDITOR);
                onStateChange?.({ version: 7, autosaveStatus: 'idle' });
            }, [onEditorReady, onStateChange]);
            mapKeys.push('render');
            return <div data-testid="map-stub" />;
        },
    };
});

/*
    VR-6 (#3115) — the overlay provider polls through `useTenantSWR`, so it is
    captured here rather than left live: an unmocked SWR with a real key would
    reach for the network in jsdom, and the KEY is exactly what these assertions
    are about — whether the poll is off on a document map.
*/
const swrCalls: Array<{ key: unknown; opts: unknown }> = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: unknown, opts: unknown) => {
        swrCalls.push({ key, opts });
        return { data: undefined };
    },
}));

/*
    The bar is stubbed, and the Run Mode toggle lives in the real one — so the
    stub carries a button that flips the flag. That is the seam the real bar
    occupies (`CanvasDocumentBar` calls the same `setRunMode`), which is what
    makes the ON direction assertable without mounting the whole bar.
*/
jest.mock('@/components/processes/CanvasDocumentBar', () => {
    const { useRunMode } =
        jest.requireActual<typeof import('@/lib/processes/run-mode-context')>(
            '@/lib/processes/run-mode-context',
        );
    return {
        CanvasDocumentBar: () => {
            const { isRunMode, setRunMode } = useRunMode();
            return (
                <div data-testid="bar-stub">
                    <button data-testid="run-mode-on" onClick={() => setRunMode(true)}>
                        {isRunMode ? 'on' : 'off'}
                    </button>
                </div>
            );
        },
    };
});
/** The inspector's props, so the workspace's wiring to it is assertable. */
const inspectorProps: Array<{ rendererHonoursSize?: boolean }> = [];
jest.mock('@/components/processes/ProcessInspector', () => ({
    ProcessInspector: (props: { rendererHonoursSize?: boolean }) => {
        inspectorProps.push({ rendererHonoursSize: props.rendererHonoursSize });
        return <div data-testid="inspector-stub" />;
    },
}));
jest.mock('@/components/processes/ProcessPalette', () => ({
    ProcessPalette: () => <div data-testid="palette-stub" />,
}));

/** Captures the error toast without replacing the barrel wholesale. */
const toastErrors: string[] = [];
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({
        success: () => 0,
        error: (m: string) => {
            toastErrors.push(m);
            return 0;
        },
        info: () => 0,
        warning: () => 0,
        dismiss: () => {},
    }),
}));

/* ── fixtures ───────────────────────────────────────────────────── */

/**
 * `subtitle`, `parentNodeKey` and `dataJson` are ABSENT, not null.
 *
 * That is the real shape: `ProcessNodeInputSchema` declares all three
 * `.optional()`, which is what made `GraphRows` unassignable to
 * `DiffGraphSnapshot` and is the reason `toDiffSnapshot` exists. A fixture that
 * spelled them as `null` would make the normaliser untested.
 */
const ROWS: GraphRows = {
    nodes: [{ nodeKey: 'n1', nodeType: 'processStep', label: 'Receive', posX: 0, posY: 0 }],
    edges: [{ edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n1', edgeKind: 'flow', controls: [] }],
};

/** The minimum the overlay bridge's URL resolution needs. */
const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as never;

const PROCESSES = [
    {
        id: 'map-1',
        name: 'Invoice approval',
        description: null,
        status: 'DRAFT' as const,
        version: 7,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        nodeCount: 1,
        edgeCount: 0,
        canvasMode: 'DOCUMENT' as const,
    },
];

function mount(activeId: string | null = 'map-1') {
    serializeCalls.length = 0;
    inspectorProps.length = 0;
    overlayProps.length = 0;
    toastErrors.length = 0;
    mapKeys.length = 0;
    sidebarMounts = 0;
    serializeImpl = () => ({ rows: ROWS, freeform: [] });
    return render(
        /*
            `TenantProvider` is REQUIRED as of #3115, and that is a real change
            rather than test scaffolding. The workspace mounts `OverlayBridge`,
            whose `useTenantSWR` resolves the tenant API URL through
            `useTenantContext` EAGERLY — before the null key is consulted — so
            the component throws without a provider even with run mode off.

            Satisfied in the app: `ProcessesClient` renders under
            `src/app/t/[tenantSlug]/layout.tsx`, which mounts this. The
            workspace previously needed no context at all, taking `tenantSlug`
            as a prop and building its own URLs, which is why 12 tests in this
            file went red the moment the bridge landed.
        */
        <TenantProvider value={TENANT_CTX}>
            <TldrawProcessWorkspace
                tenantSlug="acme"
                processes={PROCESSES}
                activeId={activeId}
                onActiveIdChange={() => {}}
                onProcessesChange={() => {}}
            />
        </TenantProvider>,
    );
}

/* ── the tests ──────────────────────────────────────────────────── */

describe('the history sidebar is mounted', () => {
    it('when a map is active, carrying the live version', () => {
        mount();
        expect(screen.getByTestId('history-stub')).toBeTruthy();
        // From `onStateChange`, not from the summary list — the server's
        // version is what a restore has to be relative to.
        expect(sidebarCurrentVersion).toBe(7);
    });

    it('and NOT when no map is open — teeth for the above', () => {
        // Without this, a sidebar mounted unconditionally would satisfy the
        // assertion above while fetching snapshots for a null map id.
        mount(null);
        expect(screen.queryByTestId('history-stub')).toBeNull();
    });
});

describe('the diff opens against the live canvas', () => {
    it('is closed until asked for', () => {
        mount();
        expect(screen.queryByTestId('diff-stub')).toBeNull();
        expect(serializeCalls).toHaveLength(0);
    });

    it('opens on a diff request, with both versions', () => {
        mount();
        act(() => fireDiff!(3));
        expect(screen.getByTestId('diff-stub')).toBeTruthy();
        expect(overlayProps.at(-1)!.targetVersion).toBe(3);
        expect(overlayProps.at(-1)!.currentVersion).toBe(7);
    });

    it('normalises the live rows — absent fields become null, not undefined', () => {
        // `DiffNodeRow` requires `subtitle: string | null`. The fixture omits
        // it. A cast would have compiled and let `undefined` through; this is
        // what makes `toDiffSnapshot` a mapping instead.
        mount();
        act(() => fireDiff!(3));
        const snap = overlayProps.at(-1)!.snapshot as {
            nodes: Array<Record<string, unknown>>;
            edges: Array<Record<string, unknown>>;
        };
        expect(snap.nodes[0]).toHaveProperty('subtitle', null);
        expect(snap.nodes[0]).toHaveProperty('parentNodeKey', null);
        expect(snap.nodes[0]).toHaveProperty('dataJson', null);
        expect(snap.edges[0]).toHaveProperty('labelOverride', null);
        // And the real values survive the mapping.
        expect(snap.nodes[0]!.nodeKey).toBe('n1');
        expect(snap.edges[0]!.edgeKind).toBe('flow');
    });

    it('reads the canvas ONCE, not once per render', () => {
        // The stability property. The xyflow host recomputes in its render
        // body, so its baseline shifts under the reader while they look at it;
        // a diff whose baseline moves is not a diff.
        mount();
        act(() => fireDiff!(3));
        expect(serializeCalls).toHaveLength(1);

        const rendersBefore = overlayProps.length;
        // Force re-renders that are not a new diff request.
        act(() => fireRestored!());
        act(() => fireDiff!(4));
        // One more read for the SECOND request, and no more than that.
        expect(serializeCalls).toHaveLength(2);
        expect(overlayProps.length).toBeGreaterThan(rendersBefore);
    });
});

describe('a serializer throw does not take the canvas down', () => {
    it('toasts and leaves the overlay closed', () => {
        // `serializeEditorCanvas` throws `EdgeEndpointError`; `editor-canvas.ts`
        // argues the case is unreachable against a mounted editor. Unreachable
        // is not impossible, and the cost of being wrong in a render body is a
        // blank page rather than a message.
        mount();
        serializeImpl = () => {
            throw new Error('EdgeEndpointError: e1 refers to a missing endpoint');
        };

        expect(() => act(() => fireDiff!(3))).not.toThrow();
        expect(screen.queryByTestId('diff-stub')).toBeNull();
        expect(toastErrors).toHaveLength(1);
        // The canvas itself is still mounted — the failure was contained.
        expect(screen.getByTestId('map-stub')).toBeTruthy();
    });

    it('and a later successful request still opens — not latched shut', () => {
        // A guard that gave up permanently after one throw would pass the test
        // above and quietly remove the feature.
        mount();
        serializeImpl = () => {
            throw new Error('EdgeEndpointError');
        };
        act(() => fireDiff!(3));
        expect(screen.queryByTestId('diff-stub')).toBeNull();

        serializeImpl = () => ({ rows: ROWS, freeform: [] });
        act(() => fireDiff!(4));
        expect(screen.getByTestId('diff-stub')).toBeTruthy();
        expect(overlayProps.at(-1)!.targetVersion).toBe(4);
    });
});

describe('a restore remounts the map', () => {
    it('because the server now holds a different graph', () => {
        // The same move a 409 makes. Merging two divergent graphs is not
        // something either canvas can do, so the only correct next state is
        // whatever the server says.
        mount();
        const before = mapKeys.length;
        act(() => fireRestored!());
        expect(mapKeys.length).toBeGreaterThan(before);
    });

    it('and closes any open diff, whose baseline is now stale', () => {
        mount();
        act(() => fireDiff!(3));
        expect(screen.getByTestId('diff-stub')).toBeTruthy();
        act(() => fireRestored!());
        expect(screen.queryByTestId('diff-stub')).toBeNull();
    });
});

describe('the inert size control is not offered on this host', () => {
    it('tells the inspector this renderer does not honour size', () => {
        // The capability itself is asserted in `process-inspector.test.tsx`.
        // THIS asserts the wiring, which is the half that can silently regress:
        // the prop defaults to true, so forgetting to pass it here brings the
        // control back with nothing behind it and no test complaining.
        mount();
        expect(inspectorProps.at(-1)?.rendererHonoursSize).toBe(false);
    });

    it('explicitly false, not merely absent', () => {
        // `undefined` would read as "host did not say" and fall back to TRUE.
        mount();
        expect(inspectorProps.at(-1)?.rendererHonoursSize).not.toBeUndefined();
    });
});

/**
 * VR-6 — the workspace gates the overlay poll on Run Mode (#3115).
 *
 * The provider's own behaviour given `enabled` is covered in
 * `canvas-execution-overlay-provider`. What only this file can show is that the
 * WORKSPACE supplies the flag correctly — and the off direction is the one that
 * matters in production, where every map is a DOCUMENT map and an ungated mount
 * would put a 3s poll on all of them.
 */
describe('the live-execution poll is gated on Run Mode', () => {
    const overlayCalls = () =>
        swrCalls.filter(
            (c) => c.key === null || c.key === CACHE_KEYS.automation.executions.live(),
        );

    beforeEach(() => {
        swrCalls.length = 0;
    });

    it('is OFF by default — a null key, so nothing is fetched at all', () => {
        mount();
        const calls = overlayCalls();
        // Non-empty first: an empty selection passes every `every()` below.
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => c.key === null)).toBe(true);
        // A null key AND a zero interval — either alone still schedules work.
        expect(calls.every((c) => (c.opts as { refreshInterval: number }).refreshInterval === 0)).toBe(
            true,
        );
    });

    it('and turns ON when Run Mode does, at the live key and a 3s cadence', () => {
        mount();
        act(() => {
            screen.getByTestId('run-mode-on').click();
        });
        const live = swrCalls.filter(
            (c) => c.key === CACHE_KEYS.automation.executions.live(),
        );
        expect(live.length).toBeGreaterThan(0);
        expect((live.at(-1)!.opts as { refreshInterval: number }).refreshInterval).toBe(3000);
    });

    it('the stub really did flip the flag, not just fire a handler', () => {
        // Positive control for the test above: if `setRunMode` were inert, the
        // key assertion would fail for a reason that looks like a product bug.
        mount();
        expect(screen.getByTestId('run-mode-on')).toHaveTextContent('off');
        act(() => {
            screen.getByTestId('run-mode-on').click();
        });
        expect(screen.getByTestId('run-mode-on')).toHaveTextContent('on');
    });
});
