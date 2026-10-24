# 2026-10-24 — Five ISO 27001 Annex A controls join the library, for the AIUC-1 crosswalk

**Commit:** _(stamped post-commit)_ `feat(frameworks): carry five more ISO 27001 Annex A controls and route them to AIUC-1`

## Design

ISO 27001 has two representations in this codebase:

- **The catalogue** (`prisma/fixtures/iso27001-control-templates.json`, key
  `ISO27001`): all 93 Annex A controls, spelled `5.18`. This is the row tenants
  install.
- **The library** (`src/data/libraries/iso27001-2022.yaml`, key
  `ISO27001-2022`): the clauses plus a curated Annex A subset, spelled
  `A.5.18`. Every crosswalk is authored against it, and `mapping-targets-exist`
  refuses any ref the library does not carry.

The library carried 29 of the 93 controls. The AIUC-1 crosswalk (#4060)
therefore could not cite the five controls that are the strongest routes to
several AIUC-1 requirements, and its headers said so. A gap analysis from ISO
27001 understated those requirements.

This change adds the five to the library, as paraphrases in the library's
existing style:

| Control | Library name |
|---|---|
| A.5.18 | Access Rights |
| A.5.31 | Legal, Statutory, Regulatory and Contractual Requirements |
| A.5.32 | Intellectual Property Rights |
| A.8.12 | Data Leakage Prevention |
| A.8.16 | Monitoring Activities |

It also adds 13 edges to each direction of the ISO 27001 ⇄ AIUC-1 pair. Eleven
are INTERSECT and two are RELATED. No new edge is SUBSET or SUPERSET, under the
containment bar the pair already states.

```
tenant control ─ seeded ISO27001 / 8.16
      │  family + spelling reconciliation (8.16 ⇄ A.8.16)
      ▼
library ISO27001-2022 / A.8.16 ──INTERSECT──▶ AIUC-1 B002, B004, B006, E009
                                ──RELATED───▶ AIUC-1 C008
```

## Files

| File | Role |
|---|---|
| `src/data/libraries/iso27001-2022.yaml` | Five Annex A nodes; `version` 2 → 3 |
| `src/data/libraries/mappings/iso27001-to-aiuc-1.yaml` | 13 edges (46 → 59); header no longer says the five are missing |
| `src/data/libraries/mappings/aiuc-1-to-iso27001.yaml` | The exact transpose |
| `tests/integration/framework-inherited-coverage.test.ts` | Tenant D: a control on the seeded `8.16` row reaches five AIUC-1 requirements |
| `tests/unit/framework-representation.test.ts` | Reachable seeded Annex A codes 29 → 34 |
| `tests/guardrails/catalog-requirement-prose.test.ts` | Comments only: 29 → 34 |
| `docs/requirement-mapping-sets.md` | Entry counts and the AIUC-1 edge total (265 → 278) |

## Decisions

### Five controls, not all 93

The library is the reference that crosswalks cite, not the catalogue tenants
install, so it only needs the controls something maps to. Adding the other 59
would add nodes no mapping reaches. Each new control has at least one AIUC-1
edge.

### The version bump notifies tenants on the library row

The importer records a framework diff for a version update that adds
requirements. It tells every tenant with a control linked to an
`ISO27001-2022` requirement that five requirements are new to them. Tenants on
the `ISO27001` catalogue row already hold all 93 controls, so the diff does not
reach them. Nothing about ISO 27001 changed; the notice is about Inflect's
library. That is accurate for a tenant whose installed framework is the
library row, which really did gain five obligations.

### Strengths

An ISO 27001 control governs every system the organisation runs. Each AIUC-1
requirement here asks for something specific to an AI system: a cadence, a
scope, or a mechanism. So meeting the ISO control as written never necessarily
meets the AIUC-1 requirement, and the edges are INTERSECT.

The two RELATED edges are A.5.31 → E011 and A.8.16 → C008. A.5.31 is where the
cross-border transfer rule that E011 names would sit. A.8.16's security
monitoring is where C008 sends its data, but sampling output against a risk
taxonomy is not security monitoring.

### Paraphrases, not ISO text

Each description is our own wording of what the control asks, and each ends
`(Paraphrase)`, as the rest of the library does. ISO's control text is
copyrighted; the library header says it is a structural outline.
