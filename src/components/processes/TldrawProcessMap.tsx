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
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from 'tldraw';

import { useToast } from '@/components/ui/hooks';
import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { applySavedRuleIds } from '@/components/processes/tldraw/apply-saved-rule-ids';
import type { EdgeRefusal } from '@/components/processes/tldraw/edge-validation';
import type { FreeformRecord, GraphRows } from '@/components/processes/tldraw/serializer';
import type { SavedProcessMap } from '@/lib/processes/tldraw-save';
import type { CanvasAutosaveApi } from '@/lib/processes/use-canvas-autosave';
import {
    useTldrawCanvasAutosave,
    type TldrawCanvasAutosaveApi,
} from '@/lib/processes/use-tldraw-canvas-autosave';
import { apiErrorMessage } from '@/lib/api-error';

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
    /**
     * Hands the editor up as well as keeping it.
     *
     * The container needs the editor for the autosave; the WORKSPACE around it
     * needs the same editor for the document bar's undo/redo, the selection
     * adapter and the export menu. Passing it up rather than moving ownership
     * out keeps this component usable on its own — it is the load→edit→save
     * unit, and a caller that wants only that should not have to hold an editor
     * to get it.
     */
    onEditorReady?: (editor: Editor) => void;
    /**
     * The group the canvas is scoped to, or `null` for the whole map.
     *
     * Threaded rather than held here. The drill STACK belongs with the
     * breadcrumb that renders it, and that breadcrumb is workspace chrome —
     * this component is the load/edit/save unit and has no trail to show.
     * Owning the stack here would give one piece of navigation state two
     * owners.
     */
    drillGroupId?: string | null;
    /** A group was entered on the canvas; the owner pushes it on the stack. */
    onEnterGroup?: (nodeKey: string) => void;
    /**
     * Reports the state the document BAR needs: the concurrency token for its
     * version pill, and the autosave status for its saved-state indicator.
     *
     * One callback rather than three props lifted out, because this component
     * stays usable on its own — it is the load→edit→save unit, and a caller
     * that wants only that should not have to own the version to get it. The
     * workspace around it does want them, so they are reported rather than
     * moved.
     */
    onStateChange?: (state: {
        version: number | undefined;
        autosaveStatus: CanvasAutosaveApi['status'];
        autosaveError: string | null;
    }) => void;
    /**
     * Hands the owner this map's manual save, or `null` while there is none.
     *
     * The bar's Save button and the rename go through it, so they share the
     * autosave's queue and version token rather than racing it with a PUT of
     * their own. See `useCanvasAutosave`'s `flush`.
     */
    onSaveNowChange?: (saveNow: TldrawCanvasAutosaveApi['saveNow'] | null) => void;
    /** A step to select once the map is loaded. */
    focusStepKey?: string | null;
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
    /**
     * The freeform layer: notes, text, drawings, frames. Saved with every PUT,
     * and read back here so a reload shows it. Not an array when nothing was
     * ever saved (null) or when the column holds something this canvas did not
     * write.
     */
    freeformJson?: unknown;
}

/** The stored freeform layer, or nothing when the column is not one. */
function toFreeform(value: unknown): FreeformRecord[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (r): r is FreeformRecord =>
            typeof r === 'object' &&
            r !== null &&
            typeof (r as { id?: unknown }).id === 'string' &&
            typeof (r as { type?: unknown }).type === 'string' &&
            typeof (r as { typeName?: unknown }).typeName === 'string',
    );
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

/**
 * Why a refused edge is TOASTED, and why the text is not `describeRefusal`.
 *
 * `installArrowToEdgeConversion` refuses an arrow by calling `onRefuse` and
 * returning — the arrow stays on the canvas as a plain tldraw arrow. So with
 * nothing wired here the user drew a connector, it silently stopped being an
 * edge, and the only feedback was its failure to look like one.
 *
 * The xyflow canvas already settled the shape of this feedback and it is
 * copied rather than reinvented: `toast.warning` (a refusal is the product
 * working, not an error), and ONE shared toast id so a run of misclicks
 * collapses into a single toast instead of a stack.
 *
 * `describeRefusal` in `edge-validation.ts` returns English, and its docblock
 * says it is "separate so callers can substitute one" — this is that
 * substitution. Using it directly would have shipped a canvas whose refusals
 * are the only un-localised strings on the surface, which is a regression the
 * cutover would have carried: the xyflow path localises these.
 *
 * Typed `Record<EdgeRefusal['code'], string>` on purpose. The tldraw validator
 * refuses FIVE things where xyflow refused three, so two keys are new; typing
 * it as a total map over the union means a sixth refusal code is a type error
 * here rather than a toast that says "undefined".
 */
function buildRefusalMessages(
    t: ReturnType<typeof useTranslations>,
): Record<EdgeRefusal['code'], string> {
    return {
        SELF_LOOP: t('rejectSelf'),
        DUPLICATE_EDGE: t('rejectDuplicate'),
        NODE_IS_ANNOTATION: t('rejectAnnotation'),
        NODE_IS_GROUP: t('rejectGroup'),
        UNKNOWN_NODE_KEY: t('rejectUnknownNode'),
    };
}

/** One shared id, so rapid-fire refusals collapse into one toast. */
const REFUSAL_TOAST_ID = 'canvas-connection-rejected';

export function TldrawProcessMap({
    tenantSlug,
    mapId,
    readOnly = false,
    onSaved,
    delayMs,
    fetchImpl,
    onEditorReady,
    onStateChange,
    drillGroupId = null,
    onEnterGroup,
    onSaveNowChange,
    focusStepKey = null,
}: TldrawProcessMapProps) {
    const toast = useToast();
    const t = useTranslations('automation.canvas');
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
        freeform: FreeformRecord[];
        version: number | undefined;
    } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null);
    // Bumped by the conflict toast's Reload to re-run the load (#5081).
    const [reloadKey, setReloadKey] = useState(0);

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
    // The sentence, not `t`: a string is equal across renders by value, so
    // depending on it re-runs the load only when the language changes.
    const failLoad = t('failLoad');

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
                if (!res.ok) {
                    // The server's reason, or the canvas's own sentence —
                    // never the status code (#4987).
                    const refusal: unknown = await res.json().catch(() => null);
                    throw new Error(apiErrorMessage(refusal, failLoad));
                }
                const data = (await res.json()) as LoadedMap;
                if (cancelled) return;
                setLoaded({
                    mapId,
                    rows: toRows(data),
                    freeform: toFreeform(data.freeformJson),
                    version: data.version,
                });
            } catch (e) {
                if (cancelled) return;
                // Surfaced in the component, not only toasted: a map that
                // failed to load must not render as an empty canvas, which the
                // user would then edit and save OVER the real one.
                // A network failure's text is the browser's, not ours.
                setError(e instanceof Error && !(e instanceof TypeError) && e.message ? e.message : failLoad);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [tenantSlug, mapId, doFetch, failLoad, reloadKey]);

    // The editor, for applying what a save returns; a ref because the save
    // callback is memoised once and the editor arrives after it.
    const editorRef = useRef<Editor | null>(null);
    useEffect(() => {
        editorRef.current = editor;
    }, [editor]);
    const handleSaved = useCallback((saved: SavedProcessMap) => {
        // A new Action or Agent step's rule, created by this save.
        if (editorRef.current) applySavedRuleIds(editorRef.current, saved.nodes ?? []);
        // THE line that keeps concurrency working across more than one save.
        setLoaded((prev) => (prev ? { ...prev, version: saved.version } : prev));
        onSavedRef.current?.(saved);
    }, []);

    // The 409 toast's Reload action (#5081). It used to clear the version
    // token and nothing else, so "Reload" reloaded nothing and the next save
    // went out with no token at all. It now re-reads the map: the loading state
    // unmounts the canvas, and the fresh rows and version mount in its place.
    // Autosave stops by itself on a conflict, because the save throws.
    const handleConflict = useCallback(() => {
        setReloadKey((k) => k + 1);
    }, []);

    /**
     * Tell the user why the arrow they drew is not an edge.
     *
     * `refusals` can hold more than one reason — `validateEdge` pushes a
     * refusal per failing rule, so drawing a duplicate onto an annotation
     * reports both. They are joined rather than truncated to the first:
     * fixing one and being told about the next is the loop a single-reason
     * toast creates, and the full list is two short sentences.
     *
     * `t` is a dependency because the factory closes over it. In practice
     * next-intl returns a stable translator for a stable locale, so this is
     * about honesty rather than churn — and the canvas keeps the callback in
     * a ref it refreshes, so a new identity costs nothing there either.
     */
    const handleEdgeRefused = useCallback(
        (refusals: EdgeRefusal[]) => {
            if (refusals.length === 0) return;
            const messages = buildRefusalMessages(t);
            const text = [...new Set(refusals.map((r) => messages[r.code]))].join(' ');
            toast.warning(text, { id: REFUSAL_TOAST_ID });
        },
        [t, toast],
    );

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

    // Reported in an effect, not during render: calling a parent's callback
    // while rendering would set state in the parent mid-render.
    const reportRef = useRef(onStateChange);
    useEffect(() => {
        reportRef.current = onStateChange;
    }, [onStateChange]);
    useEffect(() => {
        reportRef.current?.({
            version: current?.version,
            autosaveStatus: autosave.status,
            autosaveError: autosave.error,
        });
    }, [current?.version, autosave.status, autosave.error]);

    const saveNowReportRef = useRef(onSaveNowChange);
    useEffect(() => {
        saveNowReportRef.current = onSaveNowChange;
    }, [onSaveNowChange]);
    const { saveNow } = autosave;
    const canSave = Boolean(editor) && Boolean(current) && !readOnly;
    useEffect(() => {
        saveNowReportRef.current?.(canSave ? saveNow : null);
        return () => saveNowReportRef.current?.(null);
    }, [canSave, saveNow]);

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
                freeform={current.freeform}
                readOnly={readOnly}
                drillGroupId={drillGroupId}
                focusNodeKey={focusStepKey}
                onEnterGroup={onEnterGroup}
                onEditorReady={(e) => {
                    setEditor(e);
                    onEditorReady?.(e);
                }}
                onDirty={autosave.markDirty}
                onEdgeRefused={handleEdgeRefused}
            />
        </div>
    );
}
