import { RefObject, useEffect, useState } from "react";

/**
 * Subscribe to `ResizeObserver` events for a single ref'd element.
 *
 * Returns the latest `ResizeObserverEntry` (or `undefined` until the
 * first observation fires). Handles:
 *
 *   - SSR / pre-hydration: effect short-circuits when `ResizeObserver`
 *     is unavailable (also covers jsdom environments without a polyfill).
 *   - Cleanup: disconnects on unmount or ref change.
 *
 * MDN: https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver
 */
export function useResizeObserver(
    elementRef: RefObject<Element | null>,
): ResizeObserverEntry | undefined {
    const [entry, setEntry] = useState<ResizeObserverEntry>();

    useEffect(() => {
        if (typeof window === "undefined" || typeof ResizeObserver === "undefined") {
            return;
        }

        const node = elementRef?.current;
        if (!node) return;

        const observer = new ResizeObserver(([latest]) => setEntry(latest));
        observer.observe(node);

        return () => observer.disconnect();
    }, [elementRef]);

    return entry;
}
