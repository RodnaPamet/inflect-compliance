/**
 * tldraw's store diffs, mapped into the engine-free vocabulary.
 *
 * The sibling of `canvas-changes-xyflow.ts`, and the file that shows why the
 * vocabulary was worth extracting: the two engines do not report changes in
 * remotely the same shape, and neither one's format survives contact with the
 * other.
 *
 * ═══ THE KIND IS DERIVED HERE, NOT READ ═══
 *
 * xyflow hands over a typed union — `position` with a `dragging` flag,
 * `replace`, `dimensions`, `select` — so its mapper only has to switch on a
 * discriminator the engine already computed.
 *
 * tldraw hands over a `RecordsDiff`:
 *
 *     { added: Record<Id, R>, updated: Record<Id, [from: R, to: R]>, removed: … }
 *
 * so "a node moved" versus "a node's label changed" is a **comparison of the
 * two records**. There is no `position` versus `replace` to read; there is only
 * `from` and `to` and whatever you can tell from them.
 *
 * ═══ WHAT THE HOST FILTERS BEFORE THIS IS CALLED ═══
 *
 * The host listens with `{ scope: 'document', source: 'user' }`, which is
 * load-bearing and belongs to the engine rather than to this file:
 *
 *   - `scope: 'document'` drops camera, pointer and instance records. Without
 *     it every mouse move and every pan would arrive here, and the canvas would
 *     be permanently dirty.
 *   - `source: 'user'` drops remote merges. The repo deliberately did NOT adopt
 *     tldraw sync (see #2963), so there is no remote source today — the filter
 *     is there so that adding one later cannot silently make another editor's
 *     changes look like this user's unsaved work.
 *
 * This file is still defensive about record types it does not recognise, for
 * the same reason the xyflow mapper is: failing toward "do nothing" keeps an
 * unknown event from marking a document dirty.
 *
 * ═══ ON `substantive` MEANING ONE CONSEQUENCE HERE, NOT TWO ═══
 *
 * `canvas-changes.ts` defines significance by consequence — *"does this push an
 * undo entry and mark the document dirty?"* — because on xyflow those always
 * coincide. On tldraw they never do: the editor keeps its own undo stack
 * (measured — `getCanUndo()` flips to true after a `createShapes`, and `undo()`
 * removes the shape), so the host applies only the dirty half and pushes
 * nothing.
 *
 * Feeding the app's `use-canvas-history` from here would **double-handle undo**
 * — one entry from the editor, one from the app, for a single edit. That is the
 * same defect class as the edge `replace` double-push the xyflow mapper avoids
 * with `handled-by-caller`.
 *
 * So `substantive` here means "an edit worth keeping", and WHICH consequences
 * follow is the host's business. `handled-by-caller` is not used: it names a
 * caller that pushed history itself, which on tldraw is every change and
 * therefore no longer a distinction worth drawing.
 */
import type { ClassifiedChange } from './canvas-changes';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';

/**
 * The minimum of a tldraw record this file reads.
 *
 * Deliberately structural rather than importing `TLRecord`: the mapper needs
 * `typeName`, `type`, and — for shapes — geometry and props. Typing it this way
 * keeps the classification testable with plain objects, which is the same
 * property that let the xyflow mapper be tested without mounting xyflow.
 */
export interface TldrawRecordLike {
    typeName: string;
    type?: string;
    x?: number;
    y?: number;
    props?: Record<string, unknown>;
}

/** A `RecordsDiff`, narrowed to what this file reads. */
export interface TldrawDiffLike {
    added: Record<string, TldrawRecordLike>;
    updated: Record<string, readonly [TldrawRecordLike, TldrawRecordLike]>;
    removed: Record<string, TldrawRecordLike>;
}

type Subject = 'node' | 'edge' | 'freeform' | 'unknown';

/** What kind of thing this record is, in the product's terms. */
function subjectOf(r: TldrawRecordLike): Subject {
    if (r.typeName === 'shape') {
        if (r.type === PROCESS_NODE_SHAPE_TYPE) return 'node';
        // Any other shape on the canvas is the freeform layer — a sticky, an
        // arrow, a drawing. It is persisted to `ProcessMap.freeformJson`, so
        // adding one IS an edit worth saving, even though it never becomes a
        // row. `partitionCanvas` in the serializer draws the same line.
        return 'freeform';
    }
    if (r.typeName === 'binding') {
        return r.type === PROCESS_EDGE_BINDING_TYPE ? 'edge' : 'unknown';
    }
    return 'unknown';
}

const substantive = (kind: string): ClassifiedChange => ({
    significance: 'substantive',
    kind,
});

const transient = (kind: string): ClassifiedChange => ({
    significance: 'transient',
    kind,
});

/** Did anything the product cares about move? */
function movedGeometry(from: TldrawRecordLike, to: TldrawRecordLike): boolean {
    return from.x !== to.x || from.y !== to.y;
}

/** Did anything the product cares about change, other than geometry? */
function changedProps(from: TldrawRecordLike, to: TldrawRecordLike): boolean {
    // JSON comparison rather than a key-by-key walk: shape props are declared
    // JSON-serialisable (`dataJson` is `T.jsonValue`), and a walk would have to
    // re-derive the recursion rules the serializer already relies on.
    return JSON.stringify(from.props ?? null) !== JSON.stringify(to.props ?? null);
}

function classifyUpdate(
    from: TldrawRecordLike,
    to: TldrawRecordLike,
): ClassifiedChange {
    const subject = subjectOf(to);
    const moved = movedGeometry(from, to);
    const edited = changedProps(from, to);

    if (!moved && !edited) {
        // A record rewritten with no difference the product can see — a
        // rotation, an index reorder, a selection-driven field. Not an edit.
        return transient(`${subject}-untouched`);
    }
    if (subject === 'unknown') return transient('unknown-updated');

    // Both can be true in one diff (drag a node while its label is being
    // edited). Naming geometry first is arbitrary but stable; the significance
    // is the same either way, which is what the host acts on.
    if (moved && !edited) return substantive(`${subject}-moved`);
    if (edited && !moved) return substantive(`${subject}-data-replaced`);
    return substantive(`${subject}-moved-and-replaced`);
}

/**
 * Classify one tldraw store diff.
 *
 * Returns one entry per changed record, so `batchIsSubstantive` answers the
 * host's question over the whole diff — the same shape the xyflow host uses.
 *
 * NOTE ON DRAGS. A drag emits an `updated` diff per frame, each classified
 * substantive, so the host calls `markDirty()` many times. That is safe and
 * deliberate: `use-canvas-autosave.markDirty` clears its pending timer and
 * starts a new one, so repeated calls push the save LATER rather than saving
 * repeatedly — a drag produces exactly one save, timed from the last frame.
 * (Its own suite asserts that: *"a second markDirty before the delay restarts
 * the timer"*.) The xyflow mapper's `dragging === false` check exists because
 * that engine's host pushed HISTORY on every substantive change, and burying a
 * real undo point under twenty drag entries was the cost. tldraw's editor owns
 * history and squashes a translate itself, so the problem does not arise here.
 */
export function classifyTldrawDiff(diff: TldrawDiffLike): ClassifiedChange[] {
    const out: ClassifiedChange[] = [];

    for (const r of Object.values(diff.added)) {
        const subject = subjectOf(r);
        out.push(
            subject === 'unknown'
                ? transient('unknown-added')
                : substantive(`${subject}-added`),
        );
    }

    for (const r of Object.values(diff.removed)) {
        const subject = subjectOf(r);
        out.push(
            subject === 'unknown'
                ? transient('unknown-removed')
                : substantive(`${subject}-removed`),
        );
    }

    for (const [from, to] of Object.values(diff.updated)) {
        out.push(classifyUpdate(from, to));
    }

    return out;
}
