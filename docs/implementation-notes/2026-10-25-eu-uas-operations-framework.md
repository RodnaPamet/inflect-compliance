# 2026-10-25 — EU drone operations: framework, 53 controls, and packs a tenant must choose among

**Commit:** _(stamped post-commit)_ `feat(frameworks): EU drone operations with seven subcategory packs a tenant must choose among`

## Design

The operator's side of EU drone law: Commission Implementing Regulation (EU)
2019/947 as consolidated to Amendment 5 (2024/1110, applicable from 1 May 2025),
plus the operator obligations of the U-space regulation (2021/664). It ships the
way AIUC-1 and COSO do — one framework key, two authoring paths, one row — and
it is the first framework whose packs are a **choice**:

```
src/data/libraries/eu-uas-ops.yaml          51 requirements in 11 sections (A … K)
        │  requirements GENERATED from it
        ▼
prisma/fixtures/eu-uas-ops-control-templates.json
        framework EU-UAS-OPS · 51 requirements · 53 templates · 266 tasks
        packs: EU_UAS_OPEN_A1 · _A2 · _A3 · EU_UAS_STS_01 · _02
               EU_UAS_OPERATIONAL_AUTHORISATION · EU_UAS_LUC
        │  scripts/seed-framework-catalogs.ts (every container start), prisma/seed.ts (dev/E2E)
        ▼
Framework(key = EU-UAS-OPS)  ← library sync leaves a row with packs alone
```

Each pack = the ten controls every operation needs + the controls common to its
category (five for open, seven for specific) + its own. A tenant flying A2 and A3
installs 22 controls; one adding A1 later gets exactly A1's three.

### The choice is required everywhere a pack can be installed

| Surface | Before | Now |
| --- | --- | --- |
| Install wizard, framework with >1 pack | radio, one pack | checkboxes; preview disabled until ≥1 ticked; `POST {packKeys}` |
| `POST /frameworks/:key` | `{packKey}` | `{packKey}` or `{packKeys}` (1–20); `installPacks` refuses empty, unknown, and another framework's pack |
| Onboarding framework step | installed **every** pack of a chosen framework | lists the packs of a multi-pack framework; Continue disabled until ≥1; `completeOnboardingStep` refuses (`assertFrameworkPackChoices`); the install uses only the chosen ones |

## Files

| File | Role |
| --- | --- |
| `src/data/libraries/eu-uas-ops.yaml` | 11 section nodes + 51 requirements; references and titles are the regulation's, descriptions Inflect's |
| `prisma/fixtures/eu-uas-ops-control-templates.json` | CatalogFile with `packs` (7) and `_meta.applicableRequirements` |
| `prisma/catalog-loader.ts` | `packs` (≥2, each naming its templates; exclusive with `pack`; unique keys); `catalogPacks()`; a template no pack names is refused |
| `prisma/catalog-applier.ts` | writes every pack; result gains `packs` (`pack` stays the first) |
| `src/app-layer/usecases/framework/install.ts` | `installPacks` / `previewPacksInstall`; the transaction body is shared with `installPack` and installs a shared template once |
| `src/app-layer/usecases/framework/catalog.ts` | `listInstallableFrameworks` returns each framework's packs; `controlCount` is now DISTINCT templates |
| `src/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts` | `packKeys` on preview and install |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/install/page.tsx` | multi-pack choice |
| `src/components/onboarding/OnboardingWizard.tsx`, `usecases/onboarding.ts`, `usecases/onboarding-automation.ts` | onboarding choice, its server check, and the install of only what was chosen |
| `tests/guardrails/eu-uas-framework-coverage.test.ts` | the enumeration, library↔fixture parity, both directions of pack scope, the content bar |
| `tests/integration/eu-uas-framework-install.test.ts` | both writers on one row; a tenant installs A2+A3, then A1 |

## Decisions

### Cut by subcategory, because that is the axis an operator's work follows

Research found a class label (C2) to be the wrong unit: it is a product attribute,
and the same C2 can be flown in A2, in A3, or — outside the open category — only
under an operational authorisation, because STS-01 and STS-02 require C5 and C6.
So the library's sections and the packs follow the operating subcategory, and the
class requirements appear inside the subcategory controls that depend on them.

### "Governs" is a decision record, and it is checked in both directions

A pack's controls cite only requirements that govern its subcategory, and cite
every one. An A2-only tenant must not see UAS.LUC.030 counted as mapped because a
control it installed happens to cite it, and installing A2 must leave nothing that
binds an A2 operator without a control. The table is held in the guard and the
fixture's `_meta` copy is asserted equal to it. Two consequences shaped controls:
the A1 and A3 competency controls are separate (UAS.OPEN.040(3) borrows A1's exam
by reference, but OPEN.020 does not govern an A3 operator), and the standard
scenarios' shared operations-manual control cites the declaration (UAS.SPEC.020)
rather than each scenario's .030 point.

### Several packs per CatalogFile, not one file per pack

Seven files would each have to repeat the framework and its 51 requirements, and
the shared core would live in seven copies. A `packs` array keeps one source.
Each must name its templates — the single `pack`'s "every template" default would
make each of seven packs the whole framework — and a template no pack names is
refused at load, because with several packs it would seed and reach nobody.

### The choice is generic: any framework with more than one pack

The wizard keys off `packs.length > 1`, not the framework key. Every other
framework ships one pack today, so their flow is unchanged; a future framework
cut into options gets the same required choice without code.

### `controlCount` counts distinct templates

It summed pack links, so the onboarding card would have claimed 151 controls for a
framework of 53. Distinct templates is what a tenant installing every pack gets.

### What was left out, and why

- **The certified category**: certified aircraft, certified operator and licensed
  pilot — manned-aviation regulation, not this pack. Category routing (UAS-CORE-02)
  sends such work to a certified operator.
- **Article 16 model aircraft clubs**, and articles addressed to Member States or
  authorities (17, 18, 21–23).
- **Crosswalks** (to ISO 27001, GDPR, NIS2): a natural follow-up with its own
  ratchet (`mapping-targets-exist`).
- **Requirement scoping by subcategory**: coverage's "mapped %" still counts all 51
  requirements, so an A2-only tenant sees the specific-category sections unmapped.
  Readiness (implemented / gap) counts mapped requirements only and is unaffected.
  Marking the requirements of unchosen subcategories not applicable at install is
  the follow-up.

### Grounding and licensing

Content was written against EASA's Easy Access Rules for UAS (June 2026
revision), which consolidate the regulations with their AMC/GM. EU legislation is
reusable under Commission Decision 2011/833/EU with acknowledgement; every
description and task is nonetheless Inflect's own wording, and figures from AMC
and GM (the 1:1 rule, low-speed mode at 3 m/s, the A3 2-second distance) are
attributed to EASA in the prose. Points the authors could not verify from that
text are worded as operator practice, not law: revalidation alert lead times,
declaration renewal reminders, and the 72-hour report window, which is
Regulation (EU) No 376/2014's rather than 2019/947's. The pending EASA Opinion
06/2026 is tracked in the regulatory-watch task of UAS-CORE-08.

### Authoring

One exemplar (UAS-A2-01) set the bar, then five batches were written in parallel
against a single structure file and a validator encoding the repo's task rules
(imperative verbs, 4–6 steps of 25+ characters, evidence hints, ≥3 phases, no
title reused across the pack) and the COSO/AIUC content bands. One flagged point
was corrected against the source before merge: STS-01 aircraft carry a selectable
low-speed mode capped at 5 m/s (Part 16 of the Annex to 2019/945), so the speed
task configures it rather than relying on technique.
