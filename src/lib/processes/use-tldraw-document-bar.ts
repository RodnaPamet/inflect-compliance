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
 * reads as engine-coupled. Here it goes through `saveTldrawCanvas` with its
 * new optional `name`, so it inherits the version token, the 409 handling and
 * the `onSaved` contract rather than reimplementing all three beside them.
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
import type { Editor } from 'tldraw';

import type { ToastApi } from '@/components/ui/hooks/use-toast';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';
import {
    patchCanvasMode,
    patchProcessStatus,
    deleteProcessMap,
    type CanvasMode,
} from '@/lib/processes/switch-canvas-mode';
import { saveTldrawCanvas, type SavedProcessMap } from '@/lib/processes/tldraw-save';

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
    onSaved: (saved: SavedProcessMap) => void;
    onConflict: () => void;
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
    onSaved,
    onConflict,
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

    /** Save the current page. Shared by the manual save and the rename. */
    const saveNow = useCallback(
        async (name?: string) => {
            if (!editor || !mapId) return;
            await saveTldrawCanvas({
                tenantSlug,
                mapId,
                canvas: serializeEditorCanvas(editor),
                ...(version !== undefined ? { expectedVersion: version } : {}),
                ...(name !== undefined ? { name } : {}),
                toast,
                onConflict,
                onSaved,
                ...(fetchImpl ? { fetchImpl } : {}),
            });
        },
        [editor, mapId, tenantSlug, version, toast, onConflict, onSaved, fetchImpl],
    );

    const handleSave = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            await saveNow();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Save failed');
        } finally {
            setSaving(false);
        }
    }, [saveNow]);

    const handleRenameCommit = useCallback(async () => {
        if (!activeProcess) return;
        const trimmed = editedName.trim();
        // An empty or unchanged name is a no-op, and the field snaps back —
        // otherwise clearing it and blurring would send `name: ''`.
        if (trimmed === '' || trimmed === activeProcess.name) {
            setEditedName(activeProcess.name);
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await saveNow(trimmed);
            onProcessesChange(
                processes.map((p) =>
                    p.id === activeProcess.id ? { ...p, name: trimmed } : p,
                ),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Rename failed');
        } finally {
            setSaving(false);
        }
    }, [activeProcess, editedName, saveNow, processes, onProcessesChange]);

    const handleNew = useCallback(async () => {
        setCreating(true);
        setError(null);
        try {
            const name = `Untitled process ${processes.length + 1}`;
            const res = await doFetch(`/api/t/${tenantSlug}/processes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, canvasMode: 'DOCUMENT' }),
            });
            if (!res.ok) throw new Error(`Create failed (${res.status})`);
            const data = (await res.json()) as P;
            onProcessesChange([...processes, data]);
            onActiveIdChange(data.id);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Create failed');
        } finally {
            setCreating(false);
        }
    }, [tenantSlug, processes, doFetch, onProcessesChange, onActiveIdChange]);

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
            if (!res.ok) throw new Error(`Duplicate failed (${res.status})`);
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
            setError(e instanceof Error ? e.message : 'Duplicate failed');
        } finally {
            setDuplicating(false);
        }
    }, [
        activeProcess, editor, tenantSlug, processes, doFetch, toast, onConflict,
        onProcessesChange, onActiveIdChange, fetchImpl,
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
            setError(e instanceof Error ? e.message : 'Mode switch failed');
        }
    }, [activeProcess, tenantSlug, processes, onProcessesChange]);

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
                setError(e instanceof Error ? e.message : 'Status change failed');
            }
        },
        [activeProcess, tenantSlug, processes, onProcessesChange],
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
