# 2026-08-22 — derive the scheduled-job count; keep the vocabulary counts literal

## Design

A survey of the 1,206 `toHaveLength(<literal>)` calls in the suite found **7**
where the literal counts an enumeration that lives in a *different* file
(imported from `src/`). That cross-file split is the whole hazard:

```
branch A: adds job #33 to src/…/schedules.ts, writes toHaveLength(33) in tests/…
branch B: adds job #33 to src/…/schedules.ts, writes toHaveLength(33) in tests/…
merge:    34 jobs in src/, one `33` in tests/ — git merged both WITHOUT CONFLICT
```

Both PRs are green and the merge diff looks innocent. **The clean merge is the
dangerous case**, which is why "review it more carefully" is not a fix and
deriving is. (Same shape as the `doc-classification.json` `counts` header,
removed for the same reason — see the *Doc classifications* section of
`CLAUDE.md`.)

Same-file pairs are NOT the hazard: two branches editing one array conflict, and
a human reads the conflict.

## The rule, and the three reasons a count is a literal

> **Derive when the count is BOOKKEEPING. Keep the literal when the count is a
> CLAIM ABOUT THE DOMAIN.**

There are three distinct cases, and collapsing them neuters real tripwires:

| Case | Example | Treatment |
| --- | --- | --- |
| **Bookkeeping** — the number tracks its source and carries nothing the assertion beside it doesn't | `SCHEDULED_JOBS.length` | **Derive.** A literal here only ever goes stale. |
| **Domain claim** — a closed vocabulary's size; the number RESISTS its source | `MATURITY_LEVELS === 5`, `PHASE_ORDER === 8` | **Keep.** Deriving makes it true by construction — a tautology that can never fail. Growing the vocabulary must be a decision, not an append. |
| **Ratchet floor** — the number exists to notice a DECREASE | `RENDERED_TEST_FLOOR`, `CURRENT_BASELINE`, the border-tone budget, the design-drift ceiling | **Keep, untouched.** Out of scope of this change entirely. |

## Files

| File | Role |
| --- | --- |
| `tests/regression/infrastructure-guards.test.ts` | **Derived.** The expected name list is hoisted to `EXPECTED_SCHEDULED_JOB_NAMES` at module scope and is now the single source of truth; the length assertion reads `.length`. A new test asserts that list is sorted and duplicate-free — the derivation is only as good as the list it derives from. |
| `tests/guards/task-status-vocabulary.test.ts` | Kept `8`, with the reason inline. |
| `tests/unit/incident-deadlines.test.ts` | Kept `8`, with the reason inline. |
| `tests/unit/requirement-mapping.test.ts` | Kept `5`, with the reason inline. |
| `tests/unit/org-maturity.test.ts` | Kept `5`, with the reason inline. |
| `tests/guardrails/incident-containment-forensic-coverage.test.ts` | Kept `6`, with the reason inline. |
| `tests/unit/schemas/asset-form-schema.test.ts` | Kept `10`, with the reason inline. |

## Decisions

- **`TASK_STATUS_BADGE` needed an actual read, and came out a KEEP.** The
  assertion above it already compares the map's keys against the LIVE Prisma
  enum as a set — so a ninth status added to *both* sides passes it. The `8` is
  therefore not tracking the map; it is the claim that `TaskStatus` is a closed
  eight-value vocabulary, and it is the only thing in the file that resists the
  enum growing. Deriving it (`toHaveLength(ENUM_VALUES.length)`) would have made
  it unfalsifiable.
- **`INCIDENT_RESPONSE_RACI` likewise.** Its sibling assertion is a weak
  `some(/dpo|legal/)`, so the `6` is the only thing that notices a role being
  added or dropped. The same file already distinguishes the two shapes:
  `FORENSIC_EVIDENCE_CHECKLIST` is deliberately asserted with
  `toBeGreaterThanOrEqual(5)` because that list is open-ended.
- **Every KEEP carries a one-line `LITERAL ON PURPOSE — do not derive` comment**
  naming the reason, so the next person doing this sweep does not "finish the
  job" and silently disarm four vocabulary tripwires.
- **The count test was kept rather than deleted** once derived. It fails first
  and legibly ("Expected length: 32, Received length: 33") ahead of the 32-line
  array diff, and it now needs no maintenance.
- **Sorted + duplicate-free is asserted on the list itself.** A duplicated name
  would inflate `.length` and mask a genuinely double-registered repeatable job;
  an out-of-sort-order append would turn the name-set failure into an unreadable
  diff.
- **Job-name comments moved with the list.** The per-entry provenance notes
  ("Audit Coherence S7 — daily admin escalation when …") were already the useful
  part of that array; hoisting them to module scope keeps them where a
  contributor adding a job will read them.
