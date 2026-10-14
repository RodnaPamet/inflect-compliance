# 2026-10-14 — a held-out set for the deterministic engine (#3516)

**Commit:** `<sha> test(identity): measure the engine on data it was not authored against`

## The gap

`identity-reconcile-precision.test.ts` gates the engine's precision and floors
its recall, and reads `CORPUS` for both. So the only set the engine was measured
on was the only set that existed. `tests/fixtures/identity-reconcile/` held
exactly two things: `corpus.ts` and `adjudication/` — and the held-out half that
does exist belongs to the **adjudication** path, which was retired the same day.

That is not "fitted" in the statistical sense — the rules are hand-written from
a design document, not searched against the data — but it is unvalidated on
unseen data, which cannot distinguish "the rules are right" from "the rules and
the fixtures were written by the same hand on the same afternoon".

## What this corrects about #3516 itself

The issue's surviving recommendation was *"widen the held-out set — 50 cases at
10 per class is thin"*. That set is `adjudication/held-out.ts`, used only by
`evaluation-record.ts`, the retired `eval-identity-match.ts` harness and the
injection corpus. Widening it would have strengthened **nothing live**. The live
precision claim is the deterministic engine's, and it had no held-out half at
all — a bigger gap than the one I named, found by reading which corpus the test
actually imports.

## Method, which is the only thing that makes the file worth having

Every `expected` was written from the question a reviewer answers — *who is this
person, and is the evidence strong enough that nobody need confirm it?* — and
**not** from running the engine. Expectations taken from the engine make the
fixture a transcript, green by construction: the exact circularity that removed
the committed evaluation record (#3462, thresholds chosen on the 19 cases their
own `precision = 1.0` was measured over).

So a disagreement is a finding to adjudicate, not to edit away.

## Results on first contact

```
cases                 15
auto-links made        4
false links            0    GATED
expected links hit   4/4    GATED
outcome agreement   13/15   REPORTED, not gated
```

**Two harness errors of mine, found by the output rather than by inspection.**
The first run reported nine `UNMATCHED (NO_CANDIDATES)` — because
`engineInputFor` supplies no `config.scorers`/`blockers`, so the Step 4a
similarity and family-name blocker were absent and there was nothing to score.
Production wires them at `legacy-reconcile.ts:287`; the precision test
deliberately does not, because Step 3b alone is its subject. The runner now
wires them, and the note in it says why. The second: my `bridge()` helper set
only `email`, but `buildBridgeIndex` keys on `samAccountName` and the UPN local
part — the bridge joins on a **login**, not an address, which is also what the
JML chain joins on.

**Three disagreements, adjudicated rather than edited.**

| case | engine | mine | resolution |
| --- | --- | --- | --- |
| `ho2-cy-02` (ё) | UNMATCHED | SUGGESTED | **I was wrong.** The corpus's `yo-03` is the identical shape and already expects UNMATCHED. Not folding ё is the deliberate rule and this row is its price. |
| `ho2-am-01` | UNMATCHED | AMBIGUOUS | kept — see below |
| `ho2-in-01` | UNMATCHED | AMBIGUOUS | kept — see below |

The last two reproduce a disagreement the corpus already carries at `in-01`:
for a two-way tie with **both candidates generated and both scoring 0 with no
signals**, the corpus expects `AMBIGUOUS` and the engine returns `UNMATCHED`.
Three fixtures now say one thing and the engine another, on a question the
corpus's own `why` does not settle ("the engine must refuse to pick" — both
answers refuse). Filed as **#3550**: the product difference is whether a
reviewer sees two candidate names or none.

## Decisions

- **Precision is gated; outcome agreement is reported.** Gating agreement would
  turn the first honest disagreement into a red build, and the quickest way back
  to green would be editing the expectation — which destroys the only property
  the file has. A false `LINKED` is gated, because that is the failure that
  reaches a customer.
- **A strong-signal floor is gated too.** Without it an engine that links
  nothing passes, which is `a-gate-narrow-enough-to-always-pass`.
- **No convention is declared, deliberately.** A convention is adopted per
  connection by a human (`assertCanAdmin`, versioned, audited); inferring one
  for a fixture is the circular fit `conventions.ts` forbids in its own header.
  So `CONVENTION` never fires and the four kinds that can produce `LINKED` are
  `CONFIRMED_ALIAS`, `EMPLOYEE_NUMBER`, `EMAIL_EXACT`, `DIRECTORY_BRIDGE`.
- **Three cases exist to make a STRONG kind refuse**: a name-with-counter read
  as an employee number (`kpatel3` → `3`, the documented trap, on unseen data), a
  folded email domain, and a stale directory bridge. Each has its own gated
  assertion, because "it did not link" is only meaningful if something was
  trying to.
