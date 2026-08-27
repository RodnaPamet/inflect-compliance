# 2026-08-27 — a leaver decision says which rule produced it

**Commit:** `<pending> feat(identity): give a leaver decision its basis, not just its verdict`

Closes the follow-up filed from #2144: *"a decision cannot say which rule allowed
it — information the seven-day window's reader wants."*

## The problem, stated precisely

A DRY_RUN leaver decision record was `{ linkId, outcome, reason? }`, and a
DRY_RUN row's `reason` is one **fixed string** — `"Dry-run mode: the disable was
decided but not performed."` — identical on every row. So the report an operator
reads for seven days, before deciding whether to grant this product unattended
authority over their directory, could show a screen of rows that differed in
nothing but a link id.

Two questions it therefore could not answer, both created or sharpened by #2144:

1. **Which decisions rest on the widened rule?** #2144 moved a whole population
   from `REFUSED_TARGET` to would-disable, by teaching the rail that an *observed*
   `onPremisesSyncEnabled: null` from Entra means cloud-only rather than unknown.
   In the report that population is indistinguishable from accounts that were
   already writable on an observed `false`.

2. **Is this account unobservable, or merely not re-synced yet?** #2144
   deliberately did not backfill, so for one sync cycle every pre-existing row
   refuses for want of an observation. That refusal shares one sentence — *"Run a
   successful directory sync first, then retry"* — with okta and google-workspace
   accounts, which report no on-premises flag **at all**. The operator's response
   differs completely: wait vs there is nothing to wait for. Worse, the advice is
   one nobody can carry out for okta: no sync will ever record a flag the
   directory does not have.

## Design

The basis is carried on the decision, from facts already in hand. **No new query
and no new lookup** — `findLeaverCandidates` already selects the two columns the
rail reads, and `resolveWriteTarget` already computes the verdict.

```
resolveWriteTarget → { allowed, basis }                        ← WHICH rule
        │
decideAndDisable                                               ← ONE merge point
        ├─ pre-target refusals (self-lockout / protected / mode) → no basis
        └─ decideWithTarget(...)  ─ spread ─►  { ...result, basis }
                                                     │
recordPassExecution → resultJson.decisions[].basis   │         ← unscrubbed
                                                     │
LeaverPassesClient → the "Basis" column ─────────────┘         ← "cloud-only · observed <when>"
```

`WriteTargetBasis` splits the one "never observed" refusal into two, on the same
`NULL_MEANS_NOT_SYNCED` set the allow already consults — so the split costs
nothing and cannot drift from the rule it describes:

| basis | verdict | operator's next action |
| --- | --- | --- |
| `ON_PREM_DIRECTORY` | allow | — (AD masters its own accounts) |
| `NOT_ON_PREM_SYNCED` | allow | — (observed `false`) |
| `CLOUD_ONLY_OBSERVED` | allow | **the rule #2144 widened** |
| `ON_PREM_MASTERED` | refuse | disable it in AD; wire the LDAPS connector |
| `NEVER_OBSERVED` | refuse | **wait** — clears at the next sync |
| `PROVIDER_CANNOT_OBSERVE` | refuse | **nothing to wait for** — permanent |
| `UNSUPPORTED_DIRECTORY` | refuse | not a directory this platform writes to |

`PROVIDER_CANNOT_OBSERVE` also gets its own refusal *sentence*, so a consumer
that never reads the structured basis — the leaver notification, an operator
reading `IntegrationExecution.resultJson` by hand — still gets the truth rather
than an instruction it cannot follow.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-write-target.ts` | `WriteTargetBasis` on both arms of the verdict; the never-observed refusal split in two, with a followable message for each |
| `src/app-layer/usecases/identity-disable-account.ts` | `DecisionBasis` + `DisableResult.basis`; `DisableAccountInput` carries `onPremStateObservedAt` (the timestamp) instead of a pre-collapsed boolean; tail extracted to `decideWithTarget` so the basis has one merge point |
| `src/app-layer/usecases/identity-leaver-pass.ts` | the basis rides into `resultJson.decisions[]`, deliberately unscrubbed |
| `src/lib/observability/integration-metrics.ts` | the `REFUSED_TARGET` on-call prose now describes three meanings, not two |
| `src/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/LeaverPassesClient.tsx` | the "Basis" column — quiet text beside the loud outcome badge, degrading to `—` for pre-basis rows |
| `messages/{en,bg}.json` | nine `admin.leaverPasses.basis*` keys |

## Decisions

- **The timestamp travels; the boolean is derived at the rail.** `DisableAccountInput`
  used to carry `onPremStateObserved: boolean`, collapsed at the DB seam by
  `Boolean(onPremStateObservedAt)`. That threw away the *when*, which is precisely
  what turns "would disable" into a claim an operator can weigh. The obvious fix —
  add the timestamp *beside* the boolean — is two representations of one fact that
  a later edit can set independently, which is the shape #2144's own review had to
  unpick (`onPremSyncObserved` vs `onPremStateObserved`, one concept, two names).
  So the input carries **only** the timestamp and `decideAndDisable` derives the
  boolean at the single `resolveWriteTarget` call.

  The fail-closed `Boolean(...)` guard moved with it, and is now adjacent to the
  rail it protects rather than a module away. `!= null` would read `undefined` — an
  unselected column, an older row shape — as OBSERVED, failing **open** on a rail
  whose whole job is to fail closed; a unit test pins the closed direction, and the
  integration seam test now asserts the timestamp *value* crossing the DB, not just
  its truthiness.

- **One merge point, not eight.** Eight returns live after the write-target
  verdict. Spreading `basis` into each is a rule held by memory, and a ninth return
  added later would silently omit it. The tail is extracted into `decideWithTarget`
  and the basis merged once over its result, so the obligation is discharged by the
  call graph. `target` is **passed in** rather than recomputed: `resolveWriteTarget`
  is pure and cheap, so a second call would be correct — and would still be a second
  evaluation of a safety rail, which this subsystem refuses everywhere else.

- **Pre-target refusals carry no basis, on purpose.** Self-lockout, protected and
  mode are decided before the rail runs. `basis` is optional rather than
  always-present because stamping one on those rows would describe a rule that
  never ran.

- **The basis is persisted unscrubbed, and that is a property to keep.**
  `IntegrationExecution.resultJson` is not encrypted at rest (the Epic B manifest
  is String-only) and outlives the pass, so every free-text `reason` is stripped of
  directory identifiers on the way in. A basis is an enum, a tri-state boolean and
  an ISO timestamp — it can name no account. A unit test drives a decision with a
  GUID-shaped `externalUserId` and a real email and asserts neither appears in the
  serialised basis, so the exemption stays earned rather than assumed.

- **`DecisionBasis` is a `type`, not an `interface`, and that is load-bearing.**
  It is written straight into `IntegrationExecution.resultJson`, whose Prisma
  parameter is `InputJsonValue` — an assignability check that needs an index
  signature. TypeScript synthesises one for an object *type alias* and refuses to
  for an *interface*, because an interface stays open to declaration merging and
  so cannot be proven to hold only JSON. It was written as an interface first;
  every unit test passed (Jest does not typecheck) and `tsc` rejected exactly one
  line — the `db.integrationExecution.create`. Same family as the known trap
  where a Json column accepts an object literal and rejects the identical value
  once a helper widens it.

- **The verdict is not relabelled, and the basis does not compete with it.** The
  decisions table still renders the raw `DisableOutcome` (`DRY_RUN`,
  `REFUSED_TARGET`). The basis is a new column beside it rather than a rewrite of
  the outcome or of the pass's own authored sentence — the page keeps rendering
  what the pass said and adds what it knew. It renders as quiet TEXT, not a second
  `<StatusBadge>`: the outcome is the row's one loud signal, and a pill beside a
  pill reads as two competing alarms with neither winning. The labels carry the
  whole distinction anyway — "awaiting the next sync" and "reports no on-premises
  state" are not two shades of one word. `tests/guards/badge-density.test.ts`
  caught the first draft, which used a badge and pushed the file from 4 to 5.

- **Not display-only.** Worth stating because it was the first hypothesis: the UI
  *does* already render `reason` verbatim, so if the reason had varied per rule this
  would have been a one-line page change. It does not — a DRY_RUN reason is a
  constant — so the missing information was never in the record to display.

## What this does NOT do

- It does not check the *age* of the observation. A stamp from six months ago reads
  identically to one from last night at the rail; the report now shows the date, so
  a reader can judge it, but nothing refuses on staleness. That is the sibling
  follow-up filed from #2144 and is still open.
- It does not backfill. Rows written before this change carry no basis and render
  as `—`, which is honest: no write-target determination was recorded for them.
