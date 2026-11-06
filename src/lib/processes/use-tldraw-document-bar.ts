'use client';

/**
 * The document bar's four prop groups, for a tldraw canvas.
 *
 * ── Why a hook and not a second bar ──────────────────────────────────
 *
 * `CanvasDocumentBar` imports nothing from xyflow. It is 479 lines of chrome
 * driven entirely by `{ doc, busy, editorState, handlers }`, all of which are
 * plain data or callbacks. So the bar is reused unchanged and this supplies
 * its inputs from a tldraw `Editor` instead of from `nodes`/`edges`.
 *
 * Three of the twelve handlers were already engine-agnostic and are imported
 * rather than rewritten — `patchCanvasMode`, `patchProcessStatus` and
 * `deleteProcessMap` from `switch-canvas-mode.ts`.
 *
 * ── A rename is a save that also sets a name ─────────────────────────
 *
 * Not a separate endpoint. The xyflow rename PUTs `name` alongside a full
 * `serializeGraphForSave(...)`, so it carries the graph too — which is why it
 * reads as engine-coupled. Here it goes through the map's `saveMap` with a
 * `name`, the same call the Save button makes. That is the autosave's own
 * queue, so a rename inherits the version token, the 409 handling and the
 * `onSaved` contract, and cannot race an autosave for the token.
 *
 * ── Undo/redo is tldraw's, and it has to be OBSERVED ─────────────────
 *
 * tldraw owns its history (`getCanUndo`/`getCanRedo`/`undo`/`redo`), so the
 * app's `use-canvas-history` is not involved — feeding both would double-handle
 * every undo. But `getCanUndo()` is a read, not a subscription: called once it
 * yields a value that then goes stale, leaving the bar's buttons wrong until
 * something else re-renders. So the store is listened to and the two flags are
 * mirrored into state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor } from 'tldraw';

import type { ToastApi } from '@inflect/ui/components/ui/hooks/use-toast';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';
import {
    patchCanvasMode,
    patchProcessStatus,
    deleteProcessMap,
    type CanvasMode,
} from '@/lib/processes/switch-canvas-mode';
import { saveTldrawCanvas } from '@/lib/processes/tldraw-save';
import type { ManualSaveResult } from '@/lib/processes/use-tldraw-canvas-autosave';
import { refusalReason } from '@/lib/api-error';
import { extractMutationError } from '@/lib/mutations';

/**
 * The snap preference's storage key.
 *
 * Deliberately the SAME key the xyflow bar writes. A tenant flipping the
 * feature flag would otherwise find their snap setting reset, which reads as
 * the migration having lost state rather than as two canvases with separate
 * preferences.
 */
export const SNAP_STORAGE_KEY = 'inflect:processes:snap';

/** The subset of `ProcessMapSummary` this hook reads and writes. */
export interface DocumentBarProcess {
    id: string;
    name: string;
    description?: string | null;
    status: string;
    version: number;
    canvasMode?: CanvasMode;
}

/**
 * Generic over the process type.
 *
 * The caller's summary is richer than `DocumentBarProcess` — the page's
 * `ProcessMapSummary` carries `createdAt`, `nodeCount` and more — and its
 * `onProcessesChange` is typed for that richer shape. Pinning the parameter to
 * the subset made the callback contravariantly incompatible at the call site,
 * so the only way to pass it was a cast. The hook never reads the extra fields;
 * it spreads them through. So it is parameterised instead, and the caller's type
 * survives the round trip.
 */
export interface UseTldrawDocumentBarOptions<P extends DocumentBarProcess> {
    tenantSlug: string;
    editor: Editor | null;
    mapId: string | null;
    processes: P[];
    activeProcess: P | null;
    /** Current concurrency token, from the container. */
    version: number | undefined;
    autosaveStatus: AutosaveStatus;
    autosaveError: string | null;
    toast: ToastApi;
    onActiveIdChange: (id: string | null) => void;
    onProcessesChange: (next: P[]) => void;
    onConflict: () => void;
    /**
     * The open map's manual save, or `null` until the map and editor are up.
     *
     * Save and rename go through this rather than a PUT of their own: it is
     * the autosave's queue, so the two share one version token. A Save that
     * PUT by itself while an autosave was in flight sent the version the
     * autosave had just spent, and the 409 that came back read as somebody
     * else editing the map.
     */
    saveMap: ((opts?: { name?: string }) => Promise<ManualSaveResult>) | null;
    /** Seam for tests. */
    fetchImpl?: typeof fetch;
}

function readSnapPreference(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(SNAP_STORAGE_KEY) === '1';
    } catch {
        // A browser with site data blocked must not take the canvas down.
        return false;
    }
}

export function useTldrawDocumentBar<P extends DocumentBarProcess>({
    tenantSlug,
    editor,
    mapId,
    processes,
    activeProcess,
    version,
    autosaveStatus,
    autosaveError,
    toast,
    onActiveIdChange,
    onProcessesChange,
    onConflict,
    saveMap,
    fetchImpl,
}: UseTldrawDocumentBarOptions<P>) {
    const [editedName, setEditedName] = useState(activeProcess?.name ?? '');
    const [snapEnabled, setSnapEnabledState] = useState(readSnapPreference);
    const [saving, setSaving] = useState(false);
    const [creating, setCreating] = useState(false);
    const [duplicating, setDuplicating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);

    const doFetch = fetchImpl ?? globalThis.fetch;

    // The bar's own sentences, for a failure the server gave no reason for
    // (#4987). These were English literals, and the throws they backed put
    // the HTTP status in the message. Strings, not `t`, in the callbacks'
    // dependencies: a string is equal across renders by value.
    const t = useTranslations('automation.canvas');
    const failSave = t('failSave');
    const failRename = t('failRename');
    const failCreate = t('failCreate');
    const failDuplicate = t('failDuplicate');
    const failModeSwitch = t('failModeSwitch');
    const failStatusChange = t('failStatusChange');

    // Mirror the active map's name into the editable field when the selection
    // changes or a rename lands from elsewhere.
    useEffect(() => {
        setEditedName(activeProcess?.name ?? '');
    }, [activeProcess?.id, activeProcess?.name]);

    // Undo/redo availability, observed rather than read once. See the header.
    useEffect(() => {
        if (!editor) {
            setCanUndo(false);
            setCanRedo(false);
            return;
        }
        const sync = () => {
            setCanUndo(editor.getCanUndo());
            setCanRedo(editor.getCanRedo());
        };
        sync();
        // No scope filter: undo availability changes on history operations,
        // and narrowing to `document` would miss some of them. This is a
        // cheap two-boolean read, so the wider net costs nothing.
        return editor.store.listen(sync);
    }, [editor]);

    const setSnapEnabled = useCallback(
        (next: boolean | ((prev: boolean) => boolean)) => {
            setSnapEnabledState((prev) => {
                const value = typeof next === 'function' ? next(prev) : next;
                try {
                    window.localStorage.setItem(SNAP_STORAGE_KEY, value ? '1' : '0');
                } catch {
                    // Preference not persisted; the session still honours it.
                }
                editor?.user.updateUserPreferences({ isSnapMode: value });
                return value;
            });
        },
        [editor],
    );

    const handleSave = useCallback(async () => {
        if (!saveMap) return;
        setSaving(true);
        setError(null);
        try {
            const result = await saveMap();
            if (!result.ok) setError(extractMutationError(result.cause ?? null, failSave));
        } finally {
            setSaving(false);
        }
    }, [saveMap, failSave]);

    const handleRenameCommit = useCallback(async () => {
        if (!activeProcess) return;
        const trimmed = editedName.trim();
        // An empty or unchanged name is a no-op, and the field snaps back —
        // otherwise clearing it and blurring would send `name: ''`.
        if (trimmed === '' || trimmed === activeProcess.name || !saveMap) {
            setEditedName(activeProcess.name);
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const result = await saveMap({ name: trimmed });
            if (result.saved) {
                onProcessesChange(
                    processes.map((p) =>
                        p.id === activeProcess.id ? { ...p, name: trimmed } : p,
                    ),
                );
            } else {
                // Refused, or answered with a conflict the reload toast owns:
                // either way the stored name is still the old one, so the
                // field says so rather than showing a rename that did not land.
                setEditedName(activeProcess.name);
                if (!result.ok) setError(extractMutationError(result.cause ?? null, failRename));
            }
        } finally {
            setSaving(false);
        }
    }, [activeProcess, editedName, saveMap, processes, onProcessesChange, failRename]);

    /**
     * Create a map, in either canvas mode (#3116).
     *
     * ── WHY THE ARGUMENT IS NORMALISED ──────────────────────────────────
     *
     * `CanvasDocumentBar` renders `onClick={handleNew}`, so React hands this a
     * SyntheticEvent as its first argument. Before this took a parameter that
     * was harmless; now an un-normalised read would put an event object into the
     * request body, where `CreateProcessMapSchema`'s enum rejects it — so the
     * bar's own New button would 400 while the command palette worked.
     *
     * Only an explicit `'AUTOMATION'` flips the mode. Anything else — an event,
     * undefined, a stray string — is a DOCUMENT map, which is the safe
     * direction: a document map created by accident is renameable, whereas an
     * automation map created by accident offers a rule editor over a process
     * nobody modelled as one.
     *
     * Lifted verbatim in intent from the deleted xyflow canvas, which had the
     * same two call shapes and the same normalisation for the same reason.
     */
    const handleNew = useCallback(async (canvasMode: CanvasMode | unknown = 'DOCUMENT') => {
        setCreating(true);
        setError(null);
        try {
            const mode: CanvasMode = canvasMode === 'AUTOMATION' ? 'AUTOMATION' : 'DOCUMENT';
            // Distinct names, because the two are different artefacts to the
            // person reading the list: a workflow is a rule graph, a process is
            // a map. The xyflow bar used exactly these two strings.
            const name =
                mode === 'AUTOMATION'
                    ? `Untitled workflow ${processes.length + 1}`
                    : `Untitled process ${processes.length + 1}`;
            const res = await doFetch(`/api/t/${tenantSlug}/processes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, canvasMode: mode }),
            });
            if (!res.ok) throw new Error(await refusalReason(res));
            const data = (await res.json()) as P;
            /*
                `canvasMode` is filled in from the request when the response
                omits it. The server is the authority and does return it — but a
                summary missing the field reads as DOCUMENT everywhere
                downstream (`activeProcess.canvasMode ?? 'DOCUMENT'`), so a
                freshly created AUTOMATION map would open on the document bar
                until the next list refresh. The deleted bar did the same, with
                the same `?? mode` shape.
            */
            onProcessesChange([...processes, { ...data, canvasMode: data.canvasMode ?? mode }]);
            onActiveIdChange(data.id);
        } catch (e) {
            setError(extractMutationError(e, failCreate));
        } finally {
            setCreating(false);
        }
    }, [tenantSlug, processes, doFetch, onProcessesChange, onActiveIdChange, failCreate]);

    const handleDuplicate = useCallback(async () => {
        if (!activeProcess || !editor) return;
        setDuplicating(true);
        setError(null);
        try {
            const res = await doFetch(`/api/t/${tenantSlug}/processes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: `${activeProcess.name} (copy)`,
                    canvasMode: activeProcess.canvasMode ?? 'DOCUMENT',
                }),
            });
            if (!res.ok) throw new Error(await refusalReason(res));
            const created = (await res.json()) as P;

            // Seed the copy with the CURRENT canvas, and note there is no
            // `expectedVersion`: the map was just created, so there is no
            // prior version to guard against and sending the source map's
            // would be a mismatch by construction.
            await saveTldrawCanvas({
                tenantSlug,
                mapId: created.id,
                canvas: serializeEditorCanvas(editor),
                toast,
                onConflict,
                onSaved: () => {
                    /* the copy is not the open map; its version is not ours */
                },
                ...(fetchImpl ? { fetchImpl } : {}),
            });

            onProcessesChange([...processes, created]);
            onActiveIdChange(created.id);
        } catch (e) {
            setError(extractMutationError(e, failDuplicate));
        } finally {
            setDuplicating(false);
        }
    }, [
        activeProcess, editor, tenantSlug, processes, doFetch, toast, onConflict,
        onProcessesChange, onActiveIdChange, fetchImpl, failDuplicate,
    ]);

    const onSwitchMode = useCallback(async () => {
        if (!activeProcess) return;
        const next: CanvasMode =
            activeProcess.canvasMode === 'AUTOMATION' ? 'DOCUMENT' : 'AUTOMATION';
        try {
            await patchCanvasMode(tenantSlug, activeProcess.id, next);
            onProcessesChange(
                processes.map((p) =>
                    p.id === activeProcess.id ? { ...p, canvasMode: next } : p,
                ),
            );
        } catch (e) {
            setError(extractMutationError(e, failModeSwitch));
        }
    }, [activeProcess, tenantSlug, processes, onProcessesChange, failModeSwitch]);

    const onChangeStatus = useCallback(
        async (status: string) => {
            if (!activeProcess || activeProcess.status === status) return;
            try {
                await patchProcessStatus(
                    tenantSlug,
                    activeProcess.id,
                    status as Parameters<typeof patchProcessStatus>[2],
                );
                onProcessesChange(
                    processes.map((p) =>
                        p.id === activeProcess.id ? { ...p, status } : p,
                    ),
                );
            } catch (e) {
                setError(extractMutationError(e, failStatusChange));
            }
        },
        [activeProcess, tenantSlug, processes, onProcessesChange, failStatusChange],
    );

    const onDelete = useCallback(async () => {
        if (!activeProcess) return;
        await deleteProcessMap(tenantSlug, activeProcess.id);
        const remaining = processes.filter((p) => p.id !== activeProcess.id);
        onProcessesChange(remaining);
        onActiveIdChange(remaining[0]?.id ?? null);
    }, [activeProcess, tenantSlug, processes, onProcessesChange, onActiveIdChange]);

    const handleUndo = useCallback(() => {
        editor?.undo();
    }, [editor]);

    const handleRedo = useCallback(() => {
        editor?.redo();
    }, [editor]);

    const doc = useMemo(
        () => ({
            activeId: mapId,
            processes,
            activeProcess,
            editedName,
            loadedMap: version !== undefined ? { version } : null,
            error,
        }),
        [mapId, processes, activeProcess, editedName, version, error],
    );

    const busy = useMemo(
        () => ({ saving, loading: false, creating, duplicating }),
        [saving, creating, duplicating],
    );

    const editorState = useMemo(
        () => ({ snapEnabled, autosaveStatus, autosaveError, canUndo, canRedo }),
        [snapEnabled, autosaveStatus, autosaveError, canUndo, canRedo],
    );

    const handlers = useMemo(
        () => ({
            onActiveIdChange,
            setEditedName,
            handleSave,
            handleNew,
            handleDuplicate,
            handleRenameCommit,
            handleUndo,
            handleRedo,
            setSnapEnabled,
            onSwitchMode,
            onChangeStatus,
            onDelete,
        }),
        [
            onActiveIdChange, handleSave, handleNew, handleDuplicate,
            handleRenameCommit, handleUndo, handleRedo, setSnapEnabled,
            onSwitchMode, onChangeStatus, onDelete,
        ],
    );

    return { doc, busy, editorState, handlers };
}
