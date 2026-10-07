import { RefObject, useEffect, useState } from "react";

/**
 * Subscribe to `IntersectionObserver` events for a single ref'd element.
 *
 * Returns the latest `IntersectionObserverEntry` (or `undefined` until
 * the first observer callback fires). Handles:
 *
 *   - SSR / pre-hydration: effect body short-circuits when `window`
 *     or `IntersectionObserver` are unavailable.
 *   - Cleanup: observer is disconnected on unmount, ref change, or
 *     when `freezeOnceVisible` latches on the first intersection.
 *   - Ref re-targeting: if the consumer reassigns the ref between
 *     renders, the effect re-runs (dependency is `elementRef.current`
 *     indirectly via the render cycle).
 *
 * `freezeOnceVisible` is the common lazy-load pattern — once the
 * element has been on-screen, stop observing and keep the last
 * positive entry, so the consumer keeps rendering the "visible"
 * state without further observer churn.
 */
interface Args extends IntersectionObserverInit {
    freezeOnceVisible?: boolean;
}

export function useIntersectionObserver(
    elementRef: RefObject<Element | null>,
    {
        threshold = 0,
        root = null,
        rootMargin = "0%",
        freezeOnceVisible = false,
    }: Args = {},
): IntersectionObserverEntry | undefined {
    const [entry, setEntry] = useState<IntersectionObserverEntry>();

    const frozen = entry?.isIntersecting && freezeOnceVisible;

    useEffect(() => {
        // SSR / pre-hydration guard. `IntersectionObserver` is a
        // browser-only global; hook bodies only run in client
        // components, but the typeof check also protects jsdom
        // environments that omit the constructor.
        if (typeof window === "undefined" || !window.IntersectionObserver) return;
        if (frozen) return;

        const node = elementRef?.current;
        if (!node) return;

        const observer = new IntersectionObserver(
            ([latest]) => setEntry(latest),
            { threshold, root, rootMargin },
        );
        observer.observe(node);

        return () => observer.disconnect();
        // `threshold` can be an array; React's shallow compare would treat
        // a new literal as a new identity every render. Callers passing an
        // array should memoise it — the alternative (stable stringify) made
        // array churn silently cheaper at the cost of masking real changes.

    }, [elementRef, threshold, root, rootMargin, frozen]);

    return entry;
}
