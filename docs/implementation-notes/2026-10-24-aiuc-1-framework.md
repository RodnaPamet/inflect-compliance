# 2026-10-24 — AIUC-1: framework, 50 controls and their authored tasks

**Commit:** _(stamped post-commit)_ `feat(frameworks): AIUC-1 AI agent standard with authored controls and tasks`

## Design

AIUC-1 is a certification standard for AI **agents**, published by the
Artificial Intelligence Underwriting Company and audited by accredited auditors.
It joins the OWASP Agentic AI Top 10 (the threat model) and the IMDA MGF (the
accountability structure) as the third agent-specific source in the catalogue,
and the only one a customer is certified against.

It ships the way COSO does — one framework, two authoring paths, **one row**:

```
src/data/libraries/aiuc-1.yaml            the enumeration: 6 domains, 50 requirements
        │  requirements GENERATED from it
        ▼
prisma/fixtures/aiuc-1-control-templates.json
        framework AIUC-1 · 50 requirements · 50 templates · __TASKS__ tasks · pack AIUC_1_BASELINE
        │  scripts/seed-framework-catalogs.ts (every container start)
        ▼
Framework(key = AIUC-1)  ← library sync writes the same row, same requirement rows
```

What a tenant gets on installing `AIUC_1_BASELINE`: 50 `Control` rows, one per
requirement, each carrying an objective, success criteria and an Evidence /
Analysis / Output test procedure, at the cadence AIUC-1 re-evidences that
requirement; __TASKS__ phased tasks, every one with steps, an evidence hint and
an owner role; and a requirement link per control. Coverage, gap analysis,
readiness and framework version drift come with the framework like any other.

### What is in the enumeration

The **Q4-2026 release (15 October 2026)**: 50 requirements in force across six
domains — A Data & Privacy 9, B Security 10, C Safety 10, D Reliability 3,
E Accountability 16, F Society 2.

AIUC-1 retires a requirement rather than renumbering the ones after it, so the
identifiers have five correct gaps: C011, C012 (folded into C010) and D002
(folded into D004) in this release, E007 and E014 earlier. They are not modelled.
A retired row would be something a tenant could be "compliant with" that the
standard no longer asks for; the guard asserts the enumeration by set equality
so restoring one to make the numbering look continuous fails.

## Files

| File | Role |
| --- | --- |
| `src/data/libraries/aiuc-1.yaml` | 6 domain nodes + 50 requirements; identifiers and short titles are AIUC's, every description is ours |
| `prisma/fixtures/aiuc-1-control-templates.json` | CatalogFile: framework, the 50 requirements (generated from the library), 50 templates with authored tasks, the pack |
| `scripts/seed-framework-catalogs.ts` | registers the fixture on the production path |
| `src/lib/controls/control-taxonomy.ts` | `AIUC-1` badge label |
| `src/app-layer/usecases/onboarding.ts`, `src/components/onboarding/OnboardingWizard.tsx` | AIUC-1 selects the AI-governance self-assessment step (server and client gates) |
| `tests/guardrails/aiuc-1-framework-coverage.test.ts` | the enumeration, applicability claims, library↔fixture parity, cadence, content bar |
| `tests/integration/aiuc-1-framework-import.test.ts` | both writers, both orders, against a real database: one row, same requirement ids |
| `tests/guardrails/framework-starter-pack-completeness.test.ts` | starter pack registered |
| `tests/guardrails/library-obligations-reach-the-catalogue.test.ts` | exact pair declared |
| `tests/guards/soa-gate-is-declared-not-inferred.test.ts` | SoA decision: no |
| `tests/guardrails/section-axis-is-structural.test.ts` | section count pinned at 6 |
| `tests/guardrails/catalog-requirement-prose.test.ts` | summary pair + `0 of 50` |
| `tests/guardrails/ai-governance-step-framework-gate.test.ts` | AIUC-1 joins the AI-framework keys |

## Decisions

### Licensing: identifiers and titles only, and the check was measured

AIUC-1 is "© AIUC — all rights reserved", and its terms of use grant a personal,
non-commercial licence and prohibit copying, redistribution and derivative works.
That is stricter than OWASP's CC-BY-SA, so the posture is COSO's rather than
OWASP's: the **enumeration** is carried — domain names, requirement identifiers,
short titles, which a tenant needs to cite a requirement to their auditor — and
nothing else. AIUC's requirement statements, the control activities beneath them
(`A001.1` …), their evidence guidance and AIUC's crosswalk tables are not in the
repo, and no AIUC page was committed.

Every description, control and task is original. That was **measured**, not
asserted: while authoring, every string was compared against AIUC's published
requirement, evidence, taxonomy and crosswalk pages, and the content ships with
**no run of six or more words in common** with them other than the requirement
titles themselves. The comparison corpus cannot be committed (it is AIUC's
content), so the CI guard carries the cheaper half — no control-activity
identifiers, no evidence-guidance phrasing. Neither can judge a paraphrase that
is merely too close; a legal review is advisable before customer release, and
this note is where that is recorded rather than assumed.

The crosswalks AIUC publishes (ISO 42001, EU AI Act, NIST AI RMF, OWASP, SOC 2)
were **not** turned into mapping sets. Transcribing them would be a derivative of
AIUC's compilation; authoring our own is real work with its own ratchet
(`mapping-targets-exist`) and is the natural follow-up.

### One framework key, no edition

The fixture declares `AIUC-1`, the library's `ref_id`, so the two writers
converge on one `Framework` row instead of the two-row split most older
frameworks carry. The requirements are generated from the library field for
field, so neither writer rewrites what the other wrote; the integration test runs
both writers in both orders and compares requirement **row ids**.

The key carries no edition because AIUC-1 is revised **in place** every quarter
(15 January / April / July / October) under stable identifiers — the same reason
`OWASP-ASI-TOP10` is unsuffixed. With the edition in the key, each release would
import as a second framework and strand every link pinned to the first. The
fixture's `version` names the release (`2026-Q4`).

### One control per requirement

AIUC-1's requirements are already at control grain: each has its own cadence,
its own evidence, and can be scoped in or out on its own. So each gets one
template (`AIUC-A001` … `AIUC-F002`). Bundling — the five quarterly third-party
evaluations into one, say — would force one test plan onto requirements an
auditor tests separately, and stop a tenant marking one not applicable without
the others.

### Cadence is AIUC-1's, and E012 rounds up

`defaultFrequency` is the cadence AIUC-1 re-evidences each requirement on:
QUARTERLY for A009, B001, B002, B007, C006, C009, C010, D004 and E018 (every three
months), ANNUALLY for the rest. E012 is every **six** months and the frequency
enum has no semi-annual value, so it is QUARTERLY — the tightest value that
still meets it; ANNUALLY would fail it.

### No Statement of Applicability — a closer call than COSO

AIUC-1 does scope every audit with an auditor-signed statement of which
requirements and core/supplemental controls apply. But the product's SoA
artifact is Annex-A-shaped by construction ("All N Annex A controls" in the PDFs,
an `AnnexAKey` CSV column), and AIUC-1 has no annex; turning it on would print a
document about an annex the standard does not have. Scoping is recorded the way
every non-annex framework records it: per-requirement applicability.

### Applicability lives in the description, and is checked

AIUC-1 marks eight requirements optional and scopes fifteen to an agent
capability (generating code, generating text, taking actions, being externally
facing). The library importer persists a requirement's description and not its
`annotation`, so the facts are stated in the description — and because a tenant
acts on them when marking requirements not applicable, the guard pins both sets
as data and checks the prose against them in both directions.

### Categories are framework-qualified

Template categories are `AIUC-1 Data & Privacy` … `AIUC-1 Society` rather than
the bare domain names. The Controls category filter keys on the bare string, so
a plain `Security` would merge with any other framework's. Requirement sections
keep the standard's own labels (`A. Data & Privacy` …).

### How __TASKS__ tasks were authored without becoming boilerplate

One exemplar (`AIUC-A001`) was written first to set the bar, then the other 49
were authored in eight batches grouped by **subject** rather than by domain
letter, so that the most confusable pairs shared one author: data the agent may
read / services it may reach / each tool call / people's access to it (A003,
B006, D003, B007); the five quarterly independent evaluations, which share one
shape and differ only by risk domain; the three failure plans. Every batch got a
boundary table naming the exact pairs, and a validator that encodes the repo's
guard rules plus the bands COSO was held to, run before anything reached the
repo.

The bar, measured against the COSO bands the guard enforces:

__BAR__

AIUC-1 appears in no allowlist in any content guard.

### Not added to `prisma/seed.ts`

As with COSO, the fixture is applied by `scripts/seed-framework-catalogs.ts`
only — the path production runs. A developer who wants it locally runs
`npm run db:seed-catalogs`. Adding it to the dev seed would change the E2E
database (which `prisma/seed.ts` builds) for no gain in coverage.
