/**
 * A live editor's canvas, projected to the save payload.
 *
 * The bridge between a mounted tldraw editor and `tldrawToRows` — the last
 * piece before `save()` can be repointed at the serializer.
 *
 * ═══ WHY THIS IS NOT `store.allRecords()` ═══
 *
 * `allRecords()` returns EVERYTHING the store holds: camera, instance,
 * pointer, page, document, presence. `partitionCanvas` puts anything it does
 * not recognise into `freeform`, and `freeform` is persisted to
 * `ProcessMap.freeformJson`.
 *
 * So handing it the whole store would write the user's **camera position and
 * pointer coordinates into the document** — on every save, growing the column
 * with per-session junk that the next load would faithfully restore. The
 * filter to `shape` / `binding` is what makes `partitionCanvas`'s contract
 * ("a real store hands back everything on the canvas") true, and it belongs
 * here rather than there: the serializer is testable without an editor
 * precisely because it never sees a store.
 *
 * ═══ AND WHY IT IS PAGE-SCOPED ═══
 *
 * A process map is one page. tldraw allows more, and `allRecords()` spans them,
 * so a shape the user parked on a second page would silently become a row.
 * Shapes come from the current page; a binding is kept only when BOTH its
 * endpoints are shapes on that page — a binding to a shape that is gone, or on
 * another page, is exactly the dangling edge `validateEdge` refuses, and it is
 * better not to hand it one.
 */
import type { Editor, TLBinding } from 'tldraw';

import {
    partitionCanvas,
    tldrawToRows,
    type CanvasRecord,
    type FreeformRecord,
    type GraphRows,
} from './serializer';

/** What a save needs: the rows, and the freeform layer that rides beside them. */
export interface EditorCanvas {
    rows: GraphRows;
    freeform: FreeformRecord[];
}

/**
 * Project the editor's current page to rows.
 *
 * Throws `EdgeEndpointError` if the graph holds an edge the validator refuses —
 * the same refusal the canvas applies when drawing, so a save cannot store an
 * edge the UI would not have allowed. The caller surfaces it; this does not
 * swallow it, because a silent drop would lose the edge and say nothing.
 */
export function serializeEditorCanvas(editor: Editor): EditorCanvas {
    const shapes = editor.getCurrentPageShapes();
    const onPage = new Set(shapes.map((s) => String(s.id)));

    // A type PREDICATE, not a cast: narrowing on `typeName` is what gives
    // `fromId` / `toId` their types below, and it is the same discrimination
    // `partitionCanvas` performs one level down.
    const isBinding = (r: { typeName: string }): r is TLBinding =>
        r.typeName === 'binding';

    // The endpoint check is BELT-AND-BRACES, and no test constructs the case
    // because the case cannot be constructed: measured against a mounted
    // editor, deleting an endpoint shape takes the binding count from 1 to 0 —
    // tldraw removes dependent bindings itself.
    //
    // Kept anyway because the failure mode is disproportionate. `tldrawToRows`
    // runs `validateEdge`, which THROWS `EdgeEndpointError` on an unknown
    // endpoint rather than skipping it, so one orphaned binding would fail the
    // whole save rather than lose one edge. Cheap insurance against a tldraw
    // version that stops cleaning up, and it is stated as insurance rather than
    // implied to be load-bearing.
    const bindings = editor.store
        .allRecords()
        .filter(isBinding)
        .filter(
            (b) => onPage.has(String(b.fromId)) && onPage.has(String(b.toId)),
        );

    // SPREAD, and it does two jobs.
    //
    // Typing: `FreeformRecord` carries `[k: string]: unknown`, and TypeScript
    // does not give an INTERFACE an implicit index signature — so `TLBaseShape`
    // is not assignable to it however compatible the values are. Spreading
    // yields an anonymous object type, which is. That is the difference between
    // a cast and a conversion: nothing is asserted, a new object is made.
    //
    // Semantics: the payload becomes a SNAPSHOT rather than a set of live store
    // references. A save is async, and a user editing while one is in flight
    // should not be able to change what is being written — the autosave hook's
    // `dirtySince` check exists for exactly that race, and handing it a moving
    // target would undo the care taken there.
    const records: CanvasRecord[] = [
        ...shapes.map((s) => ({ ...s })),
        ...bindings.map((b) => ({ ...b })),
    ];

    const partitioned = partitionCanvas(records);
    return {
        rows: tldrawToRows(partitioned),
        freeform: partitioned.freeform,
    };
}
