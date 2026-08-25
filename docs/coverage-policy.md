# Test coverage policy

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md) — the developer onboarding guide.

This document is the coverage **policy** for a compliance SaaS — why
the bar is what it is, per layer, and how it ratchets up over time.
The enforced numbers live in `jest.thresholds.json`; this doc is the
reasoning behind them.

## Coverage is a risk control, not a vanity metric

Coverage percentage is only a proxy. What matters for a compliance
platform is whether the **decision logic** that enforces business
rules, permissions, and state transitions is actually exercised.

Two consequences shape this policy:

1. **Branch coverage outranks line coverage.** A usecase with eight
   `if`s can hit 100% *lines* from a single happy-path test that
   never takes a single `else`. The untested branch is the one that
   wrongly grants access, skips a validation, or mishandles an
   invalid state transition. For decision-heavy code, the branch
   number is the real signal — line coverage is the floor, not the
   goal.

2. **Layers carry different risk, so they carry different bars.**
   A bug in the business-logic layer is a compliance defect shipped
   to customers. A bug in a thin HTTP route handler is usually a
   400 vs 500. The policy is risk-tiered accordingly.

## Risk tiers

| Tier | Scope | Why | End-state target (branches / functions / lines) |
|------|-------|-----|--------------------------------------------------|
| **A — Highest assurance** | `src/app-layer/usecases/` | The business-logic layer **is the product** — business rules, approvals, workflow transitions, validations, enforcement. An untested branch here is a shipped compliance defect. | **70 / 70 / 80** |
| **A — Highest assurance** | `src/app-layer/policies/` | Authorization decisions (`assertCanRead/Write/Admin/Audit`). A wrong branch is a security hole. Branch-dense and small — a high bar is cheap to hold. | **75 / 75 / 80** |
| **B — High assurance** | `src/lib/` | Cross-cutting shared code — auth/session, crypto, rate-limit, parsing, config. A bug here ripples app-wide. | **65 / 65 / 75** |
| **B — High assurance** | `src/app-layer/events/` | The hash-chained audit trail — integrity-critical. | **65 / 65 / 75** |
| **C — Standard** | Global — the rest of `src/app-layer/` (repositories, jobs, services, integrations, ai, schemas, automation, notifications, domain, reports) | Backend plumbing under the usecase layer: query construction, job orchestration, provider adapters, DTO shapes. A defect is usually a broken query or a dead job rather than a wrong compliance decision — but it is server code that ships. | **79 / 81 / 87** |

`policies/` and `events/` got their dedicated threshold keys in
**the quality-coverage wave (P3)** — seeded a few points below measured
coverage so the existing assurance is locked while leaving margin for
single-test flake. The R3 plan (P4) originally reserved this slot; it was
filled by the quality-coverage wave (P3).

## What `global` measures

`global` is not "everything". `scripts/check-merged-coverage.ts`
reproduces Jest's own rule — a path-prefix key REMOVES its files from
`global` rather than layering a second check over them — so `global` is
exactly the declared scope minus the four path groups:

| Set | Files |
|-----|-------|
| `collectCoverageFrom` — `src/{app-layer,lib}/**/*.ts(x)`, minus `*.d.ts`, `types.ts` and co-located tests | 760 |
| − `./src/app-layer/usecases/` | 176 |
| − `./src/app-layer/policies/` | 16 |
| − `./src/app-layer/events/` | 6 |
| − `./src/lib/` | 296 |
| **= `global`** | **266** |

Those 266 are `src/app-layer/` outside the tier-A/B folders: jobs,
repositories, integrations, services, ai, schemas, automation,
notifications, domain, reports. Every one is zero-filled — a file no test
imports counts as 0%, so the number cannot be improved by leaving code
unimported.

Nothing under `src/app/**` or `src/components/**` is in the scope. React
pages and components carry their own assurance model
(`docs/frontend-assurance-model.md`) and their own population floor
(`RENDERED_TEST_FLOOR`), not a coverage percentage. A rendered test for a
page is worth writing on its own merits; it moves `global` by zero.

`.tsx` under `src/lib/` IS in scope — the context providers, the
keyboard-shortcut hook, the canvas context modules. The line is what the
file is, not what extension it carries: those are shared library code the
whole app depends on, and `./src/lib/` earned its floor partly on them.

## Current floors vs. targets

`jest.thresholds.json` holds the **current floor** — the highest
value CI can enforce today without failing. It is a ratchet: never
lowered, raised whenever a PR earns it.

| Scope | Branches now → target | Functions now → target | Lines now → target |
|-------|----------------------|------------------------|--------------------|
| `usecases/` | **79** → 70 ✅ | **81** → 70 ✅ | **88** → 80 ✅ |
| `policies/` | **86** → 75† | **95** → 75 | **93** → 80 |
| `events/` | **75** → 65† | **60** → 65 | **78** → 75 |
| `lib/` | **78** → 65† | **81** → 65 | **89** → 75 |
| global ‡ | **79** → 79 | **81** → 81 | **87** → 87 |

`usecases/` (Tier A) has met and passed its end-state target on all three
metrics — the floor (79/81/88) sits above the 70/70/80 target, held by
the ratchet.

‡ The `global` floor was re-derived on 2026-08-11, when the gate's scope
was corrected to the declared `collectCoverageFrom` universe. Figures
measured before that date were taken over a different population — the
~1001 files the suite's import graph happened to load, three quarters of
them React — and are not comparable to these. The wave log below is the
record of how the per-folder floors were earned, not a trajectory that
continues into this row.

†`policies/` and `events/` already SURPASS their tier targets on
branches — the tier target stays as written for parity with the
other dimensions; the ratchet enforces the higher measured floor.

`usecases/` branch coverage has since passed its end-state target —
Wave C measured **72.93%**, Wave D batch 1 lifted the floor to **79**,
and it is held there by the ratchet. From the original "sub-50%
branches" framing (the R3 P2 baseline) that is a climb of more than 20
percentage points across stages 3a-3h and Waves C-D.

The wave log below records every percentage against the pre-2026-08-11
`global` population. Those numbers are how each floor was earned; they
are not comparable to the current `global` row.

## The staged ratchet plan

One giant threshold jump is not adoptable — it would block every PR
until a massive test backlog clears. Coverage rises in deliberate
stages, each a PR that adds real tests and then lifts the floor in
the same diff so the gain is locked.

`usecases/` branch coverage — the priority metric:

| Stage | Branch floor | Status | How |
|-------|-------------|--------|-----|
| 0 | 37 | ✅ done | starting point |
| 1 | ≈50 | ✅ done — R3 P2 (#623 floor 37→42) + accumulated drift | |
| 2 | **55** | ✅ done — quality-coverage wave P1/P2 (lock the gain; measured ≈58) | |
| 3a | **56** | ✅ done — auth-followups quality wave: 3 previously-untested usecase files (`evidence-maintenance`, `control/templates`, `audit-readiness/sharing`) got 51 branch-focused tests across ~50 decision paths. Floor bumped +1 across all 4 metrics in the same diff. | |
| 3b | **58** | ✅ done — stage-3b wave: 41 branch-focused tests on `audit-readiness/packs.ts` (443 lines, previously untested) covering ~30 decision branches across 8 exported functions + 4 snapshot helpers + 2 default-pack pickers. File-level coverage **92/85/89/95**. Floor bumped +2 across all 4 metrics in the same diff. | |
| 3c | **60** | ✅ done — stage-3c wave: `framework/install.ts` already had a 15-test wave-4 unit test, but it covered only **35.48%** of branches (5 of 7 functions, with gaps). Extended to 39 tests covering `computeCoverage` + `listTemplates` (previously untested) + the missing branches across the prior 5 functions. File-level jumped **45/35/47/44 → 97/95/93/97** — a 60-point branches lift on 544 lines. Floor bumped +2 across all 4 metrics. | |
| 3d | **62** | ✅ done — stage-3d wave: 30 branch-focused tests on `org-invites.ts` (512 lines, **completely untested before this PR**). Compliance-critical: this is 1 of the 3 paths that can write an `OrgMembership` row. Branches covered: token issuance + role/email validation + already-member reject + revoke + listPending + 6 preview outcome branches + atomic-claim race / mismatch / expired / revoked / accepted + Step-3 email-mismatch (forbidden, token already burnt) + Step-4 invariant + ORG_ADMIN vs ORG_READER provisioning branch + safeOrgAudit best-effort swallow. File-level coverage **0/0/0/0 → 100/89/100/100**. Original +3 bump (target 63) overshot by 0.5 — full-suite measured branches at 62.5%; backed off to +2 (target 62) in a fixup. Lift to 64-65 carries into stage 3e. | |
| 3e | **62 / 57 / 73 / 70** | ✅ done — stage-3e wave: 22 branch-focused tests on `webhook-processor.ts` (485 lines, previously untested). Security-critical: replay-defense + cross-tenant resolution (tenant from `IntegrationConnection`, never from caller) + signature verification (github/gitlab/generic-hmac/no-secret-allow branches) + provider-impl fan-out + best-effort orchestrator dispatch + sanitizeHeaders PII redaction. File-level **0/0/0/0 → 98/86/86/99**. CI's full-suite measured branches at **62.98%** (only +0.5 over stage-3d's 62.5% — the new file adds ~25-35 of the ~4962 tree branches). +2 → 64 missed by ~1; backed off to **branches stays at 62**, others +1 (functions 57, lines 73, statements 70). The test file is durable; the floor reflects measured. | |
| 3f | **63 / 58 / 74 / 71** | ✅ done — stage-3f wave: 49 tests across TWO files in one PR. `framework/coverage.ts` (313 lines, **previously had duplicate exports tested under framework/install but not the unique `exportCoverageData` / `generateReadinessReport` / `exportReadinessReport`**): file-level **98/78/95/98**. `control/queries.ts` (337 lines, **completely untested**): file-level **100/95/100/100** — dashboard aggregator + consistency-check RBAC + 3 not-found paths + topOwners fold. Floor bumped +1 across all (conservative after stages 3d/3e showed broader-tree dilution). | |
| 3g | **64 / 59 / 75 / 72** | ✅ done — stage-3g wave: 40 tests across 3 files. `soft-delete-lifecycle.ts` (143 lines) at **100/100/100/100** — perfect file-level coverage on restore + purge + list with all model/delegate/not-found guards. `vendor-assessment-reminder.ts` (129 lines) at **100/96/100/100** — all 5 reject paths (not-found / status / no-email / expired token / missing relations) plus dedup behavior. `org-dashboard-widgets.ts` (225 lines) at **100/96/100/100** — cross-org-id leak defence locked across update + delete; partial-update branch coverage on title / position / size / enabled / chartType+config revalidation. Floor +1 across all (consistent with stage 3f's broader-tree-dilution pattern). | |
| 3h | **66 / 62 / 77 / 74** | ✅ done — stage-3h wave: 54 tests across 5 files in one PR. `control/page-data.ts` (originally on the candidate list) was dropped as already-covered (100/94/100/100); `soft-delete-operations.ts` replaced it. `test-readiness.ts` (105 lines) at **100/75/100/100**. `soft-delete-operations.ts` (117 lines) at **100/100/100/100** — generic restore + purge for every soft-deletable entity. `org-tenants.ts` (149 lines) at **100/100/100/100** — `createTenantUnderOrg` with tx + best-effort provisioning + P2002 → ConflictError translation. `framework/fixtures.ts` (196 lines) at **100/95/100/100** — `upsertRequirements` + `computeRequirementsDiff`. `org-dashboard-presets.ts` seeder (218 lines) at **100/80/100/100** — the existing preset-shape test covered only 25/0/0/25; extended with 8 tests for `seedDefaultOrgDashboard` idempotency + payload mapping. CI full-suite measured usecases/: branches **67.78%**, fn 65.55%, lines 77.99%, stmts 76.32%. Conservative bump matched measured headroom: branches +2, functions +3, lines +2, statements +2. Leaves ~1-2pp slack. | |
| 4 (target) | **70** | ✅ REACHED — Wave C | end state; held by the ratchet. Wave C (below) carried four previously-0% usecase files and the authoritative gate (run WITH the integration DB) measured usecases/ branches at **72.93%** — past the 70 end-state. Floor raised to **72/76/85/83**. |
| Wave C | **usecases 72 / 76 / 85 / 83** (gate actual 72.93 / 77.35 / 86.03 / 84.43) | ✅ done — Wave C (2026-06-24): branch tests for four previously-0% usecase files — `onboarding-automation` (the prior test re-implemented the logic as a LOCAL COPY and covered the real module 0%; replaced with one that imports the real exports → 96% branches), `vendor-audit` (evidence-bundle frozen-guards + freeze snapshot loop + self-subprocessor reject → 97%), `framework/catalog` (version-vs-key resolution + not-found arms → 100%), `framework/tree` (`getFrameworkTree` + the four `reorderFrameworkRequirements` validation branches → 95%). usecases/ floor raised to 72/76/85/83 (≤ gate actual, ~1pp slack); RATCHET_FLOOR hardened to the pre-wave-C enforced level 69/73/81/80. **GLOBAL branches stayed 62.54% — the ≥65 global goal is NOT met by this batch and remains deferred** (the global is dominated by never-loaded `.ts` files in `src/app-layer` + `src/lib` — repositories, `reports/pdf`, `lib/hooks`, schemas — not by usecase gains). See `2026-06-24-coverage-wave-c.md`. |
| Wave D batch 1 | **global 63 / 62 / 77 / 76**; **usecases 79 / 81 / 88 / 87** (gate actual: global branches 63.88, usecases branches 79.97) | ✅ done — Wave D batch 1 (2026-06-24): branch tests for eight node-testable backend files — `soa` (100%), `automation-runner` (100%), `risk-scenario` (100%), `scim-users` (98.9%), `policy-lifecycle-adapter` (98.8%), `risk-report` (96.6%), `risk-appetite` (95.2%), `audit-readiness-scoring` (94.2%). Moved **global branches 62.54 → 63.88** (+1.34pp) and usecases branches 72.93 → 79.97. Two data points recalibrated the true gate denominator to ≈**38,800 branches** (the earlier ~22.7k estimate was derived from the loaded-only count). Reaching ≥65 needs ~**+435 more covered branches** → batch 2 (repositories). global + usecases floors raised to gate-actual-minus-~1pp; RATCHET_FLOOR hardened to the pre-batch enforced level. See `2026-06-24-coverage-wave-d-batch1.md`. |
| Wave D batch 2 | **global 65 / 64 / 78 / 77** (gate actual: global branches **65.94**) | ✅ done — **≥65 GLOBAL BRANCH TARGET MET.** Wave D batch 2 (2026-06-24): mock-`db` unit tests for nine repositories — `WorkItemRepository` (100%), `AccessReviewRepository` (100%), `AuditRepository`/`TestPlanRepository`/`TestEvidenceRepository`/`AssessmentRepository` (100%), `ProcessMapRepository` (99.3%), `ControlRepository` (99.0%), `VendorRepository` (98.6%) — covering ~470 previously-uncovered branches. Moved **global branches 63.88 → 65.94** (+2.06pp), clearing the long-standing ≥65 goal that was deferred since Wave B. global floor raised to 65/64/78/77; RATCHET_FLOOR hardened to the batch-1 enforced level. See `2026-06-24-coverage-wave-d-batch2.md`. |
| Wave D batch 3 | (no floor change — gains <1pp) global branches **66.25** | ✅ done — Wave D batch 3 (2026-06-25): unit tests for 5 PDF report generators (`policyDocument` 97.3%, `processMap`/`auditReadiness`/`riskRegister`/`gapAnalysis` 100% — real PDFKit rendered to Buffer) + 3 zod schemas (`process-map`/`vendor-form`/`asset-form`, 100%). `lib/dto/soa.ts` skipped (pure type declarations). Moved global branches 65.94 → 66.25 / functions 64.53 → 64.71 / lines 79.12 → 79.34 / stmts 77.70 → 77.93 — purely additive: widens the cushion above the 65 floor and covers 8 previously-0% files. Floors NOT raised (each gain <1pp; raising would eat the jitter buffer). See `2026-06-25-coverage-wave-d-batch3.md`. |
| Wave D batch 4 | **lib/ 78 / 81 / 89 / 88** (functions/lines/stmts +1/+1/+2); global unchanged | ✅ done — Wave D batch 4 (2026-06-25): tests for 8 `lib/processes` + `lib/hooks` files — pure-TS canvas logic via node (`canvas-clipboard` 92.9%, `canvas-drill-filter`/`edge-controls` 100%) + React hooks via jsdom `renderHook` (`use-canvas-history`/`use-canvas-drill-stack`/`canvas-change-events` 100%, `use-canvas-autosave` 94.1%, `useUrlFilters` 62.5% — SSR/hydration guards unreachable under jsdom, documented). Raised `lib/` cohort functions 80→81 / lines 88→89 / stmts 86→88 (branches stays 78; 79.10 actual too thin to bump). Global held at 66.25 (batch-4 files are small; gain rounds under the global denom). Also bumped the rendered-test population ratchet `RENDERED_TEST_FLOOR` 182→194 (5 new `tests/rendered/` files). See `2026-06-25-coverage-wave-d-batch4.md`. |
| Wave B (batch 1) | global 62.13 (branches) | ⚠️ CORRECTED — coverage Wave B batch 1: real branch-exercising tests for 11 previously-zero-coverage files across 4 jobs (`data-lifecycle`, `tenant-dek-rotation`, `retention-notifications`, `retention`), 4 repositories (`SsoConfig`, `Onboarding`, `File`, `Framework`), 2 hash-chained audit writers (`audit-writer`, `org-audit-writer`), and `mailer`. **The original entry cited `coverage-summary.json`'s `total` (B 69.28 / F 72.95 / L 81.90 / S 80.59) as the global — those are LOADED-files-only numbers, NOT the enforcement universe.** The authoritative enforcement-universe global at the end of batch 1 was **branches 62.13** (the gate counts every `collectCoverageFrom` file, including the thousands of never-loaded branches as 0%). See the loaded-vs-enforcement table below. |
| Wave B (batch 2) | **global branches 62** (enforcement actual 62.54) | ✅ done — batch 2: tests for 13 more never-loaded backend files (`test-hardening`, `stripe`, `compliance-digest`, `library-importer`, `control-taxonomy`, `traceability-graph`, `inherited-control-data`, `org-audit`, `report-delivery-jobs`, `sharepoint-policy-jobs`, `register-schedules`, `processOutbox`, `ClauseRepository`). Enforcement-universe globals (the binding CI gate, read from the `Jest: Coverage for … does not meet` lines): **branches 62.54 / functions 62.09 / lines 77.14 / statements 75.63**. The backend-file pool was largely exhausted — batch 2 moved enforcement branches only 62.13 → 62.54 (the original ≥65 goal was calibrated against the misleading loaded-only ~69%; the remaining 0% mass is **never-loaded `.ts` files inside the coverage universe itself** — `src/app-layer/repositories/*`, `reports/pdf/*`, `lib/hooks/*`, schemas, etc.). ⚠️ The original text here said the remaining mass was "the React UI/page surface (`src/app` + `src/components`)" — that is WRONG and was corrected in Wave C: `collectCoverageFrom` is ONLY `src/app-layer/**/*.ts` + `src/lib/**/*.ts`, so React `.tsx` components and `src/app` pages are not in the gate universe at all and rendering tests for them move the global by zero. `jest.thresholds.json` global set to branches **62**, functions **61**, lines **76**, statements **75** (≤ enforcement actual, up from the original 56/54/70/69). **A true global ≥65 is deferred to a wave that covers the never-loaded backend `.ts` files above.** Per-cohort floors left as set in batch 1 (already passing the gate). See implementation note `2026-06-23-coverage-wave-b.md`. |

### Reading the real numbers

The gate is `scripts/check-merged-coverage.ts`, run once over the four
merged shard artifacts. It prints every group's file count and actual on
every run, pass or fail — no deliberately-high threshold is needed to
surface a number:

```
ok   global                       NNN files  branches NN.NN% (>=NN)  …
ok   ./src/app-layer/usecases/    NNN files  …
```

To reproduce a CI result locally:

1. `gh run download <run-id> -n coverage-shard-1` (and `-2`, `-3`, `-4`).
2. **Rewrite the `/home/runner/work/...` keys** in each
   `coverage-final.json` to your local repo path. Skip this and every
   `./src/...` prefix matches zero files, nothing is subtracted from
   `global`, and the script reports a confident false pass. This has
   happened — see
   `docs/implementation-notes/2026-08-11-coverage-gate-enrolment.md`,
   where the un-rewritten artifact reported a passing 83.27%. The script
   now hard-fails a declared group that matches no files, so the same
   mistake reads as an error rather than a green.
3. `npx tsx scripts/check-merged-coverage.ts <dir> jest.thresholds.json 4`

Never read the global off `coverage/coverage-summary.json`'s `total`:
that file summarises only the files a test loaded, so it omits the
zero-filled remainder the gate counts.

The pre-correction global branch trajectory — **56 → 62.13 → 62.54 →
62.54 (Wave C) → 63.88 (Wave D batch 1) → 65.94 (Wave D batch 2)** — was
measured over the old ~1001-file group and is kept as the record of how
each floor was earned.

The note that used to sit here, that `src/app` and `src/components` "are
NOT in `collectCoverageFrom`, so they cannot move the gate", was right
about the declaration and wrong about the behaviour: the key was declared
where Jest does not read it, so instrumented UI files leaked into the
report and made up roughly three quarters of the old `global` group. That
is why a PR whose only change was adding a page's first test could push
the ratio down and take `main` red (2026-08-11). The scope fix makes the
declaration and the behaviour agree, and the statement is now true.

Global rises as a *consequence* of A/B-tier gains plus standard-tier
hygiene — it is not chased directly. The largest 0% mass left in it is
`src/app-layer/jobs/`, followed by `integrations/` and `services/`.

Two rules keep the ratchet honest. The `Coverage (≥60%)` job enforces
the floors themselves; `tests/guards/coverage-ratchet.test.ts` enforces
that they only travel one way — and unlike the coverage job, that guard
runs on every PR:

- **A PR may not lower a floor.** If a change drops observed
  coverage below a floor, CI fails — add the missing test or revert.
- **A PR that raises observed coverage raises the floor**, in the
  same diff, so the gain cannot silently erode later.

The R3 P4 work makes the "never lower a floor" rule a structural
guardrail (a ratchet test), rather than relying on contributor
discipline.

## What NOT to do

- **Do not chase line coverage with assertion-free tests.** A test
  that calls a function and asserts nothing lifts the line number
  and protects nothing. Branch + behavioural assertions or it does
  not count.
- **Do not add a threshold key above measured coverage.** It fails
  CI immediately. Seed a new key at the measured value, then
  ratchet.
- **Do not lower a floor to make a red PR green.** That is the
  regression this policy exists to prevent — fix the test gap.
- **Do not write a rendered test to move `global`.** `src/app/**` and
  `src/components/**` are outside the coverage scope entirely. Their
  assurance is the tiers in `docs/frontend-assurance-model.md` and the
  population floor in `tests/guards/rendered-coverage-floor.test.ts`.
  Write the rendered test because the page's behaviour needs checking —
  it moves `global` by zero in either direction.

## Enforcement

- **Source of truth:** `jest.thresholds.json` (global + per-folder
  keys). **Five** jobs MEASURE — the four `Test (shard N/4)` legs plus
  `Ratchets` — each running `jest --coverage --coverageReporters=json`
  with no threshold flag, because a shard holds a fraction of the data and
  would report most of the scope as uncovered. There is no longer a
  separate `Coverage (shard N/4)` matrix: it ran the same tests a second
  time, and only on `main`. The `Coverage (≥60%)` job merges the **five**
  artifacts and enforces the floors once, via
  `npx tsx scripts/check-merged-coverage.ts`. Its
  semantics — including the rule that a path key REMOVES its files from
  `global` — are pinned by `tests/unit/scripts/check-merged-coverage.test.ts`.
- **Jest itself enforces nothing.** `jest.config.js` loads the same JSON
  into the node project's `coverageThreshold` for documentation parity,
  but a project-level `coverageThreshold` never reaches the global config
  Jest checks, so the run exits 0 whatever it measures (see
  `docs/implementation-notes/2026-04-27-gap-15-coverage-enforcement.md`).
  The mirror-image rule applies to the scope: `collectCoverageFrom` is
  read ONLY from the global config, which is why it sits at the top level
  of `jest.config.js`. `tests/guards/coverage-config-resolution.test.ts`
  resolves the real config and pins all three placements, so a key that
  drifts into a bucket Jest ignores fails a test instead of silently
  changing what the gate measures.
- **Per-layer keys** carve their folders OUT of `global` and hold them to
  a higher bar. Adding a key therefore SHRINKS `global` — check what is
  left before adding one.
- **The gate runs on pull requests** (since 2026-08-25). It used to be
  `push` / `schedule` / `workflow_dispatch`-only, because it was fed by a
  separate `Coverage (shard N/4)` matrix that re-ran the whole Jest suite
  a second time with instrumentation — ~45 job-minutes nobody wanted on
  every PR. That matrix is gone. Coverage now comes from the runs that
  already happen: the four `Test` shards and the `Ratchets` job each pass
  `--coverage --coverageReporters=json` and upload a `coverage-shard-*`
  artifact, and `Coverage (≥60%)` merges all **five** of them.
- **Those five jobs must keep partitioning the whole suite.** A path key
  removes its files from `global`, so `global` is a residue — change
  which tests contribute and every floor means something different with
  no number in the diff. The `Test` shards run under
  `JEST_SKIP_RATCHETS=1` (1386 files) and `Ratchets` runs exactly what
  that flag drops (654 files); the two are disjoint and exhaustive.
  `tests/guardrails/coverage-gate-population.test.ts` holds that
  invariant, the per-job `--coverage` flag, the uploads, and the
  expected-artifact count handed to `scripts/check-merged-coverage.ts`.

### The ratchet guard

`tests/guards/coverage-ratchet.test.ts` makes the **"never lower a
floor"** rule structural, not just a convention. It carries a
`RATCHET_FLOOR` — the hard minimum for every threshold — and fails
CI if any value in `jest.thresholds.json` drops below it.

- **Raising** a threshold always passes (a value above the floor is
  fine) — that is the ratchet moving up.
- **Lowering** one below the floor fails CI loudly. To genuinely
  retire a floor you must edit `RATCHET_FLOOR` downward too — a
  visible, reviewed act, never a drive-by "make CI green" change.
- `RATCHET_FLOOR` is seeded at the post-R3 state and is only
  ever edited upward as the staged plan advances.

This is the structural backstop for the policy: the
`Coverage (≥60%)` job enforces the *current* numbers; the ratchet
guard enforces that those numbers can only travel one direction.

### Next ratchet steps

- ~~Add dedicated threshold keys for `policies/` and `events/`.~~
  ✅ done in the quality-coverage wave (P3) — keys seeded at the measured values
  (`policies/` 78/88/88/85, `events/` 72/60/78/75) and added to
  `RATCHET_FLOOR`.
- The `usecases/` branch floor has passed its **stage 4 (70)** end state
  — Wave D batch 1 lifted it to 79, held by the ratchet. Further gains
  are additive cushion, not a staged climb.
- The `global` floor is seeded at the first measurement of the corrected
  266-file population, ~1.5-2pp under it. Its end-state target is
  re-derived once two or three runs establish the jitter band; the
  largest 0% mass in that group is `src/app-layer/jobs/`.
- `./src/lib/` has the thinnest headroom of the five (branches 78.50
  against a floor of 78, functions 81.56 against 81). It absorbed the
  files that the corrected scope newly enrols at 0% — a change in
  population, not a regression — and the shortfall that created was
  repaid with tests for `audit/activity-humanize`, `api-error` and
  `mcp/strict-receipt-guard` rather than by moving the floor.
