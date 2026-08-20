import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useResizeObserver } from "./use-resize-observer";

/**
 * Sub-threshold progress deltas are dropped without a state update.
 *
 * The value drives an opacity of `1 - p²`, so a 1/1000 step is two
 * orders of magnitude below anything a person can see — but it is
 * large enough to swallow the sub-pixel churn a momentum scroll or a
 * trackpad rubber-band produces, which would otherwise re-render the
 * consumer (and the fade overlay it paints) for no visible change.
 *
 * The 0 and 1 boundaries are exempt (see {@link useScrollProgress}) so
 * the fade always lands fully-on / fully-off at the ends of travel.
 */
const PROGRESS_EPSILON = 0.001;

/**
 * Compute a `[0..1]` progress value for how far through a scrollable
 * element the user has scrolled. Returns both the current progress
 * and the `updateScrollProgress` callback the consumer wires to the
 * container's `onScroll` handler.
 *
 * ## Why manual onScroll wiring (not an auto-listener)
 *
 * The hook deliberately does NOT register its own scroll listener.
 * The consumer owns the event binding — usually by spreading the
 * callback as `onScroll={updateScrollProgress}` directly on the
 * scrollable element. This keeps the listener local to the exact
 * node being scrolled (avoiding document-level bubbling), lets
 * callers coalesce with other scroll handlers, and stays in sync
 * with the ref's mount/unmount naturally.
 *
 * The hook DOES auto-recompute on resize via the internal
 * {@link useResizeObserver}, because layout changes move the
 * end-of-scroll target without firing a scroll event.
 *
 * ## Frame batching (why `updateScrollProgress` is not synchronous)
 *
 * A scroll gesture dispatches many `scroll` events per frame. Each
 * call reads `scrollTop` / `scrollHeight` / `clientHeight` — layout
 * properties — and the consumers of this hook write the result
 * straight back out as an inline `style.opacity`. Measuring
 * synchronously per event therefore interleaves read → write → read
 * → write within one frame (layout thrash), and commits a React
 * render per event on top.
 *
 * So `updateScrollProgress` only SCHEDULES the measurement:
 *
 *   - at most one `requestAnimationFrame` is in flight at a time, so
 *     an event storm within a frame collapses to a single measure and
 *     at most one render;
 *   - the measurement runs in the frame, after layout has settled,
 *     so the read is never forced;
 *   - an unchanged (or sub-{@link PROGRESS_EPSILON}) result commits
 *     nothing at all.
 *
 * The consequence for callers is that `scrollProgress` reflects a
 * call on the NEXT frame, not the same tick. Tests must flush a
 * frame between acting and asserting. Environments without
 * `requestAnimationFrame` (SSR, bare Node) fall back to measuring
 * inline so the hook never silently stops updating.
 *
 * ## Edge cases
 *
 *   - Empty container (scrollSize === clientSize): progress is `1`
 *     (nothing to scroll → treat as "fully seen") so opacity / fade
 *     overlays behave sensibly.
 *   - Unmounted ref: updater is a no-op.
 *   - SSR: initial state is `1`; the ResizeObserver's own guard
 *     short-circuits until hydration.
 *   - Unmount: a queued frame is cancelled, so the hook
 *     never sets state on a torn-down component.
 *
 * ## Usage
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   const { scrollProgress, updateScrollProgress } = useScrollProgress(ref);
 *   return (
 *     <>
 *       <div ref={ref} onScroll={updateScrollProgress}>...</div>
 *       <Fade opacity={1 - scrollProgress} />
 *     </>
 *   );
 */
export function useScrollProgress(
    ref: RefObject<HTMLElement | null>,
    { direction = "vertical" }: { direction?: "vertical" | "horizontal" } = {},
) {
    const [scrollProgress, setScrollProgress] = useState(1);

    // Mirror of the last COMMITTED value. Read inside the frame
    // callback so the comparison doesn't need `scrollProgress` in the
    // callback's dependency list — that would hand every consumer a
    // fresh `updateScrollProgress` identity on each scroll-driven
    // render, which is exactly the churn this hook is avoiding.
    const committedRef = useRef(1);
    const frameRef = useRef<number | null>(null);

    const measureScrollProgress = useCallback(() => {
        frameRef.current = null;
        const node = ref.current;
        if (!node) return;
        const scroll =
            direction === "vertical" ? node.scrollTop : node.scrollLeft;
        const scrollSize =
            direction === "vertical" ? node.scrollHeight : node.scrollWidth;
        const clientSize =
            direction === "vertical" ? node.clientHeight : node.clientWidth;

        const next =
            scrollSize === clientSize
                ? 1
                : Math.min(Math.max(scroll / (scrollSize - clientSize), 0), 1);

        if (next === committedRef.current) return;
        // The ends of travel always commit, however small the step —
        // otherwise the fade can settle at a residual 0.001 opacity
        // instead of disappearing at the bottom of the container.
        const atBoundary = next === 0 || next === 1;
        if (
            !atBoundary &&
            Math.abs(next - committedRef.current) < PROGRESS_EPSILON
        ) {
            return;
        }

        committedRef.current = next;
        setScrollProgress(next);
        // `ref` identity is stable by React contract, so omitting it
        // from deps matches the ref-stability guarantee.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [direction]);

    const updateScrollProgress = useCallback(() => {
        if (typeof requestAnimationFrame === "undefined") {
            measureScrollProgress();
            return;
        }
        // Already queued for this frame — the pending callback reads
        // the freshest layout anyway, so a second frame would measure
        // the same numbers twice.
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(measureScrollProgress);
    }, [measureScrollProgress]);

    // Cancel any in-flight frame on unmount so the callback can't fire
    // against a torn-down component.
    useEffect(
        () => () => {
            if (
                frameRef.current !== null &&
                typeof cancelAnimationFrame !== "undefined"
            ) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }
        },
        [],
    );

    // Recompute on resize: layout changes can move the scroll end-point
    // without dispatching a scroll event.
    const resizeObserverEntry = useResizeObserver(ref);
    useEffect(() => {
        updateScrollProgress();
    }, [resizeObserverEntry, updateScrollProgress]);

    return { scrollProgress, updateScrollProgress };
}
