'use client';

import { useEffect } from 'react';

/**
 * Warn before the browser discards unsaved work.
 *
 * `beforeunload` is the only hook the platform gives us for tab close,
 * refresh, and following a raw `<a href>` out of the app. It is NOT a
 * general navigation guard: App Router client-side transitions never fire
 * it, and there is no supported blocker API for those — so a caller that
 * needs to cover in-app links must do that separately, and should say so
 * rather than implying this covers everything.
 *
 * Extracted because there were two hand-rolled copies pending: the vendor
 * assessment client, and the process canvas — where autosave had been
 * silently discarding every edit between manual saves, so the browser prompt
 * was the difference between losing work and being told.
 *
 * Deliberately takes a BOOLEAN rather than a status enum. Callers know what
 * "unsaved" means for their own state machine, and the canvas is the reason:
 * its autosave reports `saved` after a failed save unless the consumer
 * rethrows, so a hook that tried to infer dirtiness from a status would have
 * inherited that bug rather than guarded against it.
 */
export function useUnsavedChangesWarning(hasUnsavedChanges: boolean): void {
    useEffect(() => {
        if (!hasUnsavedChanges) return;

        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Browsers ignore custom text and show their own copy; the
            // assignment is still required to trigger the prompt at all.
            e.returnValue = '';
        };

        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [hasUnsavedChanges]);
}

/**
 * Confirm before an IN-APP link discards unsaved work.
 *
 * `beforeunload` covers tab close, refresh and leaving the origin. It does
 * NOT fire for App Router client-side transitions, so clicking a sidebar
 * link loses work silently — which is the commoner case by far. Closing a
 * tab is deliberate; clicking away is a reflex.
 *
 * WHY A CAPTURE-PHASE CLICK LISTENER rather than wrapping the router or
 * `<Link>`:
 *   - it catches raw `<a href>` elements too, and the canvas renders two of
 *     its own — the closest exits to the user's cursor. A router wrapper
 *     misses exactly those;
 *   - it needs no cooperation from the chrome (sidebar, breadcrumbs,
 *     switchers all live outside this subtree and would each need wrapping);
 *   - capture phase means we decide before any handler has begun navigating.
 *
 * WHAT IT CANNOT COVER, stated rather than implied — the App Router has no
 * blocker API, and the `pushState` decoy workaround corrupts the history
 * stack, which is worse than the problem:
 *   - browser Back / Forward;
 *   - programmatic `router.push` from outside a link (the ⌘K command palette
 *     is the realistic one).
 * Those still lose work silently. This closes the link-shaped exits, which
 * are most of them, and `beforeunload` closes the rest of the browser-level
 * ones.
 */
export function useUnsavedNavigationGuard(
    hasUnsavedChanges: boolean,
    confirmMessage: string,
): void {
    useEffect(() => {
        if (!hasUnsavedChanges) return;

        const onClickCapture = (e: MouseEvent) => {
            // Modified clicks open a new tab/window — the current document
            // keeps its unsaved state, so there is nothing to warn about.
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

            const anchor = (e.target as Element | null)?.closest?.('a');
            if (!anchor) return;

            const href = anchor.getAttribute('href');
            if (!href || href.startsWith('#')) return;
            // `target=_blank` and downloads leave this document intact.
            if (anchor.target && anchor.target !== '_self') return;
            if (anchor.hasAttribute('download')) return;

            const url = new URL(href, window.location.href);
            if (url.origin !== window.location.origin) return;
            // Same page — no navigation, nothing to lose.
            if (url.pathname === window.location.pathname && url.search === window.location.search) {
                return;
            }

            if (!window.confirm(confirmMessage)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };

        document.addEventListener('click', onClickCapture, true);
        return () => document.removeEventListener('click', onClickCapture, true);
    }, [hasUnsavedChanges, confirmMessage]);
}
