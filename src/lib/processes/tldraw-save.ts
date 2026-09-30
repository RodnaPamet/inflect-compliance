/**
 * The tldraw canvas's save — the same PUT, the same concurrency, new payload.
 *
 * #2961 is explicit about the shape of this: *"Rewire its `save()` to the
 * serializer. Do not redesign it."* and *"Keep `expectedVersion` on every save.
 * Keep `surfaceVersionConflict` and its reload toast … Preserve that honesty
 * verbatim."* So every branch below mirrors `PersistedProcessCanvas.handleSave`,
 * and the differences are only the two that have to differ.
 *
 * ═══ WHAT DIFFERS FROM THE XYFLOW SAVE, AND WHY ═══
 *
 * 1. **The rows come from the editor**, via `serializeEditorCanvas`. Injected
 *    as a value rather than taken as an `Editor`, so the concurrency logic
 *    below — the part that can lose a user's work — is testable without
 *    mounting anything. That is the same seam the selection and change
 *    adapters use.
 *
 * 2. **It sends `freeformJson`.** xyflow has no freeform layer, so its save
 *    omits the field and the server leaves the stored value alone — which is
 *    exactly right for a renderer that cannot produce one. tldraw can, so
 *    omitting it here would mean stickies were never persisted, and sending
 *    `undefined` would mean "leave alone" rather than "this is the layer now".
 *    An empty canvas therefore sends `[]`, not nothing: a user who deletes
 *    their last sticky has to be able to erase the layer.
 *
 * ═══ THE THROW IS THE CONTRACT ═══
 *
 * A failed save MUST reject. `handleSave` carries a long comment about why,
 * paid for once already: swallowing the error made every failure look like a
 * success, so `use-canvas-autosave` took its saved branch, nulled
 * `dirtySince`, and the bar rendered "Saved" over unsaved work. `status ===
 * 'error'` was unreachable from the canvas, which is why the documented
 * no-retry behaviour never appeared.
 *
 * A 409 is the deliberate exception: it RESOLVES. A version conflict is
 * handled by the reload toast, not by failing the save — the user's edits are
 * still in the store, and telling autosave it failed would start the
 * error-state machinery for something the toast already owns.
 *
 * Reporting is the caller's. This module does not toast on failure: the
 * persistent error chip in `CanvasDocumentBar` (#3018) is the surface that
 * survives a dismissal, and a module that both threw and toasted would produce
 * two notices for one failure.
 */
import type { ToastApi } from '@/components/ui/hooks/use-toast';
import type { EditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import { surfaceVersionConflict } from '@/lib/processes/version-conflict-toast';

/** What the server returns from a successful save. */
export interface SavedProcessMap {
    id: string;
    version: number;
    updatedAt: string;
    nodes: unknown[];
    edges: unknown[];
}

export interface SaveTldrawCanvasInput {
    tenantSlug: string;
    mapId: string;
    /**
     * The version last loaded or saved. The server refuses a mismatch with
     * 409 / `STALE_DATA`.
     *
     * OMITTED means no check, and that is deliberate rather than lax: the
     * xyflow save spreads it conditionally for the same reason, because a map
     * whose version is not yet known must still be savable. Passing
     * `undefined` here sends no field, exactly as before.
     */
    expectedVersion?: number;
    /** `serializeEditorCanvas(editor)` — injected, so this is testable. */
    canvas: EditorCanvas;
    /**
     * Rename the map as part of this save.
     *
     * The route takes the name on the same PUT as the graph, and the xyflow
     * rename handler uses that — it sends `name` alongside a full
     * `serializeGraphForSave(...)`. So a rename IS a save that also sets a
     * name, not a separate endpoint, and routing it through here rather than a
     * second fetch means it inherits the version token, the 409 handling and
     * the `onSaved` contract instead of reimplementing all three.
     */
    name?: string;
    toast: ToastApi;
    /** Bump a reload counter; the 409 toast's action calls this. */
    onConflict: () => void;
    /** Fresh version + updatedAt, for the summary list and the loaded map. */
    onSaved: (saved: SavedProcessMap) => void;
    /** Seam for tests. */
    fetchImpl?: typeof fetch;
}

export async function saveTldrawCanvas({
    tenantSlug,
    mapId,
    expectedVersion,
    canvas,
    name,
    toast,
    onConflict,
    onSaved,
    fetchImpl = fetch,
}: SaveTldrawCanvasInput): Promise<void> {
    const payload = {
        nodes: canvas.rows.nodes,
        edges: canvas.rows.edges,
        // Always sent — see the header. `[]` erases the layer; omitting would
        // leave whatever was stored.
        freeformJson: canvas.freeform,
        // BELT-AND-BRACES, measured. `JSON.stringify` drops `undefined`
        // values, so `{ expectedVersion: undefined }` would serialise to an
        // absent field anyway — changing this to a plain `expectedVersion,`
        // reddens nothing. The conditional stays because it makes the intent
        // legible at the call site and does not depend on a `JSON.stringify`
        // behaviour a future body encoder might not share, but it is not what
        // delivers the property. The WIRE is what matters and the wire is
        // tested.
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        // Conditional for a REAL reason here, unlike `expectedVersion` above.
        // The route treats a present `name` as an instruction: `undefined` is
        // dropped by JSON.stringify and harmless, but `null` or `''` would
        // rename the map to nothing. Absent is the only way to say "leave it",
        // so an ordinary save must not carry the key at all.
        ...(name !== undefined ? { name } : {}),
    };

    const res = await fetchImpl(`/api/t/${tenantSlug}/processes/${mapId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    // 409 first, and BEFORE the `res.ok` check: a conflict is not a failed
    // save. The helper surfaces the reload toast and this resolves, leaving
    // autosave in its saved branch rather than starting the error machinery
    // for something the toast owns.
    if (await surfaceVersionConflict(res, toast, onConflict)) return;

    if (!res.ok) throw new Error(`Save failed (${res.status})`);

    onSaved((await res.json()) as SavedProcessMap);
}
