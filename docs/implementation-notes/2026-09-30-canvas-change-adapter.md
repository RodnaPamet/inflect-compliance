# 2026-09-30 — graph-state adapter: change classification

**Commit:** `4b8a3853a feat(processes): classify canvas changes behind an engine-free adapter`

Phase 3 of the tldraw migration (#2961). The second of the two adapters that
are reviewable with neither engine mounted — the first was selection (#3011).

## Design

`PersistedProcessCanvas` classified changes by `switch`-ing over xyflow's
`NodeChange` / `EdgeChange` unions inline. The knowledge — *what counts as an
edit the user would expect to keep* — was therefore written in one library's
vocabulary, and the engine swap would have had to re-derive it from scratch in
the next one's.

The knowledge is not library-specific. "A drag finished" and "a drag is in
progress" are different events in any canvas; only the wire format differs. So:

```
src/lib/processes/canvas-changes.ts          the vocabulary, no engine named
src/lib/processes/canvas-changes-xyflow.ts   the xyflow mapper
                                             (a tldraw mapper is a SIBLING of
                                              this file, not an edit to it)
```

The host imports the vocabulary and one mapper. It names no engine change type
of its own, which is a guarded property rather than a convention.

## Three significances, not two

The obvious model is substantive-or-transient, and it is wrong. The two
inspector commit paths use **opposite mechanisms for the same user action**:

| edit | path | who pushes history |
| --- | --- | --- |
| node | `updateNodeData` → xyflow diffs a `replace` change | the change handler, from the classification |
| edge | `handleEdgeUpdate` | the caller, directly, before `setEdges` |

So a node `replace` must be substantive and an edge `replace` must NOT be —
classifying it would push **two undo entries for one edit**. Before this change
that asymmetry was documented on one side only: the node predicate explained
itself at length while `isSubstantiveEdgeChange` was a bare one-liner that
happened to be right.

`handled-by-caller` names the case, so it is a decision a reader can see rather
than an omission they have to reconstruct.

## The bug the classification already fixed once

A node `replace` used to fall through to "not substantive", so label, subtitle,
size and linked-entity edits were **neither autosaved nor undoable** — while
`ProcessInspector` told the user "Click off the field or press Enter to save the
edit." That is asserted now, not described.

## Files

| file | role |
| --- | --- |
| `src/lib/processes/canvas-changes.ts` | `ChangeSignificance`, `ClassifiedChange`, `isSubstantive`, `batchIsSubstantive` |
| `src/lib/processes/canvas-changes-xyflow.ts` | `classifyXyflowNodeChange` / `classifyXyflowEdgeChange`; every original comment carried across verbatim |
| `src/components/processes/PersistedProcessCanvas.tsx` | two inline predicates replaced by adapter calls |
| `tests/unit/processes/canvas-changes.test.ts` | 17 behavioural assertions incl. the asymmetry and the vacuity cases |
| `tests/guards/process-canvas-write-path.test.ts` | its classifier assertion re-pointed at the WIRING |

## Decisions

- **`dragging === false`, not `!c.dragging`.** The flag is optional, so an
  ABSENT one is not a commit. Falsiness would classify it as one and push an
  undo entry for an event that committed nothing. Has its own test.

- **An unknown variant is transient.** An engine that adds a change type must
  not spray undo entries; the cost is a missed dirty flag, which the next real
  edit sets.

- **An empty batch is not substantive.** An engine reporting no changes must not
  mark the document dirty.

- **The guard now asserts the wiring, not the classification.** The behaviour
  moved into a unit test that can be mutation-proved; what a unit test on the
  adapter cannot see is whether the host still CALLS it, so that is what the
  structural guard keeps — per handler, with the mapper paired to its handler.

## The extraction window was the defect, not the needle

Worth recording, because the first draft of that guard passed a mutation it
should have failed.

The rewritten assertion initially bound the handler body with
`braceBlockAfter(CANVAS, 'const onNodesChange = useCallback')`. That returned
**29,118 characters** — running from `onNodesChange` straight through
`onEdgesChange` and `onConnect`. Deleting `history.push({ nodes, edges })` from
the node handler left the guard **green**, because the same call occurs in those
siblings.

The mechanism is in `braceBoundedFrom`: it counts `{` / `}` only while
`parens === 0`. For a callback passed as an ARGUMENT —

```ts
const onNodesChange = useCallback<OnNodesChange>(
    (changes: NodeChange[]) => {     // ← this brace is at parens === 1
```

— the body brace is never counted, so the scan runs on until the file happens to
balance. `declarationOf(CANVAS, 'onNodesChange')` returns 589 characters and the
same mutation reddens.

The other 29 `braceBlockAfter` call sites all anchor outside an open paren
(`model X {`, `if (…) {`, `for (…) {`, an object-literal key), so this is narrow
rather than systemic — but **`braceBlockAfter` is the wrong helper for a
callback argument**, which is what `callExpressionOf` was written for and what
`declarationOf` covers when the callback is assigned to a `const`. The helper's
own test already pins the throwing case (`timerB = setInterval`); the silent
over-wide return happens when the file balances later instead.

## Mutation proof

| mutation | result |
| --- | --- |
| edge `replace` classified `substantive` (the double-push) | 2 failed |
| `dragging === false` weakened to `!c.dragging` | 1 failed |
| node `replace` falls through to transient (the fixed inspector bug) | 2 failed |
| `onNodesChange` classifies with the EDGE mapper | 1 failed |
| `history.push` dropped from `onNodesChange` | 1 failed |
| `markDirty` dropped from `onEdgesChange` | 1 failed |
| a predicate re-inlined in the host | 1 failed |

Sources restored md5-verified after each.

## Ratchets

Removing the old `/case "replace":[\s\S]*?return true;/` retired one unbounded
interior span, so `UNBOUNDED_INTERIOR_SPAN_BASELINE` 146 → 145 and
`INTERIOR_SPAN_BASELINE` 328 → 327 in the same diff (`DRIFT_ALLOWANCE` is 0).

The replacement uses regex LITERALS rather than one `it.each` building
`new RegExp(mapper)` — a computed pattern is un-analysable to the Class C
ratchet, which CAPS skips rather than ignoring them.
`UNANALYSABLE_TOMATCH_BASELINE` held at 57.
