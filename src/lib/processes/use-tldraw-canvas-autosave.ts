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
 * The manual save brought a case that layer does NOT cover, and the version
 * ref below is for that case alone. The bar's Save waits for an autosave
 * already on the wire and then saves again at once, before React has rendered
 * the version the first save returned. `saveRef` still holds the callback from
 * the previous render, so a version captured in it would be the spent one. The
 * save reads the version from a ref the previous save wrote when it landed.
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
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Editor } from 'tldraw';

import type { ToastApi } from '@inflect/ui/components/ui/hooks/use-toast';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import {
    saveTldrawCanvas,
    type SavedProcessMap,
} from '@/lib/processes/tldraw-save';
import {
    useCanvasAutosave,
    type CanvasAutosaveApi,
    type FlushResult,
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

/** A manual save's outcome. */
export interface ManualSaveResult extends FlushResult {
    /**
     * True only when the server accepted the save. A 409 throws a
     * `VersionConflictError` after its reload toast (#5282), so `ok` is false
     * then too; `saved` stays the direct answer to "did the rename land".
     */
    saved: boolean;
}

export interface TldrawCanvasAutosaveApi extends CanvasAutosaveApi {
    /**
     * Save now, through the autosave queue — the bar's Save button and the
     * rename. `name` renames the map in the same PUT.
     */
    saveNow: (opts?: { name?: string }) => Promise<ManualSaveResult>;
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
}: UseTldrawCanvasAutosaveOptions): TldrawCanvasAutosaveApi {
    /*
        The version, read through a ref that a save updates THE MOMENT it lands.

        A manual save waits for an autosave already in flight and then saves
        again. The prop that carries the new version only arrives with the next
        render, which has not happened when that wait resolves — so the second
        save would send the version the first had just spent, and the server
        would refuse it as a conflict with nobody. Updating the ref inside the
        save closes that window. The effect keeps it in step with the prop for
        everything else: a load, and the `undefined` a conflict sets.
    */
    const versionRef = useRef(expectedVersion);
    useEffect(() => {
        versionRef.current = expectedVersion;
    }, [expectedVersion]);
    // The rename a manual save carries; taken (and cleared) by the save itself.
    const pendingNameRef = useRef<string | undefined>(undefined);
    // Whether the last save reached `onSaved` — see `ManualSaveResult.saved`.
    const landedRef = useRef(false);

    const save = useCallback(async () => {
        // Narrowing, not a guard against being called while disabled — the
        // `enabled` computation below is what stops that, and this is what
        // satisfies the types. A save already in flight when the editor
        // unmounts is unaffected either way: it read these values when it
        // started.
        if (!editor || !mapId) return;
        const name = pendingNameRef.current;
        pendingNameRef.current = undefined;
        landedRef.current = false;
        const version = versionRef.current;

        await saveTldrawCanvas({
            tenantSlug,
            mapId,
            ...(version !== undefined ? { expectedVersion: version } : {}),
            ...(name !== undefined ? { name } : {}),
            // Serialised HERE, when the debounce fires — not at render. The
            // payload has to be the canvas as it is at save time, not as it
            // was when the edit that started the timer landed.
            canvas: serializeEditorCanvas(editor),
            toast,
            onConflict,
            onSaved: (saved) => {
                versionRef.current = saved.version;
                landedRef.current = true;
                onSaved(saved);
            },
        });
    }, [editor, mapId, tenantSlug, toast, onConflict, onSaved]);

    const autosave = useCanvasAutosave({
        enabled: enabled && Boolean(editor) && Boolean(mapId),
        save,
        ...(delayMs !== undefined ? { delayMs } : {}),
    });

    const { flush } = autosave;
    const saveNow = useCallback(
        async (opts?: { name?: string }): Promise<ManualSaveResult> => {
            pendingNameRef.current = opts?.name;
            const result = await flush();
            // A refused or skipped save must not leave the rename to ride
            // along on the next autosave the user did not ask to rename.
            pendingNameRef.current = undefined;
            return { ...result, saved: result.ok && landedRef.current };
        },
        [flush],
    );

    return useMemo(() => ({ ...autosave, saveNow }), [autosave, saveNow]);
}
