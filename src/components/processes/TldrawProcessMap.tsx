'use client';

/**
 * A process map on tldraw: load → edit → autosave.
 *
 * ── What this is, and what it deliberately is not ────────────────────
 *
 * The pieces of the tldraw write path all landed separately and none of them
 * had a caller: `TldrawProcessCanvas` renders rows and hands back an editor,
 * `serializeEditorCanvas` projects that editor back to rows,
 * `saveTldrawCanvas` writes them, and `useTldrawCanvasAutosave` decides when.
 * This is the first thing that composes them into a map you can open, change
 * and have saved — the load half, which nothing had yet.
 *
 * It is NOT the document chrome. No bar, no inspector, no palette, no export
 * menu. Those are the next PR and they are a lot of surface; keeping them out
 * means this one is reviewable and the composition can be proven on its own.
 *
 * ── Why it does not share code with PersistedProcessCanvas ───────────
 *
 * Measured (#2961): of that component's document handlers only three are
 * engine-free, and rename / duplicate / save each need the current canvas
 * content — which is `nodes`/`edges` there and `serializeEditorCanvas(editor)`
 * here. So extracting a shared seam means refactoring 2,560 lines of live,
 * shipping code to serve a second caller that phase 4 deletes. The duplication
 * avoided is a few dozen lines of fetch handlers. This side gets its own, and
 * the other side is not touched until it is removed.
 *
 * ── The version is the concurrency token, and it must move ───────────
 *
 * `expectedVersion` goes out with every save and the server rejects a stale
 * one with 409. So the version held here has to be updated from each save's
 * response, not from the load only: otherwise the first save succeeds, the
 * second sends the now-stale original, and every subsequent edit conflicts
 * against the user's own previous write. `onSaved` is where that happens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from 'tldraw';

import { useToast } from '@/components/ui/hooks';
import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import type { SavedProcessMap } from '@/lib/processes/tldraw-save';
import { useTldrawCanvasAutosave } from '@/lib/processes/use-tldraw-canvas-autosave';

export interface TldrawProcessMapProps {
    tenantSlug: string;
    /** The map to open. `null` renders the empty state rather than fetching. */
    mapId: string | null;
    /** Mirrors `TldrawProcessCanvas` — no edits, and autosave stays off. */
    readOnly?: boolean;
    /** Fires after each successful save, for a parent that shows saved-state. */
    onSaved?: (saved: SavedProcessMap) => void;
    /** Overrides the autosave debounce; omitted keeps the hook's own default. */
    delayMs?: number;
    /** Seam for tests. Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
}

/** The GET payload. Only the fields this component reads are declared. */
interface LoadedMap {
    id: string;
    version: number;
    nodes: GraphRows['nodes'];
    edges: Array<
        Omit<GraphRows['edges'][number], 'controls' | 'dataJson'> & {
            controls?: GraphRows['edges'][number]['controls'];
            dataJson?: GraphRows['edges'][number]['dataJson'];
        }
    >;
}

/**
 * The GET response to `GraphRows`.
 *
 * Nodes pass through — the column names are the row names. Edges need two
 * defaults: the route omits `controls` entirely for an edge that has none, and
 * `dataJson` is absent rather than null. `TldrawProcessCanvas` seeds bindings
 * from these, and an undefined `controls` would reach `props.controls` on a
 * binding whose declared type is an array.
 */
function toRows(data: LoadedMap): GraphRows {
    return {
        nodes: data.nodes,
        edges: data.edges.map((e) => ({
            ...e,
            controls: e.controls ?? [],
            dataJson: e.dataJson ?? null,
        })),
    };
}

export function TldrawProcessMap({
    tenantSlug,
    mapId,
    readOnly = false,
    onSaved,
    delayMs,
    fetchImpl,
}: TldrawProcessMapProps) {
    const toast = useToast();
    /**
     * The loaded map, TAGGED with the id it came from.
     *
     * One piece of state rather than separate `rows` + `version`, and tagged
     * rather than cleared, because the untagged version has a window: switching
     * from map A to map B renders A's rows under B's id until B's fetch
     * resolves — and an autosave in that window would write A's graph to B.
     * Deriving from the tag closes it structurally instead of relying on an
     * effect to clear in time.
     */
    const [loaded, setLoaded] = useState<{
        mapId: string;
        rows: GraphRows;
        version: number | undefined;
    } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null);

    /** Only the map currently asked for — never a previous one's rows. */
    const current = loaded && loaded.mapId === mapId ? loaded : null;

    // Kept in a ref so the save handler below is stable — a parent passing a
    // fresh `onSaved` closure each render would otherwise change `handleSaved`,
    // and with it the options object the autosave hook receives.
    //
    // Written in an effect rather than during render: assigning `ref.current`
    // while rendering is what `react-hooks` warns about, and the value is only
    // ever read from an async save callback, which runs after commit.
    const onSavedRef = useRef(onSaved);
    useEffect(() => {
        onSavedRef.current = onSaved;
    }, [onSaved]);

    const doFetch = fetchImpl ?? globalThis.fetch;

    useEffect(() => {
        // No synchronous clearing here: `current` is derived from the tag, so
        // there is nothing to reset and nothing to reset it in time for.
        if (!mapId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        void (async () => {
            try {
                const res = await doFetch(`/api/t/${tenantSlug}/processes/${mapId}`);
                if (!res.ok) throw new Error(`Load failed (${res.status})`);
                const data = (await res.json()) as LoadedMap;
                if (cancelled) return;
                setLoaded({ mapId, rows: toRows(data), version: data.version });
            } catch (e) {
                if (cancelled) return;
                // Surfaced in the component, not only toasted: a map that
                // failed to load must not render as an empty canvas, which the
                // user would then edit and save OVER the real one.
                setError(e instanceof Error ? e.message : 'Load failed');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [tenantSlug, mapId, doFetch]);

    const handleSaved = useCallback((saved: SavedProcessMap) => {
        // THE line that keeps concurrency working across more than one save.
        setLoaded((prev) => (prev ? { ...prev, version: saved.version } : prev));
        onSavedRef.current?.(saved);
    }, []);

    const handleConflict = useCallback(() => {
        // The save path already surfaced the 409 to the user. Clearing the
        // version stops the next autosave firing another doomed write with the
        // same stale token; the parent's reload path is what recovers.
        setLoaded((prev) => (prev ? { ...prev, version: undefined } : prev));
    }, []);

    const autosave = useTldrawCanvasAutosave({
        editor,
        tenantSlug,
        mapId,
        ...(current?.version !== undefined ? { expectedVersion: current.version } : {}),
        toast,
        onConflict: handleConflict,
        onSaved: handleSaved,
        // Read-only maps must not write. `TldrawProcessCanvas` also sets the
        // editor's own readonly state, but that governs the UI; this governs
        // the network.
        enabled: !readOnly && Boolean(mapId),
        ...(delayMs !== undefined ? { delayMs } : {}),
    });

    if (!mapId) {
        return <div data-testid="tldraw-map-empty" />;
    }
    if (error) {
        return (
            <div data-testid="tldraw-map-error" className="text-content-muted">
                {error}
            </div>
        );
    }
    if (loading || !current) {
        return <div data-testid="tldraw-map-loading" />;
    }

    return (
        <div data-testid="tldraw-map" className="h-full w-full">
            <TldrawProcessCanvas
                rows={current.rows}
                readOnly={readOnly}
                onEditorReady={setEditor}
                onDirty={autosave.markDirty}
            />
        </div>
    );
}
