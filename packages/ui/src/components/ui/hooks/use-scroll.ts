import { RefObject, useEffect, useState } from "react";

/**
 * Reactively track whether a scroll container is scrolled past a
 * threshold. Returns a boolean — `true` once `scrollTop > threshold`,
 * `false` below it. Flips back as the user scrolls up past the line.
 *
 * Common use case: sticky-header shadow / sticky-nav styling change
 * after scrolling N pixels.
 *
 *   const scrolled = useScroll(40);
 *   return <header className={scrolled ? 'shadow-md' : ''}>...</header>;
 *
 * Cleanup: the listener is detached on unmount or container change.
 * SSR-safe: the effect short-circuits when `window` is unavailable.
 *
 * Performance: passive scroll listener. `setScrolled` with the same
 * value is a React no-op, so a fast scroll doesn't re-render on every
 * event — only at the threshold crossings.
 */
export function useScroll(
    threshold: number,
    { container }: { container?: RefObject<HTMLElement | null> } = {},
) {
    const [scrolled, setScrolled] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return;

        const element = container?.current ?? window;
        const read = () => {
            const top = container?.current
                ? container.current.scrollTop
                : window.scrollY;
            setScrolled(top > threshold);
        };

        element.addEventListener("scroll", read, { passive: true });
        // Read once on mount / threshold change so consumers aren't stuck
        // at the default `false` until the first scroll event.
        read();

        return () => element.removeEventListener("scroll", read);
    }, [threshold, container]);

    return scrolled;
}
