# 2026-10-06 — the external-write clamp raised to `AUTOMATIC` (#2861)

**Commit:** `<sha> Raise the external-write clamp to AUTOMATIC (#2861)`

## Design

One constant moves:

```
src/lib/integrations/external-write-ladder.ts
  export const EXTERNAL_MAX_MODE: ExternalWriteMode = 'PROPOSE_ONLY'  →  'AUTOMATIC'
```

`LADDER` is `['DISABLED','DRY_RUN','PROPOSE_ONLY','AUTOMATIC']`, so this puts the
ceiling at the top rung.

**RAISING THE CEILING MOVES NO CONNECTION.** `EXTERNAL_MAX_MODE` is a ceiling, not
a setting. Every `IntegrationConnection` keeps whatever rung an operator stored,
defaulting to `DISABLED`; there is no migration, no backfill and no default
change in this diff. What changes is that `AUTOMATIC` stops being refused for
naming an authority the build cannot exercise — a tenant still has to climb to
it one rung at a time.

### What a tenant must now satisfy to reach the top rung

The ceiling stops answering, so `refusalForMove` does, and for
`PROPOSE_ONLY → AUTOMATIC` it asks for two things:

| term | value | where |
| --- | --- | --- |
| dwell | `MODE_MIN_DAYS` = 7 days at `PROPOSE_ONLY`, from `modeSince`; any narrowing restarts it | `external-write-ladder.ts` |
| evidence | `MODE_MIN_EVIDENCE.PROPOSE_ONLY` = 1 APPROVED PROPOSAL, counted as an `ExternalWriteJournal` row at `mode:'PROPOSE_ONLY'` | `countEvidenceForRung` in `external-write-policy.ts` |

That is strictly *harder* than the step below it, which is the property #2241
says to check before trusting a rung. `DRY_RUN`'s evidence is a journal row the
dry run writes by itself; `PROPOSE_ONLY`'s requires `openApprovedExternalWrite`,
which only runs after the full `requiredApprovals` count of DISTINCT humans has
signed. No weakening, so no finding.

### Why the top rung is legitimate now

| precondition | established by | verified at |
| --- | --- | --- |
| a pre-approved write can BOUND a value, not only fix it | #3051 design, #3122 impl | `ValueConstraint` + `refusalForConstraint` (save) / `refusalForValue` (dispatch) |
| the dispatch-time value check actually runs | #3122 | `external-tools.ts` runs `refusalForValue` per open field for EVERY rung before `dispatchWrite`; the arm re-runs it at send |
| the TARGET cannot be an arbitrary row | #3131 | `resolveTargetPopulation` over a code-defined registry, resolved AT DISPATCH because the bound is data |
| the rung is implemented end to end | #3147 | `dispatchWrite` has an `AUTOMATIC` branch; `external_write_rung_unimplemented` is now reachable only by a rung added ABOVE `AUTOMATIC` |
| the authority that writes the bounds is four-eyed | #3122 + `20261002130000_template_edit_needs_two_humans` | the promotion TRIGGER counts `DISTINCT "approverUserId"` excluding `pendingByUserId`, against the signed `pendingHash` |

`AUTOMATIC` cannot bypass the four-eyes gate: the arm refuses a call with no
parameter set in force, and a set's open fields can only have come into force
through that trigger.

## Files

| file | role |
| --- | --- |
| `src/lib/integrations/external-write-ladder.ts` | the constant, and a docblock rewritten to record what made the raise legitimate rather than deleting the history |
| `tests/guards/external-write-clamp-is-pinned.test.ts` | renamed from `…-is-propose-only.test.ts`; the tripwire, inverted positive control, population floor, discriminating pin at a lowered clamp, and an APPLIED-asserting mutation proof |
| `tests/unit/external-write-automatic-clamp.test.ts` | the one assertion that reads the REAL constant moved from "refuses" to "permits" |
| `tests/integration/external-write-policy.test.ts` | the ordering assertion now passes an explicit lowered clamp; `refusals.AUTOMATIC` now asserts the EVIDENCE sentence |
| `src/app-layer/usecases/external-write-policy.ts` | prose; the `isAboveClamp` branch marked unreachable-but-kept |
| `src/app/api/t/[tenantSlug]/admin/external-write-policy/[connectionId]/route.ts` | a comment that had claimed the ceiling was `DRY_RUN` through two raises |
| `tests/integration/external-write-automatic-arm.test.ts` | prose: the ceiling mock is now redundant and kept on purpose |

## Decisions

- **The guard's FILENAME moved with its literal.** A tripwire called
  `…-is-propose-only` asserting `'AUTOMATIC'` is a second copy of the pin that
  nothing checks, and the next reader trusts the wrong half.

- **The guard's positive control INVERTED rather than being deleted.** With the
  ceiling at the top rung, `LADDER.filter(r => isAboveClamp(r, EXTERNAL_MAX_MODE))`
  is empty, so "a rung above the ceiling is refused" became a claim about an
  empty set. The emptiness is now asserted, the ladder's exact contents are a
  population floor (a truncated one-rung `LADDER` would otherwise pass), and the
  comparison's teeth are pinned separately at `'PROPOSE_ONLY'` in both polarities
  so `isAboveClamp` is still known to discriminate. Same inversion
  `identity-write-ceiling-matches-the-pass` made when the joiner ceiling reached
  `AUTOMATIC`.

- **The mutation proof now asserts the edit APPLIED.** The old one replaced
  `'PROPOSE_ONLY'` with `'AUTOMATIC'` in the source text; after the raise that
  regex matches nothing, the `replace` is a no-op, and both assertions pass over
  the UNMUTATED declaration. An unapplied mutation is indistinguishable from a
  survived one, so the occurrence count is checked (`=== 1`) and throws by name
  before any result is read.

- **`automaticClampRefusal` stays and now returns null.** It is not dead code:
  it defends a stored row that outlives a LOWERED ceiling, which is the opposite
  case to this diff. `dispatchWrite` once read no ceiling at all, so a connection
  already at `AUTOMATIC` when the ceiling came down would have been sent.

- **The `isAboveClamp` arm of `getExternalWritePolicy`'s refusal map is now
  unreachable and kept.** Lowering the ceiling is one reviewed word away, and
  that sentence is what an operator reads during the incident that lowers it.

- **The clamp pin now defends BOTH directions.** A raise is no longer available.
  What the literal objects to is a LOWERING — a real and legitimate act that is
  also a mid-flight withdrawal of an authority tenants may hold — and a rung
  ADDED above `AUTOMATIC` while the ceiling stays put, which the top-rung
  assertion catches.

- **`docs/implementation-notes/2026-10-03-external-write-automatic-arm.md` was
  NOT edited**, per CLAUDE.md's read-only rule for that subtree. Its table still
  cites `tests/guards/external-write-clamp-is-propose-only.test.ts`, which this
  diff renamed to `external-write-clamp-is-pinned.test.ts`. The citation moved;
  the claim it makes about the file did not.
