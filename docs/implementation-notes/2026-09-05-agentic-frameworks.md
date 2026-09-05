# 2026-09-05 — OWASP Agentic AI Top 10 + IMDA MGF as framework content

**Commit:** _(this PR)_ `feat(frameworks): OWASP Agentic AI Top 10 and IMDA MGF as importable frameworks`

## Why

NIST AI RMF, ISO/IEC 42001 and the EU AI Act govern AI as a **content
producer**. Grep them for "agent" or "agentic" and you get nothing: none of
them carries a control set for a system that calls tools, holds delegated
credentials, delegates to other agents, or keeps memory between sessions. A
customer deploying agents has to demonstrate governance and the major
frameworks hand them no requirements to demonstrate it against.

The OWASP Agentic AI Top 10 and the IMDA Model AI Governance Framework are the
two authoritative sources that do. They are complementary rather than
overlapping — OWASP supplies the threat model (what goes wrong), the MGF
supplies the accountability structure (who answers for it). Shipping both is
what lets a tenant run coverage on day one instead of starting at zero.

## Design

Both ship as framework **content** on the existing data-driven library, the
same path as ISO 27001 / NIS2 / AISVS / EU AI Act. No new machinery, no new
Prisma model, no migration, no route:

```
src/data/libraries/<framework>.yaml     authored library (StoredLibrary schema)
  → parseLibraryFile → loadLibrary       validate + index + content hash
  → importLibrary                        Framework + FrameworkRequirement upsert
prisma/fixtures/<framework>.json        seed representation (assessable rows)
  → prisma/seed.ts                       framework + control templates + pack
```

The two representations per framework (library YAML keyed on `ref_id`, seed
keyed on a shorter `key`) are the established repo pattern — see the DORA /
AISVS / EU AI Act blocks in `prisma/seed.ts`. `Framework.key` is `@unique`, so
the two keys must differ or seeding and library-sync fight over one row; the
guard keeps the two key sets in sync at the requirement level instead.

### The identifier is the contract

An assessor citing ASI04 must resolve to the same `FrameworkRequirement` row
forever. Two consequences drove the shape of this PR:

- **The OWASP `ref_id` carries no edition suffix** (`OWASP-ASI-TOP10`, not
  `OWASP-ASI-1.0`). OWASP re-issues Top-10 lists in place. With the edition in
  the key, a revision imports as a *second* framework and every assessment,
  control link and piece of evidence pinned to the first is stranded. Without
  it, the revision is a content-hash update on the same rows —
  `tests/integration/agentic-framework-import.test.ts` proves that by importing
  a bumped, reworded library and asserting the ASI04 row keeps its id.
  The IMDA library keeps `-2026` because IMDA publishes dated editions whose
  content is edition-specific, and because its requirement keys are ours
  (below) rather than a stable upstream numbering.
- **Titles are not pinned by the ratchet, keys are.** OWASP may reword "Agentic
  Supply Chain Vulnerabilities"; that must not turn CI red. Dropping,
  renumbering or adding a risk must.

### OWASP Agentic AI Top 10 — ten assessable rows, flat

One requirement per risk, ASI01–ASI10, no grouping nodes: the published list is
flat and inventing a taxonomy over it would be structure we made up. Each risk
gets one control template in the starter pack (`ASI-01`…`ASI-10`), because here
the risk *is* the assessable unit — unlike AISVS, where 191 requirements roll
up to 12 chapter templates.

License handling follows AISVS exactly (CC-BY-SA-4.0, ShareAlike): the YAML is
a reference **index** — canonical ASI identifiers, short risk titles, and
Inflect-authored governance summaries — never the verbatim OWASP prose, which
stays at the linked canonical source. Facts and identifiers are not
copyrightable; prose is.

### IMDA MGF — what is faithful and what is ours

Stated plainly, because a compliance artefact that overstates its provenance is
worse than one that admits a gap:

- **Faithful:** the four dimensions — bound risks upfront; meaningful human
  accountability; technical controls and processes; end-user responsibility —
  and the three additions of the May 2026 revision: multi-agent systems,
  third-party agents, and automation bias. These are modelled as four grouping
  nodes with every assessable requirement hanging off one of them.
- **Ours:** the decomposition of each dimension into numbered requirements. The
  MGF publishes narrative guidance, not a numbered clause list, so there is no
  upstream identifier to mirror. The `MGF-<dimension>.<n>` keys are
  **Inflect-assigned** — a stable assessment contract, *not* a citation of an
  IMDA clause number. The library `copyright` field says so, and the ratchet
  asserts it still says so, precisely so that a later reader does not quote
  MGF-3.4 back to IMDA as their numbering.
- **Not verified against the published text:** the exact wording and internal
  ordering of the May 2026 revision. Where detail was uncertain we modelled the
  dimension faithfully and wrote the requirement in our own words rather than
  inventing specifics that would read as authoritative.

19 requirements: 5 / 4 / 6 / 4 across D1–D4, one control template per dimension.

## Files

| File | Role |
| --- | --- |
| `src/data/libraries/owasp-agentic-top10.yaml` | OWASP library — 10 assessable risks, ASI01–ASI10 |
| `src/data/libraries/imda-mgf-2026.yaml` | IMDA library — 4 dimensions, 19 assessable requirements |
| `prisma/fixtures/owasp_asi_requirements.json` | Seed representation of the ten risks |
| `prisma/fixtures/imda_mgf_requirements.json` | Seed representation of the MGF requirements |
| `prisma/seed.ts` | Both frameworks + control templates + `OWASP_ASI_BASELINE` / `IMDA_MGF_BASELINE` packs |
| `tests/integration/agentic-framework-import.test.ts` | Real-DB proof of idempotency and in-place revision |
| `tests/guardrails/agentic-framework-coverage.test.ts` | The ASI key-set ratchet + MGF structure + fixture/library parity |
| `tests/guardrails/framework-starter-pack-completeness.test.ts` | Both registered with their starter packs |

## Decisions

- **The ratchet asserts DATA, never prose.** Every claim is checked against the
  loaded library, the fixture JSON, or a computed value. This repo deleted
  `tests/guards/rq3-11-capstone.test.ts` for gating CI on a filename appearing
  in a markdown file; a guard that greps documentation verifies *mention*, not
  accuracy. The "no special-casing in install/catalog" check reads the two
  usecase files but asserts a computed offender array rather than running a
  text matcher over them.
- **Idempotency is proved, not asserted.** The reason for going through
  `importLibrary` rather than writing a seeder is that the path already handles
  content-hash dedupe and in-place revision. A test that only imported once
  would not have shown that. The integration test imports the same file twice
  and compares **row ids**, not counts — a re-created row with the same code is
  still a broken link for anything that referenced the old id.
- **`propagateDelta: false` in the integration test.** Delta propagation is a
  separate, fail-safe subsystem with its own coverage; leaving it on would have
  the import test writing `FrameworkVersionDiff` and per-tenant delta rows and
  failing for reasons that have nothing to do with framework content.
- **Two pre-existing guards were rebound, not exempted.** Adding a second
  OWASP, CC-BY-SA-4.0 framework to `prisma/seed.ts` made three whole-file
  needles in the AISVS and OWASP-privacy guards ambiguous — the Class D
  assertion-reach ratchet firing on a diff that touched no test, which is the
  behaviour it was built for. `/OWASP/` over the whole of `seed.ts` had 54
  satisfying positions and would have stayed green with the block it named
  deleted. Both now bind to `declarationOf(seed, …)`. Baselines lowered by 4
  and 1 in the same diff, as that ratchet's zero drift allowance requires.
- **No mappings and no per-agent coverage in this PR.** Cross-framework
  mappings to the control library and the per-agent coverage query are the
  follow-on stage; `AiSystemRequirementLink` exists but has zero read sites in
  `src/`, so that query has to be written rather than inherited.
