# 2026-09-06 — retire the load-dependent wall-clock budgets

**Branch:** `fix/fu-2350` (issue #2350)

Follow-up to #2349 (`tests/unit/framework-tree-builder.test.ts`) and to the
2026-08 change in `tests/unit/password-check.test.ts:183-197`. Those two fixed
one site each.

## Scope — what was closed, and what was not

The first draft of this work claimed "the last three sites" and a retired class.
Review found a fourth (`tests/pdf/generators.test.ts`, a 30 s ceiling over a
1000-row render) still standing, so the claim was false when written. It is
fixed here, and the scope is now stated as something a reader can check rather
than as a slogan.

**The defect being retired** is narrower than "an assertion about time". It is a
ceiling whose margin is sized by *runner contention* rather than by its subject.
That makes the margin spendable by load, so the ceiling answers a question about
the runner while claiming to answer one about the code — and the answer to a
regression the ceiling names then lands *inside* that margin, where it becomes a
coin flip or a miss. The four sites, with the regression each names mutated in
and re-measured on one 8-core box under `--runInBand`:

| Site | Healthy | Ceiling | Verdict on the regression it names |
|---|---|---|---|
| `encryption-middleware.perf` | list+includes 15.0-22.1 ms | 200 ms | a 10x hot-path decrypt: 84-91 ms idle (passes, 3/3), 168-208 ms under six competing busy loops (fails 1 of 4) |
| `combobox-virtualize` | 284-329 ms | 2000 ms | all 1000 options rendered: eight samples of 1318-2397 ms, four over the ceiling and four under |
| `pdf/generators` | 1126-1357 ms | 30_000 ms | a doubled measuring pass: 1428 ms — inside the healthy band, 21x under the ceiling, never fires |
| `shutdown-helpers` | ~0 ms (an early return) | 50 ms x4, 200 ms x1 | none to measure: two of the five asserted nothing else at all, and on a never-initialised module both calls take the same early return |

The first two rows are the sharper finding, and they are what the first draft
missed. It is not that those ceilings never fire — it is that whether they fire
is decided by what else the runner was doing. A gate that returns a coin flip is worse than
no gate, because the cheapest response to it is to re-run.

**Enumeration.** Every `expect(<a Date.now()/performance.now() difference>)` in
`tests/` was listed and triaged, not just the ones already known — including
`tests/stress/`, which an earlier draft of this note waved past. Six assertions
survive, deliberately:

| Survivor | Why it is not this defect |
|---|---|
| `passwords.test.ts:104` — `elapsed > 10` on `dummyVerify` | A **floor**. Contention can only make a floor more true, so it cannot be spent by load; it asserts bcrypt actually ran rather than being short-circuited. |
| `auth-brute-force.test.ts:141` — `elapsed >= 4_900` | Same: a floor, and the 5 s delay *is* the feature under test. |
| `auth-brute-force.test.ts:121` — `elapsed < 1500` | Discriminates 0 ms from the 5 s tier with the line at 1.5 s. Real detection power (a tier applied one attempt too early moves it to 5 s), unlike the four above. |
| `readyz.test.ts:249` — `elapsed < 5000` | Bounds the route's own declared 2 s `Promise.race`. Raising that timeout moves elapsed past the line, so it can fire. |
| `audit-gate-registry-unavailable.test.ts:121` — `elapsedMs < 30_000` | The stub sleeps 600 s. Removing the per-attempt bound — the regression it names — moves elapsed 20x past the line. |
| `stress/integration-http-hardening.stress.test.ts:166` — `elapsedMs < 4_000` | Sized by the subject, not the runner: `DEADLINE_MS` is 1 s and `MAX_HTTP_ATTEMPTS` is 3, so the ~3 s it measures is three timer expiries, not CPU. It fires when the deadline stops firing at all. |

The one I would still look at is `auth-brute-force.test.ts:142` (`elapsed <
7_000` over a real 5 s sleep — a 40% margin, thin enough to flake). It is left
because the subject genuinely sleeps, so the assertion measures the feature
rather than a budget, and narrowing it needs the delay injectable — a change to
production code that is out of scope here.

The stress row is the second one worth a look, and the earlier draft of this
note got its reason wrong twice over: it excluded `tests/stress/` "by
construction", as a suite that "reports rather than gates and says so in its own
README". It gates — `.github/workflows/integration-stress.yml` says "No
continue-on-error. This is the gate." — and the README's own "recorded and
uploaded, never asserted" carries an exception two lines later, which is this
assertion. So it belongs in the table above and is triaged there on its merits,
not excluded. What is thin about it: ~3 s of it is timer waiting, leaving ~1 s
of slack for scheduling that shared GitHub runner across three expiries, against
a 3075 ms figure measured on a dev box. That slack is not sized by contention —
which is why it is not the defect this note retires — but it is the narrowest
margin of the six, and it is the only one of them in a blocking suite.

Out of scope by construction: a jest `testTimeout` — a liveness guard on every
async test, not a claim about speed. The three other `tests/stress/` files
compute elapsed times and hand them to `recordTrend()`, which prints rather than
asserts, so they carry no `expect` over a clock.

## Design

A wall-clock budget on a shared runner fails in both directions, and the second
is the one that gets missed:

- **False positive** — the budget is spent by load, not by the code. This is
  recorded in the repo's own history rather than inferred: commit `2f4cfc41d`
  raised every ceiling in the encryption file's `T` table (list+includes
  120→200 ms among them) because contention tripped them on a *healthy* build,
  and `8ab09ce54` moved its overhead ratio 200%→5000% for the same reason.
- **False negative** — the slack that absorbs the noise also absorbs the
  regression; they are the same milliseconds. A margin wide enough to survive a
  contended runner is wider than most real regressions. The PDF site is the
  cleanest example: doubling the measuring pass moved a 1126-1357 ms render to
  1428 ms, still 21x under its 30 s ceiling.

The remedy, in the order it should be reached for:

1. **Assert the outcome the timing was groping for.** `password-check` is the
   worked example: an abort was inferred from `elapsed < 400`; asserting
   `skipped`/`reason === 'timeout'` states it directly.
2. **Count work, not milliseconds.** `framework-tree-builder` tallies property
   reads through a Proxy; `encryption-middleware.perf` counts calls into the
   crypto module; `shutdown-helpers` counts pending fake timers.
3. **Delete**, when the assertion has no demonstrated detection power and no
   work-shaped replacement.

Every site here was triaged by mutating its own subject and re-running, rather
than by reading the constant. The measurements are written into each test
file's header so the next person does not have to redo them.

## Files

| File | Role |
|---|---|
| `tests/unit/observability/shutdown-helpers.test.ts` | Five ceilings (4x `<50`, 1x `<200`) over two early-return paths → two fake-timer tests asserting the call settles on the microtask queue and arms no timer |
| `tests/unit/encryption-middleware.perf.test.ts` | Seven latency ceilings + one wall-clock ratio → eight manifest-derived crypto-call counts |
| `tests/rendered/combobox-virtualize.test.tsx` | `expect(elapsed).toBeLessThan(2_000)` deleted; the sibling DOM-count assertion in the same test read 1000 against `<=30` on all eight mutated samples, i.e. was already the sole detector |
| `tests/pdf/generators.test.ts` | `PERF_CEILING_MS = 30_000` over a 1000-row render → a count of `doc.heightOfString` calls (`(rows + totals) x columns`), which is what `renderTable`'s own "avoids re-measuring" comment claims |
| `src/lib/security/encrypted-fields.ts` | Header table said "pinned by perf test" with thresholds that no longer exist and observed figures that had rotted; now a dated record, not a gate |
| `docs/epic-b-encryption.md`, `docs/list-virtualization.md`, `docs/epic-e-observability.md`, `CLAUDE.md` | Four prose claims about budgets that no longer exist. `epic-e-observability.md` and the `list-virtualization.md` foundation table were missed on the first pass and caught in review — both are classified `authoritative`, so a stale credit there is a claim the ratchet will not catch |

## Decisions

- **The BASELINE `encryptField` / `decryptField` µs ceilings were deleted, not
  reshaped.** They measure the crypto primitive, not the middleware the file is
  about. The invariant they gesture at is the key-derivation cache, which is
  module-private (`getEncryptionKey` is not exported) and belongs to
  `tests/unit/encryption.test.ts`.
- **`WALK skips nodes with no manifest fields in ~constant time` lost its
  timing assertion and kept its scenario.** Deleting the
  `nodeHasAnyEncryptedFieldKey` fast path it names measured *inside the healthy
  noise band* (walk 0.91-1.04 ms against a healthy 0.80-1.45 ms), so the
  assertion named a fast path whose removal it could not see. The saving is a
  `Set.has` per node, which is not observable from outside the module. The
  scenario survives as a correctness assertion instead: zero crypto calls, and
  the tree comes back byte-identical.
- **Counts are exact for crypto, bounded for traversal.**
  `decryptField` is asserted with `toBe` (one per encrypted field is a semantic
  fact fixed by the manifest); `isEncryptedValue` with
  `toBeLessThanOrEqual`, so an inlined-prefix refactor that makes *fewer* calls
  stays green while a double traversal — which decrypts nothing extra, because
  the value is already plaintext on the second visit — fails.
- **Expected counts are derived from `getEncryptedFields(...)`, not typed as
  literals**, and a premise test asserts the field counts those expectations
  assume. Adding a field to `Task` should move the numbers because the manifest
  moved, not because somebody adjusted a constant.
- **This is a trade, not a free win, and the test headers say so.** Call counts
  see *redundant* work, not *slower* work: a Set→array-scan degradation, a
  deleted fast path and an O(n²) auxiliary structure all make the same number
  of crypto calls, so no count can move. On an idle 8-core box the old ceilings
  missed all three too (measured, in the header) — but detection power is a
  function of the runner, and that is the half the first draft got wrong. Healthy
  `list+includes` measured 26.7 ms under six competing busy loops and 45.2 ms
  under sixteen, putting the 200 ms ceiling 7.5x and 4.4x above healthy instead
  of the idle 13x; a slower-per-call regression of about that size would have
  crossed it on a runner like that and now will not. What is bought is a verdict
  that is the same integer on every machine and cannot false-positive. Buying the
  lost half back honestly means instrumenting production code, which pins the
  mechanism and fails legitimate refactors (CLAUDE.md, "Epic-ratchet lifecycle").
- **The 10x-decrypt mutation does not have a single answer, and that is the
  finding.** The first draft recorded "all eight assertions passed" as though it
  were a property of the code. Re-measured: idle, `list+includes` 84.0-90.7 ms
  and all eight pass; with six busy loops on the same 8 cores, 168.4 / 193.9 /
  196.9 / 207.7 ms — one run in four fails the 200 ms ceiling, and an
  independent 8-core measurement read 264.3 ms and failed. The ceiling's verdict
  on the file's own stated target regression is decided by the runner. That is a
  stronger argument for removing it than "it never fires", and it is the true
  one.
- **`tests/unit/encryption-middleware.perf.test.ts` keeps its filename.** It is
  referenced from `docs/epic-b-encryption.md`, `tests/stress/README.md`,
  `src/lib/security/encrypted-fields.ts` and three historical notes; renaming
  buys tidiness and costs a rename ripple through read-only records. It also no
  longer consumes `isParallelRun()` from `tests/helpers/db.ts` — with nothing
  timed, there is nothing for CPU contention to spoil, so the suite now runs in
  parallel shards too.
