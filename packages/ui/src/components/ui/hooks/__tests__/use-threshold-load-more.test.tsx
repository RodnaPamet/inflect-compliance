/**
 * PR-1 — useThresholdLoadMore unit tests.
 *
 * Behaviour locked:
 *   • Below threshold: every row visible from the first render;
 *     `hasMore` is false; `loadMore` is a no-op.
 *   • Above threshold: only the first `threshold` rows visible;
 *     `hasMore` is true.
 *   • `loadMore()` adds `increment` more rows; repeated calls keep
 *     adding until totalCount is reached.
 *   • When the input narrows below the current window, the window
 *     stays — every remaining row stays visible (no surprise
 *     collapse).
 *   • When the input grows past the current window, the window
 *     stays at the user's loaded size (no surprise re-collapse).
 *   • `reset()` collapses back to the initial threshold.
 */
import { act, renderHook } from '@testing-library/react';
import { useThresholdLoadMore } from '../use-threshold-load-more';

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('useThresholdLoadMore', () => {
    it('below threshold: every row visible, hasMore false', () => {
        const { result } = renderHook(() =>
            useThresholdLoadMore(range(30), { threshold: 50 }),
        );
        expect(result.current.visibleRows.length).toBe(30);
        expect(result.current.totalCount).toBe(30);
        expect(result.current.hasMore).toBe(false);
    });

    it('above threshold: shows the first slice; hasMore true', () => {
        const { result } = renderHook(() =>
            useThresholdLoadMore(range(120), { threshold: 50 }),
        );
        expect(result.current.visibleRows.length).toBe(50);
        expect(result.current.totalCount).toBe(120);
        expect(result.current.hasMore).toBe(true);
        expect(result.current.visibleRows[0]).toBe(1);
        expect(result.current.visibleRows[49]).toBe(50);
    });

    it('loadMore reveals the next increment-sized batch', () => {
        const { result } = renderHook(() =>
            useThresholdLoadMore(range(200), { threshold: 50 }),
        );
        act(() => result.current.loadMore());
        // Default increment = threshold; window grows to 100.
        expect(result.current.visibleRows.length).toBe(100);
        expect(result.current.hasMore).toBe(true);
        act(() => result.current.loadMore());
        expect(result.current.visibleRows.length).toBe(150);
        act(() => result.current.loadMore());
        // Capped at totalCount.
        expect(result.current.visibleRows.length).toBe(200);
        expect(result.current.hasMore).toBe(false);
    });

    it('honours a custom increment distinct from threshold', () => {
        const { result } = renderHook(() =>
            useThresholdLoadMore(range(60), { threshold: 20, increment: 10 }),
        );
        expect(result.current.visibleRows.length).toBe(20);
        act(() => result.current.loadMore());
        expect(result.current.visibleRows.length).toBe(30);
        act(() => result.current.loadMore());
        expect(result.current.visibleRows.length).toBe(40);
    });

    it('loadMore is a no-op when nothing more to reveal', () => {
        const { result } = renderHook(() =>
            useThresholdLoadMore(range(10), { threshold: 50 }),
        );
        // visible = 10, window = 50, total = 10. loadMore should
        // not change anything (and not error).
        act(() => result.current.loadMore());
        expect(result.current.visibleRows.length).toBe(10);
        expect(result.current.hasMore).toBe(false);
    });

    it('a narrowed input keeps every remaining row visible', () => {
        const { result, rerender } = renderHook(
            ({ rows }) => useThresholdLoadMore(rows, { threshold: 50 }),
            { initialProps: { rows: range(120) } },
        );
        // Pre-narrow: showing 50 of 120.
        expect(result.current.visibleRows.length).toBe(50);
        // User filters down to 30 rows — they should ALL be visible.
        rerender({ rows: range(30) });
        expect(result.current.visibleRows.length).toBe(30);
        expect(result.current.hasMore).toBe(false);
    });

    it('relaxing the filter back keeps the loaded window', () => {
        const { result, rerender } = renderHook(
            ({ rows }) => useThresholdLoadMore(rows, { threshold: 50 }),
            { initialProps: { rows: range(120) } },
        );
        // User clicked Load more once → window grew to 100.
        act(() => result.current.loadMore());
        expect(result.current.visibleRows.length).toBe(100);
        // Narrow down to 80.
        rerender({ rows: range(80) });
        expect(result.current.visibleRows.length).toBe(80);
        // Widen back to 200 — window stays at the 100 the user
        // had loaded; user can Load more again.
        rerender({ rows: range(200) });
        expect(result.current.visibleRows.length).toBe(100);
        expect(result.current.hasMore).toBe(true);
    });

    it('reset collapses back to the initial threshold', () => {
        const { result } = renderHook(() =>
            useThresholdLoadMore(range(200), { threshold: 50 }),
        );
        act(() => result.current.loadMore());
        act(() => result.current.loadMore());
        expect(result.current.visibleRows.length).toBe(150);
        act(() => result.current.reset());
        expect(result.current.visibleRows.length).toBe(50);
        expect(result.current.hasMore).toBe(true);
    });
});
