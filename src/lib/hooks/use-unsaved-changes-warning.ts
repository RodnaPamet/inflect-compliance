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
