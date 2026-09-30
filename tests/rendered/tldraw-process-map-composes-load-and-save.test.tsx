/**
 * @jest-environment jsdom
 *
 * The tldraw map container: what it loads, and what token it saves with.
 *
 * ── Why both children are mocked ─────────────────────────────────────
 *
 * `TldrawProcessCanvas` and `useTldrawCanvasAutosave` each have their own
 * suites — the first needs the tldraw jsdom shims and costs ~36s to mount, the
 * second is covered against a real save path in
 * `tldraw-canvas-autosave.test.tsx`. Re-exercising them here would test them
 * twice and the container once, slowly.
 *
 * What is ONLY testable here is the container's own contribution: the GET →
 * `GraphRows` mapping, the states it refuses to render a canvas in, and the
 * concurrency token's lifetime across more than one save. Mocking the children
 * makes those assertions direct — the hook mock records the options it was
 * handed, which is exactly the wiring under test.
 */
import { act, render, screen, waitFor } from '@testing-library/react';

import { TldrawProcessMap } from '@/components/processes/TldrawProcessMap';
import type { SavedProcessMap } from '@/lib/processes/tldraw-save';

/** Every options object the container has handed the autosave hook. */
const autosaveCalls: Array<Record<string, unknown>> = [];

jest.mock('@/lib/processes/use-tldraw-canvas-autosave', () => ({
    useTldrawCanvasAutosave: (opts: Record<string, unknown>) => {
        autosaveCalls.push(opts);
        return {
            markDirty: jest.fn(),
            markClean: jest.fn(),
            status: 'idle',
            lastSavedAt: null,
        };
    },
}));

/** Records the rows the canvas was asked to render. */
const canvasRows: Array<unknown> = [];

jest.mock('@/components/processes/TldrawProcessCanvas', () => ({
    TldrawProcessCanvas: (props: { rows: unknown; readOnly?: boolean }) => {
        canvasRows.push(props.rows);
        return <div data-testid="canvas-stub" data-readonly={String(props.readOnly)} />;
    },
}));

jest.mock('@/components/ui/hooks', () => ({
    useToast: () => ({ error: jest.fn(), success: jest.fn(), info: jest.fn() }),
}));

const NODE = {
    nodeKey: 'n1',
    nodeType: 'processStep',
    label: 'Receive invoice',
    subtitle: null,
    posX: 10,
    posY: 20,
    parentNodeKey: null,
    dataJson: null,
};

/** An edge as the ROUTE returns it — no `controls`, no `dataJson`. */
const EDGE_FROM_ROUTE = {
    edgeKey: 'e1',
    sourceKey: 'n1',
    targetKey: 'n2',
    edgeKind: 'flow',
    labelOverride: null,
};

function payload(over: Record<string, unknown> = {}) {
    return { id: 'map-1', version: 3, nodes: [NODE], edges: [EDGE_FROM_ROUTE], ...over };
}

function okFetch(body: unknown) {
    return jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
    })) as unknown as typeof fetch;
}

/** The last options the container handed the autosave hook. */
const lastAutosave = () => autosaveCalls[autosaveCalls.length - 1]!;

beforeEach(() => {
    autosaveCalls.length = 0;
    canvasRows.length = 0;
});

describe('loading a map', () => {
    it('GETs the map and renders the canvas with its rows', async () => {
        const f = okFetch(payload());
        render(<TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={f} />);

        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());
        expect(f).toHaveBeenCalledWith('/api/t/acme/processes/map-1');
        expect(canvasRows[canvasRows.length - 1]).toMatchObject({
            nodes: [{ nodeKey: 'n1', posX: 10, posY: 20 }],
        });
    });

    it("fills in the edge fields the route OMITS, rather than passing undefined through", async () => {
        // The route returns no `controls` for an edge that has none and no
        // `dataJson` at all. The binding's declared props type both as
        // present, so an undefined would reach `props.controls` on a record
        // tldraw validates.
        render(
            <TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={okFetch(payload())} />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());

        const rows = canvasRows[canvasRows.length - 1] as {
            edges: Array<{ controls: unknown; dataJson: unknown }>;
        };
        expect(rows.edges[0]!.controls).toEqual([]);
        expect(rows.edges[0]!.dataJson).toBeNull();
    });

    it('passes a present controls array through UNCHANGED', async () => {
        // Teeth for the default above: a mapper that always wrote `[]` would
        // satisfy it while discarding every edge control on load.
        const controls = [
            { controlKey: 'c1', label: 'Approval', controlId: 'ctl_1', dataJson: null },
        ];
        render(
            <TldrawProcessMap
                tenantSlug="acme"
                mapId="map-1"
                fetchImpl={okFetch(payload({ edges: [{ ...EDGE_FROM_ROUTE, controls }] }))}
            />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());

        const rows = canvasRows[canvasRows.length - 1] as {
            edges: Array<{ controls: unknown[] }>;
        };
        expect(rows.edges[0]!.controls).toEqual(controls);
    });

    it('does NOT fetch when there is no map selected', async () => {
        const f = okFetch(payload());
        render(<TldrawProcessMap tenantSlug="acme" mapId={null} fetchImpl={f} />);
        expect(screen.getByTestId('tldraw-map-empty')).toBeInTheDocument();
        expect(f).not.toHaveBeenCalled();
    });
});

describe('a failed load must not look like an empty map', () => {
    it('renders the error and NO canvas', async () => {
        // THE assertion. Rendering an empty canvas after a failed load invites
        // the user to draw on it, and autosave would then write that over the
        // real map — a save that succeeds and destroys.
        const f = jest.fn(async () => ({
            ok: false,
            status: 500,
            json: async () => ({}),
        })) as unknown as typeof fetch;

        render(<TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={f} />);

        await waitFor(() => expect(screen.getByTestId('tldraw-map-error')).toBeInTheDocument());
        expect(screen.queryByTestId('canvas-stub')).not.toBeInTheDocument();
        expect(screen.getByTestId('tldraw-map-error').textContent).toContain('500');
    });

    it('and sends no version, so nothing can be written against a guess', async () => {
        const f = jest.fn(async () => {
            throw new Error('network down');
        }) as unknown as typeof fetch;
        render(<TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={f} />);
        await waitFor(() => expect(screen.getByTestId('tldraw-map-error')).toBeInTheDocument());
        expect(lastAutosave()).not.toHaveProperty('expectedVersion');
    });
});

describe('the concurrency token', () => {
    it('reaches the autosave hook from the LOAD', async () => {
        render(
            <TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={okFetch(payload())} />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());
        expect(lastAutosave()).toMatchObject({ expectedVersion: 3, mapId: 'map-1' });
    });

    it('is UPDATED from each save — not left at the loaded value', async () => {
        // The line this test exists for. Holding the loaded version would make
        // the first save succeed, the second send a stale token, and every
        // edit after that conflict against the user's own previous write.
        render(
            <TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={okFetch(payload())} />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());
        expect(lastAutosave()).toMatchObject({ expectedVersion: 3 });

        const saved: SavedProcessMap = {
            id: 'map-1',
            version: 4,
            updatedAt: '2026-09-30T00:00:00.000Z',
            nodes: [],
            edges: [],
        };
        await act(async () => {
            (lastAutosave().onSaved as (s: SavedProcessMap) => void)(saved);
        });

        expect(lastAutosave()).toMatchObject({ expectedVersion: 4 });
    });

    it('tells the parent about each save too', async () => {
        const onSaved = jest.fn();
        render(
            <TldrawProcessMap
                tenantSlug="acme"
                mapId="map-1"
                fetchImpl={okFetch(payload())}
                onSaved={onSaved}
            />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());

        const saved = { id: 'map-1', version: 9, updatedAt: 'x', nodes: [], edges: [] };
        await act(async () => {
            (lastAutosave().onSaved as (s: SavedProcessMap) => void)(saved as SavedProcessMap);
        });
        expect(onSaved).toHaveBeenCalledWith(saved);
    });

    it('is DROPPED on a conflict, so the next autosave cannot retry it', async () => {
        render(
            <TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={okFetch(payload())} />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());
        expect(lastAutosave()).toMatchObject({ expectedVersion: 3 });

        await act(async () => {
            (lastAutosave().onConflict as () => void)();
        });
        expect(lastAutosave()).not.toHaveProperty('expectedVersion');
    });
});

describe('read-only', () => {
    it('disables autosave — the network, not just the UI', async () => {
        render(
            <TldrawProcessMap
                tenantSlug="acme"
                mapId="map-1"
                readOnly
                fetchImpl={okFetch(payload())}
            />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());
        expect(lastAutosave()).toMatchObject({ enabled: false });
        expect(screen.getByTestId('canvas-stub').getAttribute('data-readonly')).toBe('true');
    });

    it('and autosave IS enabled by default — teeth for the above', async () => {
        render(
            <TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={okFetch(payload())} />,
        );
        await waitFor(() => expect(screen.getByTestId('canvas-stub')).toBeInTheDocument());
        expect(lastAutosave()).toMatchObject({ enabled: true });
    });
});
