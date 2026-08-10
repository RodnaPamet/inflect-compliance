# 2026-08-11 — Risks: eight swallowed writes, and the i18n key that never arrived

**Commit:** `e5bc5530 fix(risks): eight silently-swallowed writes across four pages`

Closes B2-1. The roadmap item was written as "migrate 41 raw `fetch` writes to
`useTenantMutation`", which is a shape, not a defect. What made the migration
worth doing was auditing all 26 writes remaining on the Risks surface and asking
of each one: *if this request fails, what does the user see?* On ten of them the
answer was "nothing"; on six, "a cleared form, which reads as success".

## Design

Each page keeps ONE mutation, keyed at the resource the page reads, and renders
its error beside the primary action:

```
kri/page.tsx        writeMutation   key '/risks/kri'         5 writes
hierarchy/page.tsx  nodeMutation    key '/risks/hierarchy'   3 node writes
loss-events/page.tsx  (page's own setMsg surface)            1 write
ai/page.tsx           (page's own setError state)            1 write
```

Two of these four pages already HAD an error surface that the failing handler
simply was not wired to — `hierarchy`'s `linkRisk`/`unlinkRisk` check `res.ok`
and render an `InlineNotice`; `loss-events`' `record` reports through `setMsg`.
So the fix on those pages is not a new convention, it is the existing one
applied consistently. Only `kri` needed a surface built.

The handler shape is uniform:

```ts
try {
    await mutation.trigger({ … });
    setDraft(EMPTY);          // only after it landed
} catch {
    /* visible via mutation.error; the draft stays */
} finally { setBusy(false); }
```

`setBusy(false)` stays in `finally` — releasing the button is correct on both
paths. Clearing user input is not; that moved into the success branch.

### One mutation per page, not one per handler

`useTenantMutation` exposes a single `error`/`isMutating` pair, so sharing one
instance across five handlers means a create failure and a delete failure light
the same lamp. That is acceptable here because the surface sits next to the
control the user just pressed and clears on the next `trigger()`. It is NOT
acceptable where two writes can be in flight at once — `RiskAssessmentPanel`
keeps one mutation per step for exactly that reason.

### Where the error goes

Beside the button, not in a toast. A dropped KRI reading is the worst case on
this surface: the reading is what drives remediation-task spawning, so a
silently-rejected one looks identical to a reading that simply did not breach
threshold. A toast that scrolls away is the wrong affordance for that.

## Two of these were reachable without an outage

The audit surfaced a second-order problem the swallowing had been hiding:

- `hierarchy/page.tsx` has **no permission gate at all**. The Add button renders
  for READER and AUDITOR while `createNode` calls `assertCanWrite` — a
  guaranteed 403 on every click, with no feedback.
- `loss-events` `remove` is the same shape: `deleteLossEvent` is ADMIN-only
  server-side, the button renders for everyone.

So these were not rare-failure paths. For a read-only user they failed 100% of
the time, silently. Surfacing the error is the floor; gating the control is the
real fix and is **not** in this change — it needs the `appPermissions` shape
these pages currently do not read, and it is worth doing across the surface at
once rather than two buttons at a time.

## The i18n keys that never arrived

Adding the error copy exposed a shipped bug. Three `saveError` keys had
accumulated inside `risks.correlations`:

```json
"correlations": {
    "saveError": "Couldn't save. Nothing was changed — try again.",        // meant for kri
    "saveError": "Couldn't save the scenario. Your entries are still here…", // meant for scenarios
    "saveError": "Couldn't save the correlation."                          // correct
}
```

`JSON.parse` accepts duplicate keys and keeps the **last** one. So:

- `risks.scenarios.saveError` did not exist. #1853 shipped a scenarios page that,
  on a failed save, rendered the literal string `scenarios.saveError` to the user
  — the exact class of bug it was written to fix.
- `risks.kri.saveError` would have done the same here.

Nothing caught it. The i18n completeness guard compares en against bg on the
PARSED objects, where the losing keys no longer exist — and both files carried
identical duplicates, so parity was perfect. Typecheck never sees message files.
The cause was mechanical: a script anchoring an insertion on a sibling key name
that was not unique across namespaces.

`tests/guardrails/i18n-completeness.test.ts` gains a fourth failure mode,
DUPLICATE, detected over the file **text** — by the time `JSON.parse` returns,
the evidence is gone. The scanner is string-literal-aware so a `{` or `"` inside
translated copy is never read as structure; its self-tests include the exact
misfiled-namespace shape and a value containing braces, colons and escaped
quotes.

## Files

| File | Role |
|---|---|
| `src/app/t/[tenantSlug]/(app)/risks/kri/page.tsx` | 5 writes → one `writeMutation`; new error surface |
| `src/app/t/[tenantSlug]/(app)/risks/hierarchy/page.tsx` | 3 node writes → `nodeMutation`; wired to the page's existing notice pattern |
| `src/app/t/[tenantSlug]/(app)/risks/loss-events/page.tsx` | `remove` reports through the same `setMsg` its sibling `record` uses |
| `src/app/t/[tenantSlug]/(app)/risks/ai/page.tsx` | `handleDismiss` no longer discards a paid-for suggestion set on failure |
| `messages/{en,bg}.json` | new keys, **and** two misfiled ones moved into their real namespaces |
| `tests/guardrails/i18n-completeness.test.ts` | DUPLICATE detection + self-tests |
| `tests/rendered/risk-write-failure-surfaces.test.tsx` | behavioural lock: error visible, input survives |

## Decisions

- **Behavioural test, not a structural guard.** A guard grepping page source for
  `res.ok` passes the moment someone writes the check and drops the result, and
  passes while the draft is still wiped in a `finally`. The only thing that
  separates fixed from broken is what the DOM holds after a failing click, so
  the test mounts both pages against a 500ing `fetch` and asserts (a) an alert
  is on screen and (b) the typed value is still in the input. It records the
  attempted writes too — otherwise "the input survived" would also pass on a
  page whose button does nothing at all. Verified by mutation: restoring
  `setDraft(EMPTY_DRAFT)` to the `finally` turns it red.
- **`record`'s bug was worth its own sentence in the commit.** It read
  `res.json()` without checking `res.ok`, so a 4xx parsed the *error envelope*,
  found no `remediationTaskId`, skipped the toast, and revalidated. Every
  observable signal matched a successful non-breaching reading.
- **No new i18n keys for loss-events and ai.** Both pages already had copy for
  a failed write; reusing it keeps the translator surface flat and made the
  inconsistency (`record` reports, `remove` does not) visible as the in-file
  contradiction it was.
- **The DUPLICATE check went into the existing i18n guard, not a new file.** It
  is a fourth instance of that file's stated invariant — "drift that silently
  renders the key name in production" — and the epic-ratchet policy says to name
  a guard for the invariant it protects, not for the diff that motivated it.
