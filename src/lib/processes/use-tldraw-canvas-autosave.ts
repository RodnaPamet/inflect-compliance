'use client';

/**
 * Autosave for the tldraw canvas — the same hook, a different save.
 *
 * `use-canvas-autosave` is unchanged and deliberately so: #2961 says *"keep the
 * state machine … rewire its `save()` to the serializer. Do not redesign it."*
 * This composes it with `saveTldrawCanvas`, and exists as its own module for
 * one reason — the composition has a failure mode neither half has.
 *
 * ═══ THE STALE-VERSION TRAP, AND WHO ACTUALLY PREVENTS IT ═══
 *
 * `save` is passed to a hook that holds it and calls it later. A `save` that
 * went stale would, after the FIRST successful save — which bumps the server's
 * version — send the version before that one on every subsequent cycle. The
 * server refuses each with 409, the reload toast fires on every autosave, and
 * the canvas becomes unsaveable while presenting as a conflict between two
 * users. There is no second user.
 *
 * **`use-canvas-autosave` already prevents this, and this module relies on that
 * rather than re-solving it.** It keeps its own `saveRef`, refreshes it in an
 * effect, and resolves the callback at FIRE time — with its own test, "uses the
 * latest save callback after the consumer re-renders". So a plain `useCallback`
 * with honest deps is sufficient, and that is what this is.
 *
 * The first version of this file carried a `latest` ref of its own to read
 * every changing value at call time. It was redundant: removing it changed
 * nothing, and four mutations aimed at it — capturing `expectedVersion`,
 * capturing `mapId`, and dropping either half of the `enabled` check — all
 * passed, because the other layer covered each one. Belt and braces where the
 * braces alone hold, and the tests could not tell which was doing the work.
 * Deleted rather than kept with a comment claiming it mattered.
 *
 * ═══ WHY `enabled` IS COMPUTED HERE — AND THAT IT IS BELT, NOT BRACES ═══
 *
 * The editor arrives asynchronously (tldraw's `onMount`), and a map can be
 * absent while the list loads. A save with no editor would throw inside the
 * serializer; a save with no map id would PUT to `/processes/null`. Not being
 * enabled avoids both, which is what the xyflow canvas does with
 * `enabled: Boolean(activeId) && !loading`.
 *
 * Measured, though: dropping either term from this check reddens NOTHING,
 * because the narrowing at the top of `save` returns early on the same
 * condition. Two layers, and no test can attribute the behaviour to one — so
 * the check is stated as the intent-carrying layer rather than the enforcing
 * one. What the tests DO pin is the observable property (no request goes out
 * with no editor or no map) and the mechanism that could actually break it
 * (the `useCallback` deps — dropping `editor`, `mapId` or `expectedVersion`
 * each reddens one test).
 *
 * The narrowing stays because the types need it. The `enabled` check stays
 * because it also stops the DEBOUNCE TIMER being started at all, which the
 * narrowing does not: without it every edit while loading would schedule a
 * save that then did nothing, and `status` would read `pending` over a canvas
 * that was never going to write.
 */
import { useCallback } from 'react';
import type { Editor } from 'tldraw';

import type { ToastApi } from '@/components/ui/hooks/use-toast';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import {
    saveTldrawCanvas,
    type SavedProcessMap,
} from '@/lib/processes/tldraw-save';
import {
    useCanvasAutosave,
    type CanvasAutosaveApi,
} from '@/lib/processes/use-canvas-autosave';

export interface UseTldrawCanvasAutosaveOptions {
    /** `null` until tldraw's `onMount` fires. */
    editor: Editor | null;
    tenantSlug: string;
    /** `null` while no map is selected. */
    mapId: string | null;
    /** The version last loaded or saved. Changes on every successful save. */
    expectedVersion?: number;
    toast: ToastApi;
    /** Bump a reload counter — the 409 toast's action calls this. */
    onConflict: () => void;
    /** Fresh version + updatedAt. The caller MUST feed the new version back. */
    onSaved: (saved: SavedProcessMap) => void;
    /** Extra reason to hold off, e.g. while the map is loading. */
    enabled?: boolean;
    delayMs?: number;
}

export function useTldrawCanvasAutosave({
    editor,
    tenantSlug,
    mapId,
    expectedVersion,
    toast,
    onConflict,
    onSaved,
    enabled = true,
    delayMs,
}: UseTldrawCanvasAutosaveOptions): CanvasAutosaveApi {
    const save = useCallback(async () => {
        // Narrowing, not a guard against being called while disabled — the
        // `enabled` computation below is what stops that, and this is what
        // satisfies the types. A save already in flight when the editor
        // unmounts is unaffected either way: it read these values when it
        // started.
        if (!editor || !mapId) return;

        await saveTldrawCanvas({
            tenantSlug,
            mapId,
            expectedVersion,
            // Serialised HERE, when the debounce fires — not at render. The
            // payload has to be the canvas as it is at save time, not as it
            // was when the edit that started the timer landed.
            canvas: serializeEditorCanvas(editor),
            toast,
            onConflict,
            onSaved,
        });
    }, [editor, mapId, tenantSlug, expectedVersion, toast, onConflict, onSaved]);

    return useCanvasAutosave({
        enabled: enabled && Boolean(editor) && Boolean(mapId),
        save,
        ...(delayMs !== undefined ? { delayMs } : {}),
    });
}
