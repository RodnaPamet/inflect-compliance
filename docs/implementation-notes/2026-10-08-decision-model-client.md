# 2026-10-08 — The decision-model client and its evaluation harness (Step 6b)

**Commit:** `37c33b940 feat(ai): the decision-model client and its evaluation harness (Step 6b)`

## Design

One wire codec, three providers, one factory, and a record format that gates whether a
model revision may produce verdicts at all.

```
                    getDecisionProvider(effectiveMode)
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
     'OFF'                 'LOCAL_ONLY'              'EXTERNAL'
        │                        │                        │
        ▼                        ▼                   gate 2: TYPESAFE_
   StubDecision            LAYA_BASE_URL?            SUBPROCESSOR_ACTIVE
    Provider                  │      │                 (false today)
   (throws)              yes  │      │ no                    │
                              ▼      ▼               false ──┴── true
                        LayaDecision  Stub              │          │
                         Provider                       ▼          ▼
                                                  buildLocal   JevDecision
                                                               Provider
```

Everything below the `LOCAL_ONLY` arm is unreachable for a `LOCAL_ONLY` tenant **by
source position**, not by a conditional: the function returns, and
`tests/guards/ai-residency-enforcement.test.ts` reads the file to check that no
`new …DecisionProvider` that is external appears before the guard.

### Strength is a kind

The alternative — weight each signal, sum, link above a threshold — cannot hold a
precision gate. Enough weak evidence eventually crosses any line, the line has to move
every time a signal is added, and loosening it reads as tuning. So strength comes from a
frozen table keyed on a closed union:

| Strong (4) | Supporting (everything else) |
| --- | --- |
| `CONFIRMED_ALIAS`, `EMPLOYEE_NUMBER`, `EMAIL_EXACT`, `DIRECTORY_BRIDGE` | `EMAIL_UNTAGGED`, `STALE_DIRECTORY_LINK`, and the five Step 4a kinds |

A kind added without a classification is a compile error, not an `undefined` that
`=== 'STRONG'` quietly reports as false.

### What makes the external path inert

Two independent gates, and the second is the interesting one. A tenant can set
`legacyMatchAiMode = EXTERNAL` today; `TYPESAFE_SUBPROCESSOR_ACTIVE = false` is what
makes that setting do nothing. Step 6a registered TypeSafe as *proposed, inactive* and a
customer notice window has to close first — so the flag is the code half of a commitment
the register makes in prose. Activation is flipping a constant in a reviewed diff, not
setting an environment variable.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/identity-match/systemone-wire.ts` | Request builder, strict response schema, model pins, state budgets. The allowlisted `MatchState` type — which cannot carry the fields the sub-processor entry excludes. |
| `src/app-layer/ai/identity-match/transport.ts` | One POST, one retry, a caller-owned deadline. `Retry-After` parsing for both documented forms. |
| `src/app-layer/ai/identity-match/jev-provider.ts` | The external path. Host as a code constant; `TYPESAFE_SUBPROCESSOR_ACTIVE`. |
| `src/app-layer/ai/identity-match/laya-provider.ts` | The local path. Base URL from deployment config, key optional. |
| `src/app-layer/ai/identity-match/stub-provider.ts` | Answers nothing, ever. |
| `src/app-layer/ai/identity-match/index.ts` | The factory, with the two gates in source order. |
| `scripts/eval-identity-match.ts` | Runs the corpus through a provider, derives the thresholds, writes a record — or writes nothing and exits non-zero. |
| `tests/fixtures/identity-reconcile/adjudication/corpus.ts` | 19 residue-shaped cases across five classes, four of them hostile. |
| `tests/unit/identity-match-evaluation-records.test.ts` | The auditor. Recomputes every derived figure from the raw answers. |
| `eslint-rules/agentic-path.js` | The new directory added to the live globs, with the reason. |
| `docs/sub-processors.md` | Step 6a's "Codebase: none" corrected. |

## Decisions

- **`jev-1.13.0`, not `jev-1.13`.** The design table said the two-component form; the
  vendor's model list says the three-component one. The reference wins and the table is
  corrected. Worth more than a typo fix: with the sub-processor inactive, no tenant path
  reaches this provider, so the wrong string would have failed nothing until the day
  somebody activated it. A latent error with a release date, and the only thing that
  surfaced it was doing item 1 properly instead of trusting a table written a month ago.

- **Five vendor-table rows are left UNVERIFIED and named as such** — availability date,
  the `score` scale, latency, and the residency detail, plus Laya's English checkpoint.
  A third-party aggregator confirmed the availability date and the token budget, and I
  used it for the budget only because the vendor page confirms that independently. An
  aggregator agreeing with our table is not the reference agreeing with it, and the
  step's rule names the reference.

- **`z.partialRecord`, not `z.record`.** A `record` keyed on an enum is *exhaustive* in
  Zod 4, so the first version demanded probabilities for all six options and rejected
  every valid two-candidate response — caught by the test that asserts the valid payload
  parses, which is why that test exists. `partialRecord` still refuses an unknown key.

- **The deadline belongs to the caller.** Adjudication runs inline over every residue
  account, so the budget is the pass's, not the call's. A retry honouring `Retry-After`
  in isolation hands a third party control of our scheduling: the vendor may legitimately
  say 120 seconds. A back-off that does not fit the remaining budget means no retry.

- **A timeout is not retried.** The deadline exists because the pass has somewhere else
  to be, and the honest outcome of a slow model is no verdict — which leaves the account
  with a person, where it belongs.

- **The stub throws rather than answering neutrally.** A neutral verdict is still a
  verdict: it would be recorded as the model's opinion, and an evaluation record computed
  over stub answers would describe a model nobody ran.

- **Precision's denominator is the CONFIDENT answers.** Dividing by every answer would
  report high precision for a model unsure about everything — the direction that grants
  access. And `0/0` is scored as 0, not 1: "never commits" is not "never wrong" for a
  gate deciding whether a revision may act.

- **The threshold is searched, not fitted.** `agreeAt` is the lowest rung of a fixed
  ladder at which no confident answer is wrong, with a non-empty confident set. One
  degree of freedom, a three-line rule, and the test re-derives the precision at the
  chosen value from the same raw answers. If no rung works, the script writes nothing: a
  revision that cannot be made safe at any confidence gets no record and therefore no
  verdicts, rather than a record with a caveat.

- **Canaries are spread across classes, not the first N.** A revision that regressed on
  one shape would otherwise pass by being fine on the shape we happened to sample.

- **The corpus digest ignores key order.** Hashing `JSON.stringify` of the array would
  invalidate every record on a re-ordering that changed no case. The
  id/class/expected triple is what a record's numbers actually depend on.

- **`docs/sub-processors.md` is corrected rather than appended to.** Step 6a's entry
  said "**Codebase:** none. No module, constant or environment variable references
  TypeSafe in this revision." This step makes that false, and a doc that is false in a
  sub-processor register is worse than one that is vague. The replacement is a stronger
  claim backed by a test instead of by absence: the code is present and unreachable.

## What this step did not do

No evaluation records are committed. Producing one needs a live model — a TypeSafe
credential, or a Laya server — and this session had neither. That is the designed
default: no revision has a record, so no revision may produce a verdict, so adjudication
is off until an operator runs the harness. The step brief anticipated this and says to
ship items 2–9 without records, listing what remains; the pull request does.

Nothing imports this module outside its own tests. There is a client and no caller, the
same shape Step 3b left: an engine and no input. Both are deliberate — these are the
parts where a mistake grants access, so they were built against labelled corpora before
there was live data to get wrong — but neither should be read as "legacy adjudication
works".
