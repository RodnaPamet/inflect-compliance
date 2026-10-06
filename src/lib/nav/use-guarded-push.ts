'use client';

/**
 * A row-click `router.push` that notices when the client router silently drops
 * it, and re-issues it once.
 *
 * ── THE DEFECT (#3099, upstream vercel/next.js#99651) ────────────────────
 *
 * A cold row click during the hydration window issues its navigation and then
 * nothing happens. Measured on three independent captures of the same failure
 * (CI run 36929866055, all three attempts, re-measured from the raw HAR):
 *
 *   · the detail RSC request returns 200 (12 / 43 / 36 ms);
 *   · the destination's page chunk loads 149 / 339 / 175 ms AFTER that response
 *     — React's Flight client only requests that chunk when it resolves a
 *     client reference, so the payload DECODED;
 *   · and then: zero requests started more than 1000 ms after the click, zero
 *     `console.error`, zero `pageerror`, no document navigation, no retry;
 *   · the URL never changes, which is mechanical proof the transition never
 *     committed: `app-router.js`'s `HistoryUpdater` effect is keyed on
 *     `[appRouterState]`, so the URL is written only AFTER a React commit;
 *   · the app stays interactive, and a second click navigates normally.
 *
 * The surviving hypothesis is a React transition lane scheduled and never
 * committed, under ~75–100 in-flight RSC requests from the sidebar's own
 * viewport prefetch. The two hypotheses #3099 opened with were refuted from
 * installed source (segment-cache eviction cannot run while prefetches are in
 * flight; prefetches never enter the action queue), and the upstream issue was
 * auto-closed for want of a minimal reproduction. So this is a deliberate
 * userland workaround over a mechanism this repo cannot fix, not a guess.
 *
 * It is also the only instrument we have for how often this hits real users —
 * see `NAV_PUSH_RETRY_METRIC`. The counter is half the point.
 *
 * ── THE PREDICATE, WHICH MATTERS MORE THAN THE RETRY ─────────────────────
 *
 * The naive check is "did we reach the target", and it is WRONG: it fires a
 * second navigation at a user who clicked a row, changed their mind, and went
 * somewhere else inside the grace window. That is a worse bug than the one
 * being fixed, because it is not load-dependent.
 *
 * So the question asked is "are we still exactly where the click started", with
 * `startPath` captured at click time:
 *
 *   retry  ⟺  location.pathname === startPath  ∧  targetPath !== startPath
 *
 * · push committed      → pathname is the target ≠ startPath → no retry.
 * · user went elsewhere → pathname is somewhere else        → no retry.
 * · push dropped        → pathname is still startPath       → retry, once.
 *
 * The second term covers the degenerate click: a push to the page you are
 * already on cannot be distinguished from a dropped one by a pathname test, so
 * no watch is armed at all for it. That also means a push that changes only the
 * query string (`?cycleId=…`) is out of scope here by construction.
 *
 * ONE KNOWN FALSE POSITIVE, and it is cheap: leave `startPath`, come straight
 * back to it, all inside one second. The watch then sees `startPath` again and
 * re-issues. Closing it would need a pathname SUBSCRIPTION rather than a
 * sample, and the cost of being wrong is one extra navigation to a href the
 * user asked for a second earlier — whereas an unguarded dropped click is a
 * dead row. Unmount cleanup removes the common shape of it for free (leaving
 * the list page clears the pending timer), but the predicate is what the
 * behaviour rests on; the cleanup is belt and braces.
 *
 * ── THE DELAY ────────────────────────────────────────────────────────────
 *
 * `DROPPED_PUSH_GRACE_MS = 1000`, from the same three captures and from both
 * directions:
 *
 *   · UPPER BOUND on a healthy navigation. Everything a committing navigation
 *     needed had arrived 339 ms after the click in the WORST capture (page
 *     chunk at +1117 ms for a click at +778 ms). 1000 ms is ~3x that.
 *   · LOWER BOUND on terminal silence. "Zero requests started >1000 ms after
 *     the click" is a measured fact in all three captures — 1000 ms is exactly
 *     the horizon past which the evidence says nothing further will happen.
 *
 * Shorter would race a slow-but-healthy fetch; longer would leave the user
 * staring at an unchanged page for no additional certainty. A retry that fires
 * against a navigation still in flight is idempotent anyway — same href, same
 * destination — so a false positive costs one request and a false negative
 * costs the click.
 *
 * ── WHY A HOOK AND NOT `DataTable` ───────────────────────────────────────
 *
 * `onRowClick` is typed `(row, e) => void`; `DataTable` cannot tell a
 * navigation from a sheet-opener or a selection toggle, and several call sites
 * pass exactly those. There is no choke point to put this behind, so the seam
 * is the hook, and `local/no-router-push-in-row-click` is what stops the next
 * list page from reintroducing the raw call.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import {
    beaconClientMetric,
    NAV_PUSH_RETRY_METRIC,
} from '@/lib/observability/client-telemetry';

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
 * `router.push` for a row navigation. Same call shape as the raw router's, so
 * migrating a call site is a one-line change.
 *
 *     const push = useGuardedPush();
 *     onRowClick={(row) => push(tenantHref(`/assets/${row.original.id}`))}
 */
export function useGuardedPush(): (href: string) => void {
    const router = useRouter();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Leaving the page means the navigation either committed or the user went
    // elsewhere; neither wants a retry. Not the primary defence — see the
    // predicate — but it costs one effect.
    useEffect(
        () => () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
    );

    return useCallback(
        (href: string) => {
            if (typeof window === 'undefined') {
                router.push(href);
                return;
            }

            const startPath = window.location.pathname;
            const targetPath = pathnameOf(href);
            const startedAt = Date.now();

            router.push(href);

            // A push that does not change the pathname is indistinguishable
            // from a dropped one by the test below, so it gets no watch.
            if (targetPath === startPath) return;

            // A second row click inside the window replaces the watch rather
            // than adding one: the later click's push is the one that matters,
            // and the evidence says a second click commits normally.
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                if (
                    !shouldRetryDroppedPush({
                        startPath,
                        currentPath: window.location.pathname,
                        targetPath,
                    })
                ) {
                    return;
                }

                // Route label is the LIST page, never the destination — a
                // detail pathname ends in the row id.
                beaconClientMetric({
                    name: NAV_PUSH_RETRY_METRIC,
                    value: Date.now() - startedAt,
                    route: startPath,
                });

                // Once. The retry is a bare `router.push`, so a dropped retry
                // is not retried again.
                router.push(href);
            }, DROPPED_PUSH_GRACE_MS);
        },
        [router],
    );
}
