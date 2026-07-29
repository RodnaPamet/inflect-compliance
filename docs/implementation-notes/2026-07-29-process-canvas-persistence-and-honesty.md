# 2026-07-29 — Process canvas persistence + monitor/analytics honesty

**Commits:** `0ec17385` · `20b33761` · `e7e3a63d` · `d8caa05d`

Prompt 3 of the process-canvas audit. Six findings, and they divide cleanly into
two kinds of defect — which is the useful thing to record.

| Finding | Kind |
|---|---|
| P3.1 rename dissolves every group | duplicated projection |
| P3.2 inspector edits neither saved nor undoable | write path bypassing its own seam |
| P3.3 monitor calls healthy runs "stuck" | the UI asserting something the query never checked |
| P3.4 analytics fabricates numbers | ditto, four times |
| P3.5 cancel is cosmetic | ditto, plus an unconditional write |
| P3.6 webhook evidence pre-approved | a state machine bypassed by a direct write |

## The duplicated-projection class (P3.1)

`handleRenameCommit` omitted `parentNodeKey`, so blurring a renamed map PUT every
node re-parented to root and dissolved every group server-side. It also
hardcoded `"Untitled step"` instead of `NODE_TAXONOMY[kind].defaultLabel`, and
omitted `expectedVersion`.

The finding named three copies of the projection. There were **four**:
`buildLiveSnapshot` carried one whose own doc comment said it *"mirrors the
projection used by saveGraph"* — precisely the property a second copy cannot
keep. That comment is the tell: a copy that documents its obligation to agree
with another copy is a bug with a countdown on it.

All four now derive from `serializeGraphForSave` in
`src/lib/processes/serialize-graph.ts`. Extracting to a module rather than
keeping a local helper was the load-bearing choice — it made the projection
testable without mounting the canvas, and the behavioural test
(`tests/rendered/serialize-graph-for-save.test.ts`) is what pins the two drifts
that actually happened.

`buildLiveSnapshot`'s **edge** projection stays local and hand-written: the diff
compares raw `e.data`, while a save sends the derived `controls` array. That
divergence is deliberate, so it should be visible rather than hidden behind a
shared helper with a flag.

## The write-path-bypasses-its-own-seam class (P3.2)

Three edit paths wrote through the raw state setters and so skipped both the undo
stack and the autosave debounce. `ProcessInspector` meanwhile told the user
"Click off the field or press Enter to save the edit."

The interesting one is the inspector. `updateNodeData` reaches `onNodesChange` as
a `replace` change — verified by reading the installed `@xyflow/react`, not
assumed: `updateNodeData` → `setNodes` → `batchContext.nodeQueue` →
`getElementsDiffChanges` (which emits `{type: 'replace'}` on a reference change)
→ `onNodesChange`. `isSubstantiveNodeChange` let it fall through to
`default: false`.

**Fixed at the classifier, not in the handler.** Calling `history.push` +
`markDirty` inside `handleInspectorUpdate` *as well* would push two undo entries
per edit — undo would need two presses. Picking one was mandatory, and the
classifier is the better one: `updateNodeData` is the only instance-level node
mutation in the component today, and any future caller is covered by
construction.

## The UI-asserts-what-the-query-never-checked class (P3.3, P3.4, P3.5)

Three findings, one shape: a component rendering a claim its data layer never
established.

**P3.3.** The live feed returned every `RUNNING` row with no timeout predicate,
and the console badged them "Stuck" with a Cancel button. Two non-obvious parts
of the fix:

- The deadline is per-execution (`rule.slaWindowMinutes`, else a default), so it
  cannot be one SQL predicate. Rows are read **oldest-first** — stuck runs are by
  definition the old ones, and the previous newest-first page would hide them
  behind healthy traffic once a tenant had >200 in flight.
- Rules **without** a window get the default deliberately. `sla-monitor` only
  sweeps rules that declare one, so unconfigured rules are exactly the ones whose
  `RUNNING` rows hang forever. Skipping them would have made the watchdog blind
  to its own best use case.

**P3.4.** Four separate untruths on one screen. The sharpest was arithmetic:
success rate was `100 - failed/ALL`, so SKIPPED and PENDING counted as
successes, while `topRules` used a *third* denominator (`succeeded/count`) — so a
rule could read 100% under "Most-fired" beside a headline that disagreed on the
identical executions. `successRate` is now returned by the server rather than
left for the client to re-derive as `100 - errorRate`: with a terminal
denominator the two are complements, and that invariant is worth asserting in
one place instead of in the UI.

`slaBreaches` was `errorMessage?.includes('SLA window')` — a string match on free
text presented as a hard KPI. `sla-monitor` writes `outcomeJson.slaBreached`.

**P3.5.** `cancelExecution` set SKIPPED and the dispatcher's completion write —
an unconditional `update` by id — overwrote it. A cancel landing while the row
was PENDING did not stop the action either: the claim's `updateMany` result was
discarded and the action fired anyway.

**No fake abort was invented.** There is no cooperative abort for an outbound
webhook, and adding an `AbortSignal` that nothing honours would be a third
untruth on top of the two being fixed. What shipped is the two achievable
things: pre-start cancel genuinely prevents the action (the claim's `count === 0`
now `continue`s), and mid-flight cancel sticks (settle *and* catch paths scoped
to `status: 'RUNNING'`) and halts the chain. Then the tooltip states exactly
that, including what it cannot do.

## The bypassed-state-machine class (P3.6)

`webhook-processor` wrote Evidence `status: 'APPROVED'`. `EVIDENCE_TRANSITIONS`
permits APPROVED only from SUBMITTED, and only through `reviewEvidence`, which
also enforces segregation of duties. A direct `create` is not a shortcut through
that gate — it is a hole in it, and for a GRC product that is record integrity,
not UX.

`SUBMITTED` rather than `DRAFT`: the content is complete, nobody is still
authoring it, so it belongs in the review queue. With no submitter recorded the
no-self-approval rule leaves any reviewer eligible, so the row is actionable.

## Decisions

- **Five existing tests asserted the buggy behaviour and were inverted.** The
  dispatcher's unconditional settle write, the all-rows error-rate denominator,
  the `'SLA window'` string match, and a RUNNING-row-is-stuck assertion. A test
  that pins a defect is not a reason to keep the defect — but it *is* a reason to
  read carefully before changing it, because sometimes the test is right and the
  finding is wrong.

- **`running` → `stuck` is a rename, and renames are the honest move here.** The
  field held every in-flight execution while being consumed as a stuck list. Two
  fixes were available: filter the data, or rename the consumer's expectation.
  Filtering alone would have left a field named `running` that no longer returned
  everything running.

- **Every fix is mutation-proved against a distinct test** — 5 mutations for the
  canvas write path, 3 for cancellation. Restores came from file copies, never
  `git checkout`: an uncommitted fix does not survive it, and the resulting
  failure count reads like a thorough suite rather than a missing baseline.

- **One finding needed no code.** P3.6's dedupe half was closed by #1753 earlier
  the same day. Recorded because "verified already fixed" and "not looked at"
  are indistinguishable in a diff.

- **A `as string` cast was written and then deleted.** It appeared to be needed
  for `isProcessNodeSize`'s narrowing; it was actually masking a broken import
  path in the newly extracted module. A cast that makes an error go away is
  worth one more minute of suspicion.
