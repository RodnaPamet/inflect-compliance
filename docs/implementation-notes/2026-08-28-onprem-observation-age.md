# 2026-08-28 — an on-prem observation has to be RECENT, not merely present

**Commit:** `(this PR)` fix(jml): bound the age of the on-prem observation that authorises a disable

## Design

`#2144` gave the write-target rail the ability to tell apart the two meanings of
`onPremisesSyncEnabled === null` — *"the directory says this account is not
synced from on-premises"* versus *"nobody ever asked"* — by recording **when** a
sync got an answer. That unblocked the leaver path for cloud-only Entra tenants,
which was the whole point: it was permanently inert for every tenant without AD
Connect.

It also created a state nothing bounded. An observation is a claim about a
directory at an instant, and the rail treated a claim from any instant as
current. The rung every tenant is clamped at is `DRY_RUN`, whose snapshot writer
performs **no live read** — so the stored stamp is not merely the best evidence
the decision has, it is the *only* evidence. An account observed as cloud-only
months ago, since re-attached to on-prem sync, would be reported as writable.

This change makes the rail own the age.

```
        onPremStateObservedAt   (raw timestamp, from the candidate row)
                  │
                  ▼
        isObservationFresh(at, now)      fails closed on:
                  │                        absent · null · unparseable
                  │                        · older than the bound
                  │                        · further ahead than clock skew
                  ▼
   fresh ──► the #2144 behaviour, unchanged
   stale ──► OBSERVATION_STALE, its own basis and its own remedy
```

### Why `OBSERVATION_STALE` is its own basis

The first version folded it into `NEVER_OBSERVED`. That is a refusal whose
advice — *wait for the next sync* — is correct there and **useless here**, and
the difference is not cosmetic: the usual way a row goes stale is that its
**connection** was disabled. `removeIntegrationConnection` is a soft disable,
the dispatch skips disabled connections, and the deprovision reconcile is
connection-scoped — while a *surviving* connection's link reconcile is
provider-scoped and keeps those links looking fresh. So the rows freeze, the
links do not, and no amount of waiting clears it. An operator following
`NEVER_OBSERVED`'s advice would wait forever on a queue that only re-enabling
the connection can drain. The `OBSERVATION_STALE` text names that cause and says
plainly that waiting will not help.

### Why the bound applies to `false`, not only to `null`

The first version gated only the `null` branch — the one #2144 had opened —
which left `false` able to authorise a disable from an arbitrarily old
observation. `false` is what Graph documents for *previously synced, since
removed from sync scope*: the value **most** likely to have flipped back since.
Exempting it pointed the age bound away from the case it most needed to hold.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-write-target.ts` | `isObservationFresh` + the `OBSERVATION_STALE` branch; the input takes a timestamp instead of a boolean; owns the canonical freshness bound |
| `src/app-layer/usecases/identity-disable-account.ts` | passes the raw stamp through rather than collapsing it to a boolean first |
| `src/app-layer/usecases/identity-leaver-pass.ts` | `LINK_FRESHNESS_MS` becomes a real alias of the canonical bound |
| `tests/unit/identity-write-target.test.ts` | the age bound, both branches, the skew ceiling, and the unparseable stamp |

## Decisions

- **A timestamp on the input, not a boolean.** A boolean would put the age check
  in the *caller*, which is how two producers of the same rail end up disagreeing
  about whether an account may be disabled — one applies the bound, the next one
  written forgets. The rail is the only place that can hold it for everybody.

- **Two days, and only one constant for it.** The number matches the link
  freshness the candidate query already applies, because both ask the same
  question: did the daily sync refresh this row recently enough? They were two
  independent literals; `LINK_FRESHNESS_MS` now aliases `OBSERVATION_FRESHNESS_MS`.
  Left separate, the weaker one silently governs, and a later edit to either
  moves a bound its author was not thinking about. The comment claiming the alias
  was written before the alias existed — the review caught the prose, not the code.

- **Future stamps tolerated to one hour, refused beyond.** Small forward skew
  between the worker that synced and the pass that reads is ordinary, and
  refusing on it would make the rail inert for a reason having nothing to do with
  the directory. Unbounded, though, a forward-skewed clock freezes a row as
  permanently fresh — defeating the bound in exactly the failure mode it exists
  to catch.

- **The refusal formatter cannot throw.** `new Date('nonsense').toISOString()`
  raises `RangeError`. A rail that throws instead of returning a verdict turns
  one malformed row into an aborted candidate with an unhandled error — strictly
  worse than the refusal it was in the middle of computing. Found by the
  unparseable-input test, which is the argument for having written that case.

- **The bound makes the rail stricter than the live writer's own gate, and that
  asymmetry is deliberate.** `entra-id/writer.ts::disable` refuses unless
  `priorState.onPremStateObserved === true`, but it reads that from a directory
  read *taken just now* — its observation is seconds old by construction, so it
  can never be stale. The rail, sitting upstream, judges the STORED row. So in a
  future `AUTOMATIC` pass the rail will refuse rows the live read would have
  re-observed a moment later.

  That is the safe direction and worth keeping. #2144's first review killed the
  opposite asymmetry — a dry run promising "would disable" for accounts the live
  path refuses — because the observation window exists to let an operator compare
  the two, and a dry run that over-promises poisons it. A dry run that
  *under*-promises costs a day's latency on a leaver whose row refreshes at 03:00.
  Anyone raising `LEAVER_MAX_MODE` should know the tradeoff was priced this way
  round on purpose.

- **The snapshot's `onPremStateObserved` boolean was deliberately left alone.**
  It now applies a weaker predicate than the rail — "observed at all" rather than
  "observed and fresh" — so a stale row is captured as `true` beside a refusal
  citing staleness. Changing it would bump the `priorState` schema version and
  churn six tests to fix a cosmetic disagreement in a record whose job is to say
  what the directory reported at capture time, which "it was observed" truthfully
  does. It is not a second input to the verdict: the rail decides before the
  writer is reached, so the weaker downstream gate cannot pass anything the rail
  refused.

- **Both new behaviours are mutation-proved.** Exempting the `false` branch from
  the bound, and removing the skew ceiling, each turn exactly one test red. The
  guard here is a value comparison rather than a shape, so a passing suite is
  only evidence if the failing version fails.
