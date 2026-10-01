"use client";

import { useEffect, useRef } from "react";
import { useInViewport } from "@/components/ui/hooks";

export interface InfiniteScrollSentinelProps {
    /**
     * Fired once each time the sentinel scrolls into view (with the
     * pre-load `rootMargin` applied). The consumer wires this to its
     * windowing hook's `loadMore`. The PARENT decides whether more
     * data exists: render the sentinel only while `hasMore` is true
     * (pass `onReachEnd={hasMore ? loadMore : undefined}` so the
     * sentinel unmounts — and the observer disconnects — at the end
     * of the data).
     */
    onReachEnd: () => void;
    /**
     * IntersectionObserver `rootMargin`. Defaults to growing the
     * viewport 320px past the bottom so the next batch loads just
     * before the user reaches the end — the scroll never visibly
     * stalls. One windowed batch (≈50 rows) overflows the viewport,
     * so the sentinel drops well below the fold after each load and
     * re-arms on the next scroll; there is no tight load loop.
     */
    rootMargin?: string;
    testId?: string;
}

/**
 * A zero-height marker that auto-loads the next windowed batch when it
 * scrolls into view — the load-on-scroll engine behind the entity list
 * tables. It lives INSIDE the `<DataTable>` scroll wrapper (rendered by
 * the `<Table>` primitive when `onReachEnd` is passed), so it is
 * correctly clipped by the `fillBody` inner scroll region: observed
 * against the viewport, an `overflow-y-auto` ancestor clips the
 * sentinel, so it only intersects when the user scrolls to the bottom
 * of the table body — and equally works on mobile's document scroll
 * where there is no inner clamp.
 *
 * Replaces the manual `<TableLoadMoreFooter>` "Load more" button.
 */
export function InfiniteScrollSentinel({
    onReachEnd,
    rootMargin = "0px 0px 320px 0px",
    testId,
}: InfiniteScrollSentinelProps) {
    const sentinelRef = useRef<HTMLDivElement>(null);
    const visible = useInViewport(sentinelRef, { rootMargin });

    // Keep the latest callback without re-arming the effect on every
    // render — the effect should fire on the visibility EDGE only.
    const onReachEndRef = useRef(onReachEnd);
    onReachEndRef.current = onReachEnd;

    useEffect(() => {
        if (visible) onReachEndRef.current();
    }, [visible]);

    return (
        <div
            ref={sentinelRef}
            aria-hidden="true"
            data-testid={testId}
            className="h-px w-full shrink-0"
        />
    );
}
