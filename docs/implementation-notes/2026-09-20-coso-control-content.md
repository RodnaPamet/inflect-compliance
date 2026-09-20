# 2026-09-20 — COSO ICF: Control Environment + Risk Assessment control content

**Commit:** `<sha>` feat(frameworks): COSO ICF — Control Environment and Risk Assessment controls (2/5)

PR 2A of five. 33 control templates — CE 19, RA 14 — at testable-control grain,
with 140 phased, step-carrying tasks. **This note carries the task authoring
rules the three remaining content PRs inherit.**

## Design

COSO enumerates no controls: it stops at 5 components and 17 principles, and its
nearest equivalent to a control list (the 87 points of focus) is the copyrighted
part. So every template here is this product's **authored ICFR baseline**, not a
port, written at the grain an auditor tests:

> one control = one owner, one frequency, one test procedure, one evidence set

That grain is why `COSO-CA-05` will be six controls rather than one "logical
access" template: a single template cannot express that provisioning is
event-driven while access review is quarterly, forces one test plan to bundle
unrelated procedures, and leaves coverage unable to say how far a domain has got.

## Files

| File | Role |
|---|---|
| `prisma/fixtures/coso-icf-2013-control-templates.json` | framework, 17 requirements, 33 templates, the pack |
| `scripts/seed-framework-catalogs.ts` | registers the fixture on the production path |
| `tests/guardrails/coso-control-content.test.ts` | taxonomy set-equality + the measured quality bands |
| `tests/guardrails/control-task-actionability.test.ts` | curated verb list extended for ICFR vocabulary |
| `tests/guardrails/framework-starter-pack-completeness.test.ts` | COSO moved bare → starter pack |
| `tests/guardrails/library-obligations-reach-the-catalogue.test.ts` | exclusion deleted, pair declared |

## TASK AUTHORING RULES — inherited verbatim by PRs 2B, 2C and 2D

1. **3–5 tasks per control, spanning at least 3 distinct phases** of
   SCOPE / IMPLEMENT / OPERATE / REVIEW. Phase spread fails in *both*
   directions: filling SCOPE→IMPLEMENT→OPERATE leaves zero REVIEW, and
   filling IMPLEMENT/REVIEW/SCOPE leaves zero OPERATE. Assign the phase from
   what the task *is*.
2. **Titles: imperative verb + the control's own subject.** Never generic. The
   verb must be in `IMPERATIVE_VERBS` in `control-task-actionability.test.ts` —
   extend that list deliberately rather than bending a title, but read each
   candidate in context first (see "the verb list" below).
3. **Never open a title with** `ensure`, `maintain`, `be`, `remain`, `continue`,
   `keep` — a state has no completion. Also avoid `Record` as an opener: it
   already begins 17.1% of the 1,921 shipped tasks, past the gate's 15% ceiling.
4. **4–6 steps per task, each ≥ 25 characters**, naming the artefacts involved —
   registers, matrices, minutes, acknowledgement records, tickets. No
   "ensure that…" filler.
5. **`evidenceHint` on every OPERATE task**, naming the artefact an auditor
   accepts.
6. **`suggestedRole` from exactly this set:** Audit Committee · Executive
   management · CFO/Controller · Internal Audit · Process Owner · IT Operations ·
   Engineering lead · HR · Legal/Compliance. Finance and governance weighted —
   deliberately *not* the security roles the ISO 27001 content uses.
7. **`defaultFrequency` chosen per control.** The enum is exactly `AD_HOC`,
   `DAILY`, `WEEKLY`, `MONTHLY`, `QUARTERLY`, `ANNUALLY`. **There is no
   per-event or per-occurrence value** — an event-driven control is `AD_HOC`.
   Defaulting everything to `ANNUALLY` passes every structural check and throws
   away the reason this content is authored at one control per frequency.
8. **Ground every task in the linked principle.** Assert no obligation the
   principle does not carry.

### The measured quality bar

Not preferences — the distribution of the 414 templates this product already
ships, which is what "COSO meets the others in quality" has to mean:

| field | existing | COSO 2A |
|---|---|---|
| `objective` | 134–192, median 165 | 146–196, median 176 |
| `successCriteria` | 326–602, median 459 | 463–620, median 565 |
| `testingMethodology` | 936–1847, median 1267 | 1257–1770, median 1507 |
| tasks carrying steps | 610/1917 = **32%** | 140/140 = **100%** |
| OPERATE with `evidenceHint` | 433/433 | 39/39 |

`testingMethodology` uses the house three-heading structure — `Evidence:` /
`Analysis:` / `Output:` — which 149 of the 151 internal-controls templates use.
Name populations and sampling explicitly; a paragraph that re-describes the
control instead of testing it is the failure this structure prevents.

Steps are at **100%** rather than the incumbent 32% on purpose: content carrying
steps is held by *both* the actionability and conformance guards, content
without them by only one.

## Decisions

### The pack's target directory was wrong, and it would have cost four PRs

The prompt pack directs the content PRs to `prisma/catalogs/coso-icf-2013.yaml`.
That directory is referenced by exactly one integration test and one
implementation note. The production seeder `scripts/seed-framework-catalogs.ts`
— run by `scripts/entrypoint.sh` on every container start — reads
`prisma/fixtures/*-control-templates.json`, and `listInstallableFrameworks`
offers only frameworks **with a pack**.

Authored as specified, all 96 controls would have been installable by nobody
without a manual CLI import per environment. `loadCatalogFile` accepts YAML or
JSON, so the correction is only a location and one line in the seeder. **PRs 2B,
2C and 2D must extend `prisma/fixtures/coso-icf-2013-control-templates.json`.**

### One framework key, not two

The fixture declares `COSO-ICF-2013` — the same key as the library. Every other
framework in this repo exists **twice** under two keys, one per authoring path,
and `usecases/framework/coverage.ts` records that a tenant's
`ControlRequirementLink` rows hang off whichever row its database got. COSO has
no such split and should not acquire one, so the library import and the fixture
converge on a single `Framework` row.

### The verb list was extended by 41, and two candidates were refused

`IMPERATIVE_VERBS` was curated against *security* subject matter. ICFR uses
verbs with no security analogue: `Escalate` a matter to a committee, `Table` a
paper, `Convene` a session, `Grant` a waiver, `Re-perform` a reconciliation,
`Back-test` an estimate. The list already grew 61→125 when the first authored
content landed, for the same structural reason, and its docblock says to extend
it deliberately — the failure direction is safe, because an absent verb is a loud
false positive while the noun-phrase titles it rejects still cannot get in.

All 43 candidates were read in context. Two were **refused**: `Fit` (redrafted to
`Attach`) and `Fix` (ambiguous between *settle* and *repair*; the two titles
moved to `Determine` and `Establish`, both already curated).

### The trap list did its job, and did not finish it

Authoring was fanned out one agent per domain, which structurally cannot see a
collision that crosses domains. Eight cross-slice traps were named in the brief
— the sharpest being that **three separate controls report to the audit
committee** (CE-02.03, CE-03.03, RA-03.04).

It worked partially. The batch came back with exactly one collision: CE-03.03 and
RA-03.04 both opened a task "Agree what the committee…". Being warned reduced the
damage to a shared four-word run rather than two near-identical controls, but did
not eliminate it — which is why the batch-internal similarity and shared-run
checks exist as well. **Neither instrument is sufficient alone.** The title was
redrafted onto cadence, which is what CE-03.03 is actually about.

### The bar caught its author

The first control (CE-01.01) was hand-written as an exemplar before the bar was
measured, and shipped a 366-character `successCriteria` — inside the original
band but below the incumbent p25 of 428. The band was raised to 420 for the
agents and the exemplar was not revisited; the new test failed on it. It was
enriched to 580 rather than the floor being lowered.

## Remaining scope for PRs 2B–2D

| PR | Component | Domains | Controls | Running total |
|---|---|---|---|---|
| 2B | CA process-level | 01 RCM · 02 SoD · 03 management review · 04 close · 09 policy · 10 service orgs | 24 | 57 |
| 2C | CA ITGC | 05 logical access · 06 change · 07 operations · 08 IT dependency | 18 | 75 |
| 2D | IC + MA | IC 01–03 · MA 01–03 | 21 | 96 |

Each extends the set-equality in `coso-control-content.test.ts` and the pack's
`templateCodes`, so a control dropped or renamed in one PR fails the next rather
than shipping. 2D additionally asserts full principle coverage in both
directions and the per-component counts CE 19 / RA 14 / CA 42 / IC 9 / MA 12.
