/** @jest-environment jsdom */

/**
 * `<DataTable>` whole-row clip — appending rows must not force a
 * synchronous layout pass in the frame the user is still scrolling.
 *
 * ## The regression class
 *
 * The clip that keeps the card height a whole multiple of the row height
 * measures three layout properties back to back — the first row's
 * `offsetHeight`, the allocation ancestor's `clientHeight`, and the
 * tbody's `scrollHeight` — and then may `setState`. That measurement used
 * to live in a `useLayoutEffect` keyed on the ROW COUNT, which means it
 * ran synchronously after commit and before paint every time load-on-
 * scroll appended a batch. Appending is something that happens *during* a
 * scroll gesture, so the browser was forced to re-layout mid-gesture and
 * the scroll stalled.
 *
 * ## Why this counts LAYOUT READS and not renders
 *
 * A render-count assertion passes against the broken code. React batches
 * the state updates inside a single commit scope, so the unbatched and
 * the deferred version produce the same number of renders. What actually
 * changes is *when the element is measured*: reads are the thing that
 * forces layout, so reads are the thing to count. `firstRow.offsetHeight`
 * is read exactly once per measurement pass and nowhere else in the
 * table, which makes a counting getter on table rows an exact
 * measurement counter.
 *
 * The contract asserted here:
 *
 *   1. the FIRST measurement stays synchronous (no clipped-then-corrected
 *      flash on first paint — that is why it was a layout effect);
 *   2. an append commits with ZERO measurements, and measures once the
 *      frame afterwards;
 *   3. an append does not tear down and rebuild the ResizeObserver.
 */

import { act, render } from '@testing-library/react';
import * as React from 'react';

import { DataTable, createColumns } from '@/components/ui/table';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/things',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

interface Row {
    id: string;
    name: string;
}

const allRows: Row[] = Array.from({ length: 60 }, (_, i) => ({
    id: `r${i}`,
    name: `Row ${i}`,
}));

const columns = createColumns<Row>([{ accessorKey: 'name', header: 'Name' }]);

// ── layout-read instrumentation ────────────────────────────────────────

/** Measurement passes observed since the last reset. */
let rowHeightReads = 0;

const ORIGINAL_OFFSET_HEIGHT = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
);

/** Total `disconnect()` calls across every ResizeObserver in the tree. */
let observerDisconnects = 0;
/** Total ResizeObserver constructions. */
let observerConstructions = 0;

const ORIGINAL_RESIZE_OBSERVER = (
    globalThis as { ResizeObserver?: typeof ResizeObserver }
).ResizeObserver;

class CountingResizeObserver {
    constructor(_cb: ResizeObserverCallback) {
        observerConstructions += 1;
    }
    observe() {}
    unobserve() {}
    disconnect() {
        observerDisconnects += 1;
    }
}

beforeAll(() => {
    // A row's offsetHeight is read once per clip measurement and by
    // nothing else in the table, so the getter is an exact counter. A
    // non-zero value keeps the measurement on its full three-read path
    // instead of bailing at the `rowH <= 0` "not laid out yet" guard.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
            if (this.tagName === 'TR') {
                rowHeightReads += 1;
                return 40;
            }
            return 0;
        },
    });
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        CountingResizeObserver;
});

afterAll(() => {
    if (ORIGINAL_OFFSET_HEIGHT) {
        Object.defineProperty(
            HTMLElement.prototype,
            'offsetHeight',
            ORIGINAL_OFFSET_HEIGHT,
        );
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        ORIGINAL_RESIZE_OBSERVER;
});

beforeEach(() => {
    rowHeightReads = 0;
    observerDisconnects = 0;
    observerConstructions = 0;
});

/** Resolve after one animation frame, inside an act scope. */
const flushFrame = async () => {
    await act(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );
    });
};

function renderTable(count: number) {
    return render(
        <DataTable
            fillBody
            data={allRows.slice(0, count)}
            columns={columns}
            getRowId={(r) => r.id}
        />,
    );
}

function rerenderTable(
    rerender: (ui: React.ReactElement) => void,
    count: number,
) {
    rerender(
        <DataTable
            fillBody
            data={allRows.slice(0, count)}
            columns={columns}
            getRowId={(r) => r.id}
        />,
    );
}

describe('DataTable whole-row clip — append does not stall the gesture', () => {
    it('measures synchronously on first paint (no clipped-then-corrected flash)', () => {
        renderTable(12);
        // No frame flushed: the very first measurement has to have
        // happened already, otherwise the card paints unclipped and
        // snaps a frame later.
        expect(rowHeightReads).toBeGreaterThanOrEqual(1);
    });

    it('appending a batch commits with ZERO forced layout reads', async () => {
        const { rerender } = renderTable(12);
        await flushFrame();
        rowHeightReads = 0;

        // The load-on-scroll append: `useThresholdLoadMore` widens the
        // window, the row slice grows, the row count changes. This is
        // the commit that used to re-measure before paint while the
        // user's finger was still on the trackpad.
        act(() => rerenderTable(rerender, 24));

        expect(rowHeightReads).toBe(0);
    });

    it('re-measures once on the frame after an append', async () => {
        const { rerender } = renderTable(12);
        await flushFrame();
        rowHeightReads = 0;

        act(() => rerenderTable(rerender, 24));
        await flushFrame();

        // Deferred, not dropped — exactly one measurement lands.
        expect(rowHeightReads).toBe(1);
    });

    it('collapses several appends within one frame into a single measurement', async () => {
        const { rerender } = renderTable(12);
        await flushFrame();
        rowHeightReads = 0;

        act(() => {
            rerenderTable(rerender, 24);
            rerenderTable(rerender, 36);
            rerenderTable(rerender, 48);
        });
        await flushFrame();

        expect(rowHeightReads).toBe(1);
    });

    it('does not tear down and rebuild the ResizeObserver on every append', async () => {
        const { rerender } = renderTable(12);
        await flushFrame();
        const constructionsAfterMount = observerConstructions;
        observerDisconnects = 0;

        act(() => rerenderTable(rerender, 24));
        await flushFrame();
        act(() => rerenderTable(rerender, 36));
        await flushFrame();

        // The observed targets (the card, the first row) are the same
        // elements they were before the append — re-registering them is
        // pure churn on the compositor.
        expect(observerDisconnects).toBe(0);
        expect(observerConstructions).toBe(constructionsAfterMount);
    });
});
