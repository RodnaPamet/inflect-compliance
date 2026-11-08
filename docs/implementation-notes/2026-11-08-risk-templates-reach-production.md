# 2026-11-08 — Built-in risk templates reach production

**Commit:** _(stamped post-commit)_ `fix(risks): deliver every built-in risk template to production`

## Design

Every built-in `RiskTemplate` set was an inline array in `prisma/seed.ts`, which a
deploy never runs, so no deployed database received any of them. The FINOS AIGF
set (#5002) was the first with a production writer, which left the New Risk
dialog's template picker in production offering FINOS risks only.

```
prisma/fixtures/risk-templates-{generic,privacy,ssdf,cis,asvs,iso27701,finos-aigf}.json
        │
        ▼
prisma/risk-template-fixtures.ts   RISK_TEMPLATE_FIXTURES + seedRiskTemplates()
        │                                   │
        ▼                                   ▼
scripts/seed-risk-templates.ts      prisma/seed.ts (dev, E2E)
(entrypoint, every container start)
```

83 templates in seven sets, one writer, so dev and production cannot differ.

## Files

| File | Role |
| --- | --- |
| `prisma/fixtures/risk-templates-*.json` | six sets moved verbatim from `prisma/seed.ts`, plus the existing FINOS set |
| `prisma/risk-template-fixtures.ts` | the set list and the one upsert function |
| `scripts/seed-risk-templates.ts` | production seeder, now every set |
| `prisma/seed.ts` | six inline blocks replaced by one call |
| `tests/helpers/risk-template-delivery.ts` | "does this set reach production": entrypoint → bundle → seeder → set list |
| `tests/guardrails/{linddun-privacy-lens,owasp-privacy-risks,ssdf,cis,asvs}-*.test.ts` | repointed from seed source text to the delivered data |
| `tests/unit/risk-template-fixtures.test.ts` | every set, unique ids across sets, legacy generic ids, upsert shape |

## Decisions

- **Moved by evaluation, not by hand.** The six arrays were evaluated out of
  `prisma/seed.ts` and written as JSON, so every id and string is byte-identical
  to what dev databases already hold.
- **The generic set keeps its derived ids.** It never had explicit ids; the old
  seed used the first 25 characters of the slugged title. Those are now written
  into the fixture, and a unit test holds them to the formula, so a database
  seeded before the move is updated in place rather than given duplicates.
- **Upsert now overwrites.** The generic set used `update: {}`; every set now
  brings an existing row back to the fixture. `RiskTemplate` has no edit path in
  the product, so the fixture is the source of truth. A risk created from a
  template is a copy and is never touched.
- **Categories left as they are.** Older sets use `Cybersecurity`, `Privacy`,
  `Cyber Hygiene` and the like, outside `RISK_CATEGORIES`. Changing them is a
  content decision, not part of delivering them.
- **The guards got stronger, not just repointed.** They used to read
  `prisma/seed.ts` source text and could only say "seeded in dev" (two said so in
  their names). They now read the data production receives through a helper that
  checks the whole chain, so a green run means a customer gets the templates.
  Five interior spans and two ambiguous needles left the assertion-reach
  ratchets with it.
