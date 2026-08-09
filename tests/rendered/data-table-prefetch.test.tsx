/** @jest-environment jsdom */

/**
 * Behavioural ratchet — `<DataTable onRowPrefetch>` warms a row's detail route
 * when the pointer RESTS on it (instant-navigation work).
 *
 * Contract: the pointer must dwell on a row before `onRowPrefetch(row)` fires,
 * once, deduped per row. The callback lives in the CONSUMER (which holds the
 * router and does `router.prefetch`), so the table primitive has NO
 * `useRouter` dependency — a DataTable renders fine without an app-router
 * context. That last property is asserted explicitly: this file deliberately
 * does NOT mock `next/navigation`.
 *
 * WHY THE DWELL
 * -------------
 * This fired on bare `onMouseEnter` until 2026-08-09. Moving the pointer from
 * the filter bar to a row near the bottom of the list prefetched every row it
 * crossed on the way — fifty route prefetches to serve one intended click.
 * Production showed the bill in the console: ~1,400 "preloaded using link
 * preload but not used" warnings per page load, alongside the sidebar's
 * mount-time prefetch of all fourteen nav routes.
 *
 * The "crosses rows without prefetching them" case below is the regression
 * that matters — the old implementation passed every other test in this file.
 */

import { render, fireEvent, act } from '@testing-library/react';
import * as React from 'react';

import { DataTable, createColumns } from '@/components/ui/table';

/** Must stay ≥ the primitive's ROW_PREFETCH_DWELL_MS. */
const PAST_DWELL_MS = 200;

interface Row {
    id: string;
    name: string;
}

const rows: Row[] = [
    { id: 'r0', name: 'Alpha' },
    { id: 'r1', name: 'Beta' },
    { id: 'r2', name: 'Gamma' },
];

const columns = createColumns<Row>([{ accessorKey: 'name', header: 'Name' }]);

function renderTable(onRowPrefetch: (row: { original: Row }) => void) {
    return render(
        <DataTable<Row>
            data={rows}
            columns={columns}
            getRowId={(r) => r.id}
            onRowPrefetch={onRowPrefetch}
        />,
    );
}

function rowByText(container: HTMLElement, label: string): HTMLElement {
    const cell = Array.from(container.querySelectorAll('td')).find((td) =>
        td.textContent?.includes(label),
    );
    const tr = cell?.closest('tr');
    if (!tr) throw new Error(`row "${label}" not found`);
    return tr as HTMLElement;
}

/** Rest the pointer on a row long enough to signal intent. */
function dwellOn(row: HTMLElement) {
    fireEvent.mouseEnter(row);
    act(() => {
        jest.advanceTimersByTime(PAST_DWELL_MS);
    });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

describe('DataTable onRowPrefetch — a resting pointer warms the detail route', () => {
    it('fires onRowPrefetch once the pointer rests, with the hovered row', () => {
        const spy = jest.fn();
        const { container } = renderTable(spy);
        dwellOn(rowByText(container, 'Alpha'));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].original.id).toBe('r0');
    });

    it('does NOT fire while the pointer is merely passing over', () => {
        // The regression this file exists for. Entering and leaving inside the
        // dwell window is someone moving somewhere else, not someone reading
        // the row.
        const spy = jest.fn();
        const { container } = renderTable(spy);
        const alpha = rowByText(container, 'Alpha');
        fireEvent.mouseEnter(alpha);
        act(() => {
            jest.advanceTimersByTime(40);
        });
        fireEvent.mouseLeave(alpha);
        act(() => {
            jest.advanceTimersByTime(PAST_DWELL_MS);
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('sweeping the list prefetches only the row the pointer lands on', () => {
        // Dragging the pointer down the table used to prefetch every row it
        // crossed; now the crossed rows cost nothing and only the destination
        // is warmed.
        const spy = jest.fn();
        const { container } = renderTable(spy);
        for (const label of ['Alpha', 'Beta']) {
            const row = rowByText(container, label);
            fireEvent.mouseEnter(row);
            act(() => {
                jest.advanceTimersByTime(30);
            });
            fireEvent.mouseLeave(row);
        }
        dwellOn(rowByText(container, 'Gamma'));

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].original.id).toBe('r2');
    });

    it('fires at most once per row (deduped across repeated hovers)', () => {
        const spy = jest.fn();
        const { container } = renderTable(spy);
        const alpha = rowByText(container, 'Alpha');
        dwellOn(alpha);
        dwellOn(alpha);
        dwellOn(alpha);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not fire after unmount', () => {
        // A pending dwell must not call back into a table that is gone.
        const spy = jest.fn();
        const { container, unmount } = renderTable(spy);
        fireEvent.mouseEnter(rowByText(container, 'Alpha'));
        unmount();
        act(() => {
            jest.advanceTimersByTime(PAST_DWELL_MS);
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('renders without an app-router context — the primitive has no useRouter', () => {
        // No `jest.mock('next/navigation')` in this file: if DataTable called
        // useRouter, this render would throw "invariant expected app router to
        // be mounted". It must not.
        expect(() => renderTable(jest.fn())).not.toThrow();
    });
});
