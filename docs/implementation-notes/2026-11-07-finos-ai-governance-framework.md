# 2026-11-07 — FINOS AI Governance Framework: 25 controls, 24 risk templates, FINOS's own crosswalks

**Commit:** _(stamped post-commit)_ `feat(frameworks): FINOS AI Governance Framework`

## Design

The FINOS AI Governance Framework (AIGF) is an open, CC-BY-4.0 catalogue of AI
risks and the mitigations that address them, written for financial services by
the Fintech Open Source Foundation and maintained on GitHub. It splits along the
line Inflect already draws between what an organisation *implements* and what it
*registers*:

```
FINOS AIGF (snapshot: commit 67b8c325, 2026-11-02)
├── 25 mitigations  ──►  src/data/libraries/finos-aigf.yaml            requirements MI-1 … MI-25
│                        prisma/fixtures/finos-aigf-control-templates.json
│                            25 templates · 142 tasks · 731 steps · pack FINOS_AIGF_BASELINE
│                            applied by scripts/seed-framework-catalogs.ts
├── 24 risks        ──►  prisma/fixtures/risk-templates-finos-aigf.json
│                            applied by scripts/seed-risk-templates.ts   (NEW production seeder)
└── each mitigation's
    citations       ──►  mappings/finos-aigf-to-iso-42001.yaml   53 entries
                         mappings/finos-aigf-to-eu-ai-act.yaml    9 entries
```

One `Framework` row, key `FINOS-AIGF`: the catalogue declares the library's key
and its requirements are generated from the library, as AIUC-1 and COSO do. The
integration test runs both writers in both orders and compares requirement
**row ids**.

## Files

| File | Role |
| --- | --- |
| `src/data/libraries/finos-aigf.yaml` | 2 type groups + 25 mitigations; identifiers and titles FINOS's, descriptions ours |
| `prisma/fixtures/finos-aigf-control-templates.json` | CatalogFile: framework, requirements (generated), 25 authored templates, the pack |
| `prisma/fixtures/risk-templates-finos-aigf.json` | the 24 risks as global `RiskTemplate` rows |
| `scripts/seed-risk-templates.ts` | production writer for fixture-backed risk templates; wired into `build-worker.mjs`, `entrypoint.sh`, `npm run db:seed-risk-templates` |
| `src/data/libraries/mappings/finos-aigf-to-*.yaml` | FINOS's own citations, `[FINOS-crosswalk]`, all RELATED |
| `scripts/seed-framework-catalogs.ts`, `prisma/seed.ts` | apply the catalogue (production; dev and E2E) |
| `src/lib/controls/control-taxonomy.ts` | `FINOS AIGF` badge |
| `src/app-layer/usecases/onboarding.ts`, `src/components/onboarding/OnboardingWizard.tsx` | the framework selects the AI-governance self-assessment step |
| `tests/guardrails/finos-aigf-framework-coverage.test.ts` | enumeration, library↔catalogue parity, content bar, risk delivery, mapping provenance |
| `tests/integration/finos-aigf-framework-import.test.ts` | both writers, both orders, and every citation resolving to a mapping row |

## Decisions

### Mitigations are requirements; risks are risk templates

A requirement is something a tenant implements and evidences; a FINOS mitigation
is exactly that, written at control grain with its own owner and evidence. A
FINOS risk is not an obligation — nobody is "compliant with prompt injection" —
so making risks requirements would give tenants rows to mark compliant that
state nothing testable. The risks go where a risk belongs: the template library
the New Risk dialog offers.

### An index plus our own words, although CC-BY would allow copying

CC-BY-4.0 permits reproduction with attribution, unlike OWASP's share-alike or
AIUC's all-rights-reserved terms. The owner chose the index posture anyway
(2026-11-07): identifiers and short titles are FINOS's, every description,
control and task is Inflect's. The practical reasons: FINOS rewrites its prose
often, so a copy would drift; and an index needs no judgement about how much was
copied. It was **measured**: the authoring validator rejected any run of six
consecutive words shared with any FINOS risk or mitigation file, across all 25
controls, 142 tasks and 731 steps, and the risk descriptions were checked the
same way. The FINOS corpus is not committed, so CI cannot re-run that check;
it is recorded here instead.

### Identifiers are FINOS's sequence numbers

`MI-n` and `RI-n` are the numbers FINOS's own files carry. FINOS retires a number
rather than reusing it, so RI-3, 11, 12, 13, 15 and 21 are correctly absent. Its
public ID scheme is still being decided upstream (finos/ai-governance-framework#398);
if it changes, the new identifier belongs in a node annotation, never in
`ref_id`, which every tenant link resolves against. No edition in the key: the
AIGF is revised in place.

### Drafts are carried and labelled

MI-24, MI-25 and RI-30 are `doc-status: Draft` upstream. They are the newest
agentic material and the most useful, so they ship, and each description says
FINOS publishes it as a draft; the guard pins exactly that set.

### The mappings are FINOS's, so they say so

Each mitigation's front matter lists the ISO 42001 and EU AI Act clauses it
addresses; the mapping files are those lists, generated from the snapshot. They
carry `[FINOS-crosswalk]`, following `[NIST-crosswalk]`, not `[curated]`. FINOS
cites without grading the overlap, so every entry is RELATED, which gap analysis
reads as "review needed", never as covered. Four EU AI Act citations name
Articles 72 and 86, which Inflect's EU AI Act library does not model; they are
listed in the file header instead of being dropped silently.

Two things were deliberately **not** done:

- **No OWASP Agentic mapping.** FINOS's mitigations cite no ASI identifier;
  only its risks do. A mitigation→ASI link could be composed through
  "mitigates RI-n, which cites ASIxx", but that composition would be Inflect's
  inference, labelled as FINOS's.
- **No NIST SP 800-53 or OWASP LLM mapping.** FINOS cites both heavily (194 and
  24 links), but Inflect carries neither library, so those entries would resolve
  to nothing.

### Cadence and scores are left neutral

FINOS sets no evidence cadence and no likelihood or impact. Every control is
ANNUALLY (the catalogue default) and every risk template starts at 3×3. A
tighter cadence or a differentiated score would be an Inflect judgement shown as
FINOS's; the tenant sets both.

### Risk templates get a production writer

`RiskTemplate` rows were written only by `prisma/seed.ts`, which production never
runs, so no risk template reached a deployed database. The FINOS risks would have
shipped into the same hole. `scripts/seed-risk-templates.ts` upserts the
fixture-backed sets by `id` on every start. The older inline sets (generic,
privacy, SSDF, CIS, ASVS) were left where they are: five guards read them out of
`prisma/seed.ts` by design, and moving them is its own change. Until it is made,
a production tenant's template picker offers the FINOS risks only.

### Categories and grouping

Requirements are grouped as FINOS types them: preventative (17) and detective
(8). Templates carry FINOS's domain in a framework-qualified category
(`FINOS AIGF Access`, `FINOS AIGF Filtering`, …) so the Controls category filter
cannot merge them with another framework's. Risk templates use the canonical
`RISK_CATEGORIES`: FINOS type SEC is Technical, OP Operational, RC Compliance,
and RI-20 Reputational.

### How the controls were authored

Five batches grouped by subject, so the confusable pairs shared one author:
leakage detection vs knowledge-base filtering (MI-1/MI-2), access to AI data vs
source entitlements in retrieval (MI-12/MI-16), filtering rules vs operating a
firewall layer (MI-3/MI-17), availability vs spend (MI-8/MI-9), acceptance
testing vs a judge model (MI-5/MI-15), agent scope vs isolation vs credentials
(MI-18/MI-22/MI-23), decision records vs approval gates (MI-21/MI-24), and tool
calls vs MCP servers vs skills (MI-19/MI-20/MI-25). Each batch ran a validator
encoding the conformance and actionability rules and the AIUC-1 content bands
before anything reached the repo. Where FINOS leaves a parameter to the
organisation (a threshold, an interval, a pass rate), the task records the
organisation's choice rather than prescribing one. Twenty-one titles were then
redrafted onto verbs the actionability guard already curates (`Vet` → `Assess`,
`Plant` → `Deploy`, `Red-team` → `Test … adversarially`), rather than growing
that list.

### No Statement of Applicability

The AIGF has no annex, and the product's SoA artifact is Annex-A-shaped. A tenant
scopes the framework per mitigation with requirement applicability.
