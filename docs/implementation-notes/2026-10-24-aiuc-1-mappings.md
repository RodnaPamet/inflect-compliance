# 2026-10-24 — AIUC-1 cross-framework mappings

**Commit:** _(stamped post-commit)_ `feat(mappings): AIUC-1 crosswalks to ISO 42001, ISO 27001, SOC 2, OWASP ASI, IMDA MGF and the EU AI Act`

## Design

AIUC-1 landed in #4045 with its own 50 controls and no edges to anything else.
A tenant holding ISO 42001 saw AIUC-1 at zero, and an AIUC-1 holder's controls
counted toward nothing but AIUC-1. This change adds six pairs, each in both
directions: twelve files, 265 curated edges each way.

| Pair | Forward file | Edges | The question the forward direction answers |
|---|---|---|---|
| ISO 42001 ⇄ AIUC-1 | `iso-42001-to-aiuc-1.yaml` | 62 | How much of AIUC-1 does my AI management system already give me? |
| ISO 27001 ⇄ AIUC-1 | `iso27001-to-aiuc-1.yaml` | 46 | How much does my ISMS give me? |
| SOC 2 ⇄ AIUC-1 | `soc2-to-aiuc-1.yaml` | 23 | How much does my SOC 2 control set give me? |
| AIUC-1 ⇄ OWASP ASI | `aiuc-1-to-owasp-agentic.yaml` | 46 | Which agentic risks do my AIUC-1 controls bear on? |
| AIUC-1 ⇄ IMDA MGF | `aiuc-1-to-imda-mgf.yaml` | 49 | What does AIUC-1 give me toward the IMDA governance framework? |
| AIUC-1 ⇄ EU AI Act | `aiuc-1-to-eu-ai-act.yaml` | 39 | What does AIUC-1 give me toward the Act's obligations? |

They go through the existing machinery and nothing else: YAML in
`src/data/libraries/mappings/`, imported by `mapping-set-importer.ts` in
library-sync phase 2. There is no new model, no migration and no route.

Two product surfaces read them, and neither needed a change:

- **Gap analysis and traceability.** Every mapping set is a graph edge.
- **Per-agent risk coverage** (`agent-coverage.ts`). It reads every mapping
  whose TARGET is an OWASP ASI risk, whatever the source. So an AIUC-1
  holder's controls now count toward a registered agent's inherited risk
  coverage. Tenant G in `tests/integration/agent-coverage-analysis.test.ts`
  proves it end to end. It holds two AIUC-1 controls; three risks come out
  partially covered, one is in `reviewNeeded` and six are uncovered, each
  named by code.

## Files

| File | Role |
|---|---|
| `src/data/libraries/mappings/{iso-42001,iso27001,soc2}-to-aiuc-1.yaml` + reverses | What an existing certification gives toward AIUC-1 |
| `src/data/libraries/mappings/aiuc-1-to-{owasp-agentic,imda-mgf,eu-ai-act}.yaml` + reverses | What AIUC-1 gives toward the agentic sources and the Act |
| `tests/unit/agentic-framework-mappings.test.ts` | AIUC-1 joins the agentic frameworks, so all five invariants now hold its pairs. CatalogFile representations are read through the production loader. AIUC-1 → ASI must reach all ten risks |
| `tests/integration/agent-coverage-analysis.test.ts` | Tenant G: an AIUC-1 holder's per-agent coverage, through the real importer |
| `docs/requirement-mapping-sets.md` | Supported-sets table regenerated from the directory (it listed 30 pairs against 32 files); the symmetric-pairs section now covers AIUC-1 |

## Decisions

### Authored, not transcribed

AIUC publishes its own crosswalks to most of these frameworks. They are AIUC's
copyright, under terms that forbid derivative works (see the framework note),
and they were neither transcribed nor used as a source. Every edge was written
from the requirement texts this repository carries: our own AIUC-1
descriptions and the counterpart libraries. Every rationale starts with
`[curated]`, so a reader never mistakes an edge for a citation. Where an edge
disagrees with AIUC's tables, that is the point: the edge is Inflect's
judgement.

### Strengths are chosen against their transpose

The agentic pairs ship as exact transposes with `SUBSET` ⇄ `SUPERSET`
inverted, and `determineGapStatus` reads `SUPERSET` as `COVERED`. So every
`SUBSET` written in one file is a `COVERED` claim in the other.

The documented rule — `SUBSET` where the source is narrower and covers part of
the target — does not see that second claim. Applied here, it would write
ISO 27001 A.8.15 (logging) → AIUC-1 E015 as `SUBSET`. The transpose would then
tell every AIUC-1 holder that A.8.15 is met. But E015 governs the logs of one
system, and A.8.15 those of every system the organisation runs.

The bar is therefore containment in the direction the strength claims.
`SUBSET` / `SUPERSET` are reserved for an edge where meeting the broader
requirement, as written, necessarily meets the narrower one.

**No AIUC-1 edge clears that bar.** All 265 are `INTERSECT` (real shared
ground, shown as partially covered) or `RELATED` (where the control would
live, never counted as coverage). There is no `EQUAL`. That is a finding about
AIUC-1, not timidity. AIUC-1 states what an AGENT must do. The standards it is
mapped to govern management systems, information security and AI in general.
They overlap AIUC-1 widely and contain almost none of it.

The closest candidate shows where the bar sits. E013 (quality management
system) → EU AI Act Article 17 was first written as `SUBSET`. Reviewed element
by element, it does not hold:

- Article 17(1) lists no quality objectives or metrics.
- Corrective action is Article 20's, not Article 17's.
- Article 17(4) deems a financial institution's internal governance to meet
  Article 17.

So an Article 17 holder has not necessarily met E013, and the edge is
`INTERSECT`.

### An independent review changed 36 entries

The first draft went to a second reviewer. The reviewer was given the files
and the requirement texts, not the author's reasoning. The review led to 20
strength changes and 16 rationale-only corrections where a rationale
misstated a requirement. It also added two edges: ISO 42001 8.1 → E004 and
AIUC-1 D001 → Art.14. Two rules came out of the review, and they now apply
throughout:

- **A testing requirement mitigates a risk only if it fixes what it finds.**
  It is `INTERSECT` with an OWASP risk when it targets that risk AND its
  description tracks each finding to a fix and a retest (A009, C010, D004,
  E018). Otherwise it is `RELATED`. B001 (third-party security testing)
  carries no remediation clause, so its edges onto ASI01, ASI02 and ASI05
  are `RELATED`.
- **A rationale that says "X is where Y would live" is a `RELATED`
  rationale.** Five `INTERSECT` edges were argued in exactly those words, and
  each was either re-argued on a shared obligation or moved to `RELATED`.

### Coverage from the control library is complete

AIUC-1 joins `AGENTIC_FRAMEWORKS`, so invariant 1 applies: each of its 50
requirements is reached from ISO 42001 or ISO 27001, and
`UNMAPPED_WITH_REASON` stays empty. The thinnest routes are F001 and F002
(cyber and catastrophic misuse). They reach ISO 42001 only as `RELATED`, to
its societal-impact assessment, which is the honest statement that neither
ISO standard asks for a model capability assessment.

### SOC 2 is mapped on the common criteria only

The SOC 2 representation that installed SOC 2 controls link to
(`soc2-control-templates.json`) carries CC1.1–CC9.1 and no A1, C1, PI1 or P1.
An edge onto P1 would resolve against the library and reach no tenant that
holds SOC 2 controls. Invariant 5 refuses exactly that, and a mutation probe
confirmed it.

Each SOC 2 node stands for its whole criteria series, which is how the SOC 2
catalogue uses it: CC7.1 carries the incident-response control. So the pair is
coarse by construction. The file's header names what has no SOC 2 route at
all:

- the requirements on what the agent outputs;
- privacy-specific handling;
- the quarterly independent testing;
- AI disclosure.

Invariant 5 now reads CatalogFile representations through the production
loader. That is what made SOC 2's representation checkable at all, and
AIUC-1's single-row one too.

### ASI06 is reached by RELATED only

AIUC-1 has no requirement on agent memory. So memory and context poisoning
(ASI06) is reached only through tenant separation, run-time input detection
and output monitoring, all `RELATED`. The new unit assertion — AIUC-1 → ASI
must reach all ten risks — accepts that, and the mapping file's header says
it.

### The EU AI Act pair says nothing about applicability

Articles 9–17 bind providers of high-risk systems and Article 26 their
deployers. Article 50 binds certain systems at any tier, and Articles 53 and 55
bind general-purpose model providers. A mapping is a statement about
overlapping obligations. Whether the Act applies is a tenant and counsel
decision, and the file says so.

## Open questions

- **The older agentic reverse files carry the overclaim this change avoids.**
  They were authored with the documented `SUBSET` rule. So their transposes
  hold 19 `SUPERSET` edges, 9 of them in `owasp-agentic-to-iso27001.yaml`.
  ASI03 → A.5.15 is typical: a tenant with an identity-and-privilege control
  for its agents is told that ISO 27001's access-control requirement, for
  every system, is COVERED. Each edge needs its own judgement (some may hold).
  Changing them changes what existing tenants are shown, so it is not done
  here.
- **The ISO 27001 library is a condensed Annex A subset.** It omits A.5.18
  (access rights), A.5.31 (legal requirements), A.5.32 (intellectual
  property), A.8.12 (data leakage prevention) and A.8.16 (monitoring). Those
  would be the strongest routes from ISO 27001 to B007, E012, A007,
  A004 / A006 and B002 / B004 / E009. Until the library carries them, a gap
  analysis from ISO 27001 understates those requirements.
- `performGapAnalysis` still filters on an `assessable` column that does not
  exist (recorded in the 2026-09-05 agentic mapping note). The gap-analysis
  usecase therefore remains unproved against a real database. The per-agent
  coverage path, which these edges also feed, is the one the integration
  test exercises.
