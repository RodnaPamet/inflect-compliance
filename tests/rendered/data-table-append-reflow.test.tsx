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
 *   3. a burst of appends inside one frame collapses to ONE measurement;
 *   4. an append does not tear down and rebuild the ResizeObserver.
 *
 * ## Why the frame queue is driven by hand
 *
 * jsdom's own `requestAnimationFrame` fires on a wall-clock timer, so
 * "several appends within one frame" would be a race against ~16ms of real
 * time on a loaded CI box. Worse, batching hides the bug: three
 * `rerender` calls inside ONE `act()` collapse into a single React commit,
 * so the unfixed code measures once too and the assertion passes against
 * it. Each append therefore gets its own `act()` (its own commit, which is
 * what a real load-more does), and the frames are a hand-driven queue so
 * the collapse is asserted rather than timed.
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

// ── hand-driven frame queue ────────────────────────────────────────────

/** Callbacks queued for the next frame but not yet run. */
let pendingFrames: FrameRequestCallback[] = [];
let nextFrameHandle = 1;

const ORIGINAL_RAF = globalThis.requestAnimationFrame;
const ORIGINAL_CAF = globalThis.cancelAnimationFrame;

const frameHandles = new Map<number, FrameRequestCallback>();

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
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const handle = nextFrameHandle++;
        frameHandles.set(handle, cb);
        pendingFrames.push(cb);
        return handle;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) => {
        const cb = frameHandles.get(handle);
        if (!cb) return;
        frameHandles.delete(handle);
        pendingFrames = pendingFrames.filter((queued) => queued !== cb);
    }) as typeof globalThis.cancelAnimationFrame;
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
    globalThis.requestAnimationFrame = ORIGINAL_RAF;
    globalThis.cancelAnimationFrame = ORIGINAL_CAF;
});

beforeEach(() => {
    rowHeightReads = 0;
    observerDisconnects = 0;
    observerConstructions = 0;
    pendingFrames = [];
    frameHandles.clear();
});

/** Run everything queued for the next frame, inside an act scope. */
const flushFrame = () => {
    const queued = pendingFrames;
    pendingFrames = [];
    frameHandles.clear();
    act(() => {
        queued.forEach((cb) => cb(performance.now()));
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

    it('appending a batch commits with ZERO forced layout reads', () => {
        const { rerender } = renderTable(12);
        flushFrame();
        rowHeightReads = 0;

        // The load-on-scroll append: `useThresholdLoadMore` widens the
        // window, the row slice grows, the row count changes. This is
        // the commit that used to re-measure before paint while the
        // user's finger was still on the trackpad.
        act(() => rerenderTable(rerender, 24));

        expect(rowHeightReads).toBe(0);
    });

    it('re-measures once on the frame after an append — deferred, not dropped', () => {
        const { rerender } = renderTable(12);
        flushFrame();
        rowHeightReads = 0;

        act(() => rerenderTable(rerender, 24));
        // The ordering is the whole assertion: reading zero at commit
        // and one after the frame is only possible if the measurement
        // moved off the commit. Asserting the post-frame count alone
        // passes against the synchronous version, which also lands on
        // exactly one read — just in the wrong place.
        expect(rowHeightReads).toBe(0);
        flushFrame();
        expect(rowHeightReads).toBe(1);
    });

    it('collapses several appends within one frame into a single measurement', () => {
        const { rerender } = renderTable(12);
        flushFrame();
        rowHeightReads = 0;

        // Three SEPARATE commits, the way three load-more batches
        // arrive — not three renders inside one act(), which React
        // would batch into a single commit and measure once even
        // without the fix.
        act(() => rerenderTable(rerender, 24));
        act(() => rerenderTable(rerender, 36));
        act(() => rerenderTable(rerender, 48));

        expect(rowHeightReads).toBe(0);

        // ONE read after the frame is the collapse: three uncollapsed
        // frames would each run the measurement and land on three.
        // (Counting the queue directly would be sharper but is not
        // ours to count — other libraries in the tree share the frame
        // loop, so the queue is not a private channel.)
        flushFrame();
        expect(rowHeightReads).toBe(1);
    });

    it('does not tear down and rebuild the ResizeObserver on every append', () => {
        const { rerender } = renderTable(12);
        flushFrame();
        const constructionsAfterMount = observerConstructions;
        observerDisconnects = 0;

        act(() => rerenderTable(rerender, 24));
        flushFrame();
        act(() => rerenderTable(rerender, 36));
        flushFrame();

        // The observed targets (the card, the first row) are the same
        // elements they were before the append — re-registering them is
        // pure churn on the compositor.
        expect(observerDisconnects).toBe(0);
        expect(observerConstructions).toBe(constructionsAfterMount);
    });
});
