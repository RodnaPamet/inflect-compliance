'use client';

/**
 * The dropped-navigation predicate (#3099), and its guard for a `<Link>`.
 *
 * Dependency-free on purpose: `src/lib/hooks` is shared UI, and the sidebar's
 * `<NavItem>` uses the guard below. The evidence for the predicate and the
 * delay is written in `@/lib/nav/use-guarded-push`, the row-click guard that
 * came first and re-exports these.
 */
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';

/** See "THE DELAY" above — derived from three captures, not picked. */
export const DROPPED_PUSH_GRACE_MS = 1000;

/**
 * The pathname an href will land on, with query and hash removed.
 *
 * `new URL` rather than a regex: it resolves a relative href against the
 * current document the way the router does, and it cannot be defeated by a
 * `#`-in-query or a protocol-relative href the way a hand-rolled split can.
 * Falls back to the raw href if there is no base to resolve against (server
 * render), which only ever makes the predicate below answer "different", i.e.
 * arm a watch that then declines to fire.
 */
export function pathnameOf(href: string): string {
    try {
        return new URL(href, window.location.href).pathname;
    } catch {
        return href;
    }
}

export interface DroppedPushCheck {
    /** `location.pathname` sampled at click time. */
    startPath: string;
    /** `location.pathname` sampled when the grace window expired. */
    currentPath: string;
    /** Where the click asked to go. */
    targetPath: string;
}

/**
 * Exported so the discriminating cases can be driven directly as well as
 * through the hook. Both are tested: a predicate nobody calls through the real
 * wiring is a collector with an untested seam.
 */
export function shouldRetryDroppedPush({
    startPath,
    currentPath,
    targetPath,
}: DroppedPushCheck): boolean {
    return currentPath === startPath && targetPath !== startPath;
}

/**
 * The same watch for a `<Link>` click — the sidebar's (#3099, again).
 *
 * The sidebar is where the hydration window is busiest: its own viewport
 * prefetch is what puts the ~60 requests in flight. A CI trace of
 * `agent-ask-surface.spec.ts` showed the dropped shape exactly: a click on a
 * sidebar row about 100 ms after `domcontentloaded`, the destination's RSC and
 * page chunk both loaded within ~200 ms, and the URL still on the old page 30 s
 * later. A person sees the click do nothing.
 *
 * `<Link>` issues the push itself, so this hook pushes nothing. It returns an
 * `onClick` to put on the link: on a click `<Link>` will turn into a client
 * navigation (primary button, no modifier key, not prevented), it arms the same
 * predicate after the same grace window, and if the click was dropped it clicks
 * the link once more, which `<Link>` navigates; a second click commits
 * normally. The retry's own click arms nothing, so it is never retried.
 *
 * Re-clicking rather than calling the router keeps it off `useRouter`: the row
 * renders in hosts and tests that mount no app router. `onRetry` is the host's
 * slot for counting a retry; a shared primitive cannot import the product's
 * telemetry itself.
 */
export function useDroppedLinkClickGuard(
    href: string | undefined,
    onRetry?: (sample: { route: string; elapsedMs: number }) => void,
): (e: ReactMouseEvent<HTMLElement>) => void {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryingRef = useRef(false);
    // The latest `onRetry` without re-arming the click handler for each one.
    const onRetryRef = useRef(onRetry);
    useEffect(() => {
        onRetryRef.current = onRetry;
    }, [onRetry]);

    useEffect(
        () => () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
    );

    return useCallback(
        (e: ReactMouseEvent<HTMLElement>) => {
            if (href === undefined || typeof window === 'undefined') return;
            // The retry's own click: `<Link>` navigates, and nothing is armed.
            if (retryingRef.current) {
                retryingRef.current = false;
                return;
            }
            // Only the click `<Link>` turns into a client navigation. A
            // modified or non-primary click opens a tab, and a prevented one
            // navigates nowhere.
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                return;
            }

            const link = e.currentTarget;
            const startPath = window.location.pathname;
            const targetPath = pathnameOf(href);
            if (targetPath === startPath) return;
            const startedAt = Date.now();

            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                if (
                    !link.isConnected ||
                    !shouldRetryDroppedPush({
                        startPath,
                        currentPath: window.location.pathname,
                        targetPath,
                    })
                ) {
                    return;
                }
                onRetryRef.current?.({ route: startPath, elapsedMs: Date.now() - startedAt });
                retryingRef.current = true;
                link.click();
            }, DROPPED_PUSH_GRACE_MS);
        },
        [href],
    );
}
