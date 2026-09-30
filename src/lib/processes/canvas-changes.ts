/**
 * What a canvas change MEANS — the vocabulary, with no engine named.
 *
 * ═══ WHY THIS IS A SEPARATE FILE FROM ANY MAPPER ═══
 *
 * #2961 replaces the rendering engine. The host currently classifies changes by
 * `switch`-ing over xyflow's `NodeChange` union, so that knowledge is expressed
 * in one library's vocabulary and would have to be re-derived in the next one's.
 *
 * The knowledge itself is not library-specific. "A drag finished" and "a drag is
 * in progress" are different events in any canvas; only the wire format differs.
 * So the vocabulary lives here, each engine gets a mapper beside it, and the
 * host never sees an engine's change type.
 *
 * ═══ THREE SIGNIFICANCES, NOT TWO ═══
 *
 * The obvious model is substantive-or-transient. It is wrong, and the reason is
 * worth stating because it is the one thing a port would silently break.
 *
 * The two inspector commit paths use OPPOSITE mechanisms for the same user
 * action:
 *
 *   - A NODE edit goes through `updateNodeData`, which queues a store update
 *     that xyflow diffs into a `replace` change. History and dirty-marking
 *     happen in the change handler, from the classification.
 *   - An EDGE edit goes through `handleEdgeUpdate`, which calls `history.push`
 *     and `markDirty` DIRECTLY before `setEdges`.
 *
 * So a node `replace` must be substantive, and an edge `replace` must NOT be —
 * classifying it would push TWO undo entries for one edit. That asymmetry is
 * load-bearing and was, before this file, documented on one side only: the node
 * predicate explains itself at length while `isSubstantiveEdgeChange` was a bare
 * one-liner that happened to be right.
 *
 * `handled-by-caller` names that case, so it is a decision a reader can see
 * rather than an omission they must reconstruct.
 *
 * ═══ THE BUG THIS CLASSIFICATION ALREADY FIXED ONCE ═══
 *
 * A node `replace` used to fall through to "not substantive", which meant label,
 * subtitle, size and linked-entity edits were **neither autosaved nor undoable**
 * — while the inspector told the user "Click off the field or press Enter to save
 * the edit." Losing that in the engine swap would reintroduce a fixed defect, so
 * it is asserted rather than described.
 */

/**
 * What the host should do about a change.
 *
 * Deliberately about CONSEQUENCE, not about the shape of the event.
 *
 * ── AMENDED when the second engine arrived ───────────────────────────
 *
 * This said the host's only question is *"does this push an undo entry and mark
 * the document dirty?"*, as a single question, because on xyflow those two
 * consequences always coincide: that engine has no history of its own, so
 * `use-canvas-history` is a hand-rolled snapshot stack the change handler
 * pushes to explicitly.
 *
 * On tldraw they never coincide. The editor keeps its own undo stack — measured
 * against a mounted one: `getCanUndo()` flips true after a `createShapes`, and
 * `undo()` removes the shape — so its host marks dirty and pushes **nothing**.
 * Feeding the app's history from there would double-handle undo, one entry from
 * the editor and one from the app for a single edit, which is the defect
 * `handled-by-caller` exists to prevent on the other side.
 *
 * So read `substantive` as **"an edit worth keeping"**, and let each host apply
 * the consequences its engine leaves to it. The vocabulary still decides which
 * changes matter; it no longer claims both consequences follow together.
 */
export type ChangeSignificance =
    /** Push an undo entry and mark dirty. An edit the user would expect to keep. */
    | 'substantive'
    /**
     * Ignore. Selection, measurement, and the intermediate ticks of a drag —
     * marking these dirty would autosave on every click and bury a real undo
     * point under twenty drag entries.
     */
    | 'transient'
    /**
     * A real edit whose commit path ALREADY pushed history and marked dirty.
     * Classifying it as substantive double-pushes; classifying it as transient
     * says something false about it. Hence a third value.
     */
    | 'handled-by-caller';

/** A change classified into the vocabulary, with the reason kept for the reader. */
export interface ClassifiedChange {
    significance: ChangeSignificance;
    /** Short, stable label — used in tests and in nothing user-facing. */
    kind: string;
}

/** The host's only question. */
export function isSubstantive(c: ClassifiedChange): boolean {
    return c.significance === 'substantive';
}

/**
 * Did any change in a batch warrant an undo entry?
 *
 * Engines report changes in batches, and one substantive change among twenty
 * transient ones still means the document changed. `.some` rather than a filter
 * length, so a batch of a thousand selection ticks costs one early exit.
 */
export function batchIsSubstantive(changes: readonly ClassifiedChange[]): boolean {
    return changes.some(isSubstantive);
}
