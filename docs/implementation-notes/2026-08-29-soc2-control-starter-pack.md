# 2026-08-29 — SOC 2 control-template starter pack

**Commit:** `feat(frameworks): SOC 2 gets a control-template starter pack`

## Design

Before this change a tenant that installed SOC 2 got the framework and its
Trust Services Criteria requirements and **nothing else** — no control
templates, so coverage was a permanent bare 0%. SOC 2 was the most-requested
framework in the product and the only major one shipping as an empty shell;
`tests/guardrails/framework-starter-pack-completeness.test.ts` carried a
`BARE_FRAMEWORKS` entry saying exactly that.

The pack mirrors the SSDF Starter Pack end to end and rides the same generic
machinery — there is no SOC 2 special-casing anywhere in the install path:

```
prisma/fixtures/soc2-control-templates.json   29 curated controls, 87 tasks,
                                              35 criterion links
        │
        ▼  prisma/seed.ts  (soc2ReqMap lookup per requirement ref)
ControlTemplate + ControlTemplateTask + ControlTemplateRequirementLink
        │
        ▼  FrameworkPack 'SOC2_STARTER_PACK'  ← PackTemplateLink (code LIKE 'TSC-%')
        │
        ▼  previewPackInstall / installPack / computeCoverage  (unchanged)
Control + Task + ControlRequirementLink  → 100% day-one coverage
```

Coverage of the Common Criteria: CC1 control environment (code of conduct,
board oversight, screening, role accountability) · CC2 communication (policy
set, awareness training, reporting channels) · CC3 risk assessment (annual
assessment, fraud risk, significant-change assessment) · CC4 monitoring
(continuous control monitoring, deficiency register, independent assessment) ·
CC5 control activities (control matrix, segregation of duties) · CC6 logical
and physical access (provisioning/revocation, MFA, access review, encryption,
physical/media, network boundaries) · CC7 system operations (vulnerability
management, logging and alerting, incident response, backup/restore) ·
CC8 change management (software change approval, configuration baselines) ·
CC9 risk mitigation (vendor due diligence, BC/DR).

## Files

| File | Role |
| --- | --- |
| `prisma/fixtures/soc2-control-templates.json` | The 29 curated controls, their categories, frequencies, owner hints, tasks, and criterion refs. |
| `prisma/seed.ts` | Adds CC1.2 / CC4.1 / CC9.1 to `soc2Reqs`, captures `soc2ReqMap`, and upserts the templates + `SOC2_STARTER_PACK`. |
| `prisma/seed-catalog.ts` | Same three criteria, kept in lockstep with `seed.ts`. |
| `src/data/libraries/soc2-2017.yaml` | Adds the missing CC4 (Monitoring Activities) node + CC4.1. |
| `src/lib/controls/control-taxonomy.ts` | `TSC-` joins `CC\d` as a SOC 2 code prefix so the pack's controls group under SOC 2 in the browse rail. |
| `src/data/integrations/aws-posture-control-map.ts` | Framework-note comment listing the seeded criteria, refreshed. |
| `tests/guardrails/framework-starter-pack-completeness.test.ts` | SOC2-2017 moves from `BARE_FRAMEWORKS` to `STARTER_PACKS`. |
| `tests/guardrails/soc2-starter-pack-coverage.test.ts` | Fixture ⇄ criteria resolution, CC1–CC9 span, seed/library/seed-catalog agreement. |
| `tests/integration/soc2-starter-pack-install.test.ts` | DB-backed: preview → install → coverage through the generic usecases. |
| `tests/unit/aws-posture-connector.test.ts` | Hard-coded `IC_SOC2` set updated to the ten seeded criteria. |

## Decisions

- **`TSC-` prefix, not `SOC2-`.** `scripts/backfill-framework-catalog.mjs`
  builds `SOC2_BASELINE` by packing every `SOC2-`-prefixed ControlTemplate.
  Sharing the prefix would make the seed's `startsWith: 'SOC2-'` query and the
  backfill's pack sweep swallow each other's templates. The cost of the
  distinct prefix is that `categorizeControl` no longer recognised the codes,
  so the prefix was added there in the same diff — otherwise 29 new SOC 2
  controls would have landed in the untagged "other" bucket of the browse rail.

- **Three criteria added to the seed, one node added to the library.** The
  seed carried seven criteria; the fixture needed ten. CC1.2 and CC9.1 already
  existed in `soc2-2017.yaml` — CC9.1 was even a mapping TARGET in
  `mappings/iso27001-to-soc2.yaml` with no seeded requirement to resolve
  against. CC4 (Monitoring Activities) was missing from both, and a SOC 2
  starter pack without a control-monitoring and deficiency-tracking control
  would be conspicuously incomplete. These are real AICPA criteria, not
  invented ones; the alternative — writing controls only against the seven
  that existed — would have shipped a pack that cannot reach CC4 or CC9.

- **The guardrail asserts resolution, not shape.** The seed links controls to
  criteria through `if (soc2ReqMap[rk]) { … }`, so a fixture ref the seed does
  not carry produces no link, no error, and a quietly lower coverage number.
  That is the failure this pack is most likely to acquire over time, so the
  guardrail checks every ref against the seed AND the library, checks the two
  lists agree, and checks no seeded criterion is left uncovered.

- **The content warrants human review before customers see it.** The controls
  are written to be specific and implementable and are anchored to criteria
  that exist, but they were authored here, not by a SOC 2 practitioner, and
  they are not a substitute for an auditor's scoping conversation. Treat the
  pack as a strong starting point a customer edits, and get a compliance
  reviewer over the text before it is marketed as audit-ready content.
