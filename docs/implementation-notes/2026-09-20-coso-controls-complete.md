# 2026-09-20 — COSO ICF 2013 complete: 96 controls across five components

**Commit:** `<sha>` feat(frameworks): COSO ICF — Information & Communication, Monitoring, and framework close-out (5/5)

The capstone for a five-PR pack. COSO Internal Control — Integrated Framework
(2013) now ships as a first-class framework with **96 authored control
templates**, **~370 phased step-carrying tasks**, and full principle coverage.

## The final taxonomy

| Component | Code | Controls | Domains |
|---|---|---|---|
| Control Environment | CE | 19 | 6 |
| Risk Assessment | RA | 14 | 4 |
| Control Activities | CA | 42 | 10 (6 process + 4 ITGC) |
| Information and Communication | IC | 9 | 3 |
| Monitoring Activities | MA | 12 | 3 |
| **Total** | | **96** | **26** |

Controls claiming each principle:

```
P1=6  P2=6  P3=3  P4=4  P5=3  P6=3  P7=4  P8=5  P9=4
P10=21 P11=18 P12=5 P13=9 P14=5 P15=3 P16=8 P17=4
```

Control Activities carrying 44% is correct, not an imbalance: that is where
testable controls live, and the other four components are largely entity-level.
A framework spreading controls evenly would be describing something other than
how internal control is actually tested.

The distribution is **printed by the close-out assertion**, not merely checked.
A both-directions coverage test passes identically at one control per principle
and at twenty — so "covered" without a count hides exactly the principle nobody
got round to. P3, P5, P6 and P15 sit at three apiece and are visible as the
thinnest.

## The grain decision, and why COSO forced it

**COSO enumerates no controls.** It stops at 5 components and 17 principles by
design — organizations are expected to design their own — and its nearest
equivalent to a control list, the 87 "points of focus", is the copyrighted part.
So unlike ISO 27001, whose Annex A *is* a control catalogue and maps 1:1 onto 93
templates, **there was nothing to port.** Every one of these 96 is this
product's opinionated ICFR baseline.

That forced a decision rather than allowing one, and the grain chosen is:

> one control = one owner, one frequency, one test procedure, one evidence set

It matters mechanically here. One `ControlTemplate` installs as exactly one
`Control` row carrying one `frequency`, one status, one `ControlTestPlan` and one
evidence-link set. A single "logical access" template covering six activities
cannot express that provisioning is event-driven while access review is
quarterly, forces one test plan to bundle unrelated procedures, and leaves
coverage unable to say how far a domain has got. So `CA-05` is six controls, and
the catalogue spans five frequencies (`AD_HOC` · `DAILY` · `MONTHLY` ·
`QUARTERLY` · `ANNUALLY`) rather than defaulting to annual.

## The licensing position

The component and principle **enumeration** is public and was already referenced
in this repo before any of this work: `soc2-2017.yaml` annotates CC1.1 and CC4.1
as paraphrases of COSO Principles 1 and 16. **No framework body text and no
points of focus are reproduced anywhere** — not in the library, not in a
description, not in a task step.

Two guards defend that, and neither is a proof:

- no two descriptions identical across the library (copy-and-adjust is the first
  symptom of reaching for the source);
- no points-of-focus marker string in any template field.

They catch the crude failure. **Neither can judge whether a paraphrase sits too
close to the source — only a person can.** A legal review remains advisable
before customer release, and saying so here is the point of writing it down.

## Crosswalk coverage achieved

| Mapping | Entries | Shape |
|---|---|---|
| COSO → SOC 2 | 8 | P1, P2, P6, P7, P10, P13, P16, P17 |
| COSO → ISO 27001 | 9 | P1, P5, P11 (P11 carries 7 after the ITGC content) |

Both are **deliberately incomplete and the gaps are the content.** This repo's
SOC 2 library carries one assessable node per common-criteria series, not the
full TSC, so principles whose real counterpart is a code the library lacks
(P3/P4/P5 against CC1.3/CC1.4/CC1.5) are absent rather than mapped to whichever
node exists — a mapping that resolves but misstates the relationship is read as
coverage.

Two ISO rows were written and removed: P16→clause 9 and P17→clause 10. The
clauses are **non-assessable grouping nodes** here, and `library-importer` writes
a `RequirementMapping` only for assessable targets, so those rows would have
reached no database at all. All 17 surviving entries map assessable → assessable.

## What a tenant gets on pack install

`COSO_ICF_BASELINE` installs 96 `Control` rows — one per template, carrying its
objective, success criteria, testing methodology, frequency and owner hint —
plus ~370 `ControlTemplateTask` copies with phases, steps and evidence hints, and
a `ControlRequirementLink` for every `requirementCodes` entry. The framework then
lights up the surfaces any framework inherits: coverage, gap analysis,
requirement status rollup, audit readiness and packs, framework version drift,
and policy traceability.

The fixture declares the **same framework key as the library** (`COSO-ICF-2013`),
so both converge on one `Framework` row. Every other framework in this repo
exists twice under two keys, one per authoring path, and a tenant's links hang
off whichever row its database got. COSO does not inherit that.

## Five registrations a new framework owes

None were in the prompt pack; each is a guard that fails naming itself, and all
five were answered rather than waived:

| Guard | Answer |
|---|---|
| `framework-starter-pack-completeness` | bare in PR 1, **moved** to `STARTER_PACKS` in 2A |
| `library-obligations-reach-the-catalogue` | excluded in PR 1, **deleted** for a real pair in 2A |
| `soa-gate-is-declared-not-inferred` | **no SoA** — an SoA lists which Annex A controls apply, and COSO has no Annex A |
| `section-axis-is-structural` | section count pinned at 5, the components |
| `catalog-requirement-prose` | **0 of 17** — COSO ships 100% summary coverage |

That last one is structural rather than diligent: COSO's source text is
copyrighted, so there was never a thin-transcription path to fall down. Every
summary had to be written.

## What the prompt pack got wrong

**`prisma/catalogs/` reaches no tenant.** The pack directed all four content PRs
there. It is referenced by one integration test and one implementation note;
production applies `prisma/fixtures/*-control-templates.json` through
`seed-framework-catalogs.ts` on every container start, and
`listInstallableFrameworks` offers only frameworks **with a pack**. Authored as
specified, all 96 controls would have been installable by nobody. This was the
highest-cost error in the pack and was findable only by following the consumer
rather than the filename.

The pack also specified frequencies that do not exist (`per-event`,
`per-occurrence` — the enum has `AD_HOC`), and asked for a crosswalk test that
`mapping-targets-exist.test.ts` already performs over every file in `mappings/`.

## What authoring 96 controls across four batches taught

**Name exact pairs, not categories.** Every batch got a cross-domain trap list,
because fanning out per domain structurally cannot see a collision that crosses
domains. 2C — the only list naming *exact pairs* (privileged vs generic accounts;
backup-*verified* vs restore-*proven*) — was the only batch whose gate passed
first time. 2A, 2B and 2D each produced one collision despite being warned.

**Warning reduces damage; it does not prevent it.** Told explicitly that three
controls report to the audit committee, two agents still opened a task "Agree
what the committee…". The batch-internal similarity and shared-run checks caught
the residue. Neither instrument is sufficient alone.

**A verb refused once must stay refused.** Across four batches: `Fit`, `Fix`
(attempted three separate times), `Seat`, `Stand` — all refused and their titles
redrafted onto verbs already curated. 55 verbs *were* added, deliberately, each
read in context: the list was curated against security subject matter and ICFR
uses verbs with no security analogue. The failure direction makes growing it safe
— an absent verb is a loud false positive, while the noun-phrase titles it
rejects still cannot get in. Growing it by attrition is the thing to avoid.

**The bar caught its author.** `CE-01.01` was hand-written as the exemplar before
the bar was measured and shipped a 366-character `successCriteria` — below the
p25 of the content it sat beside. The floor had been raised for the agents
*because* that draft looked thin, and the exemplar was not revisited. The test
failed on it; it was enriched rather than the floor lowered.

## Quality, measured

Against the 414 templates this product already shipped:

| | incumbent | COSO (96) |
|---|---|---|
| `objective` | median 165 | **~176** |
| `successCriteria` | median 459 | **~590** |
| `testingMethodology` | median 1267 | **~1520** |
| tasks carrying steps | 610/1917 = **32%** | **100%** |
| OPERATE with `evidenceHint` | 100% | **100%** |

Steps at 100% is deliberate: content carrying them is held by *both* the
actionability and conformance guards, content without them by only one.

COSO appears in **no content allowlist**. `LEGACY_GENERIC_ALLOWLIST` and
`UNSCANNABLE_INLINE_POPULATIONS` both remain empty records at their stated end
state, so an entry would be a visible regression rather than a waiver.
