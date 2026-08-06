# 2026-08-05 — Risks surface: dropped edits, an unreachable state, NULL keys

**Commit:** _(see branch `fix/risks-defects-schema-and-nulls`)_

Five verified defects on the Risks surface, plus one on Assets found while
covering the same bug shape (fixed on `main` by #1788 mid-flight — see below).
No refactor — every change is a field, a null policy, or a call target.

## Design

Four of the six share one root cause: **a write path that returns 200 and
discards the write.** Zod's `.strip()` is silent by construction, so a field
missing from an update schema is not a validation error — it is an erasure,
invisible at every layer read in isolation:

```
edit modal ──sends description──▶ route ──▶ UpdateRiskSchema.parse()
                                                    │
                                       .strip() drops it — no error
                                                    ▼
                                          updateRisk(…) — writes the
                                          column it was never given
```

The usecase was correct. The modal was correct. The route returned 200.
Only the schema disagreed, and nothing compared them. `Risk.description`
and `Risk.category` were therefore **write-once-at-create for the entire
product**, and the detail page's Next-Review date picker never persisted.

The same shape, three more times:

- **`SetRiskStatusSchema` omitted `MITIGATED`** while the Prisma enum,
  `BulkRiskStatusSchema` and `RISK_STATUS_VALUES` all had it. The UI offered
  the option (it builds from `RISK_STATUS_VALUES`), the PATCH 400'd, and the
  *identical* transition succeeded via bulk-select on the list page. Four
  hand-maintained copies of one enum; nothing compared them.
- **`threat` / `vulnerability` were unclearable.** Two layers: the schema
  lacked `.nullable()` (so an explicit null 400'd before reaching the
  usecase), and the usecase coerced `null → undefined`, which means "leave
  unchanged". Either alone is sufficient to break clearing. The second layer
  was **not in the roadmap** — the round-trip test found it.
- **`updateAsset` never forwarded `status`** — found while writing the asset
  round-trip test on a branch cut before #1788, and **fixed independently on
  `main` by #1788 while this work was in flight**, so no code for it survives
  in this diff. Worth recording anyway, because it is the sharpest example of
  the argument above: Item 29 added `status` to `UpdateAssetSchema` and to
  `UpdateAssetInput` but not to the `AssetRepository.update` call, so the
  brand-coloured status control returned 200 and changed nothing, and the
  audit row was worse than silent — `changedFields` is derived from the
  *input*, so the log recorded status changes the row never took.
  `tests/guards/item-29-status-buttons.test.ts` asserted the schema
  *mentioned* `status` and was green throughout. The round-trip test is the
  cover that would have caught it, and is kept here for that reason.

The fifth is unrelated in mechanism: AI-accepted and onboarding-seeded risks
were inserted with a bare `db.risk.create`, bypassing `RiskRepository.create`
and its atomic `RSK-N` counter. Those rows got `key = NULL` and a permanently
blank Code column — on the onboarding screen whose whole job is to make a new
tenant's register look populated.

### Why round-trip tests, and why they are the point

Every one of these was invisible to a test that reads one layer. The schema
looked fine. The usecase looked fine. The UI looked fine. The defect lived in
the *disagreement*, so the test has to cross the seam: parse through the real
schema, call the real usecase, read the row back.

`tests/guards/item-29-status-buttons.test.ts` was the cautionary example. It
asserted that the asset status control renders and that the schema mentions
`status` — and it was **green for the entire period the control did
nothing**. A structural guard proves a field is *mentioned*; only a
round-trip proves a value *survives*. That guard has since been retired
(2026-08-05, #1790) and the persistence claim now lives in the integration
test, where it can actually fail.

The new key-minting assertion was verified by reverting the fix and watching
it fail, rather than by inspection.

## Files

| File | Role |
| --- | --- |
| `src/lib/schemas/index.ts` | Adds `description` / `category` / `nextReviewAt` to `UpdateRiskSchema`; makes `threat` / `vulnerability` nullable; adds `MITIGATED` to `SetRiskStatusSchema` |
| `src/app-layer/usecases/risk.ts` | Widens `threat` / `vulnerability` to `string \| null`; stops coercing null→undefined; `emptyToNull` helper so a cleared input stores NULL, not `''`; create-path stores NULL for omitted threat/vulnerability |
| `src/app-layer/usecases/risk-suggestions.ts` | AI-accepted risks create through `RiskRepository` so the key is minted |
| `src/app-layer/usecases/onboarding-automation.ts` | Same, for onboarding-seeded risks |
| `tests/integration/risk-update-round-trip.test.ts` | Write → read back across schema + usecase; five null/clear/preserve contracts |
| `tests/integration/asset-update-round-trip.test.ts` | The same for assets — where this bug shape first shipped, and where it then shipped a second time one layer down |
| `tests/integration/onboarding-automation-runstepaction.test.ts` | Adds the `RSK-N` key assertion to the existing onboarding run |
| `tests/unit/risk-status-enum-parity.test.ts` | Holds all four status lists to the Prisma enum |
| `tests/unit/usecases/risk-suggestions.test.ts`, `tests/unit/onboarding-automation.test.ts` | `riskKeySequence` stub — the cost of routing through the repository |

## Decisions

- **The parity test derives from the Prisma enum rather than asserting
  `MITIGATED`.** Asserting the specific missing value would pass again the
  moment a sixth state is added to three lists and not the fourth. The
  schema is the source of truth; the other three lists are held to it.
- **`''` maps to NULL for `category` and `treatmentOwner`, but not for every
  field.** A cleared form input sends `''`, which renders identically to NULL
  but sorts, filters and compares differently. `ownerUserId` already did this
  (an empty string is an invalid FK); the fix extends it to the text columns
  that a form can clear, and leaves the three-state contract
  (`undefined` = unchanged, `null`/`''` = clear, string = set) explicit.
- **`title` keeps `?? undefined`.** It is non-nullable in the schema, so
  coercing null away is correct there — the two adjacent lines look
  inconsistent on purpose. This is called out in the code, since the
  original defect was precisely that these two policies sat two lines apart
  with no explanation.
- **The mock-db stubs are a real cost, and worth it.** Routing creates
  through the repository broke five fake-db call sites that had no
  `riskKeySequence` table. That is the honest price of not letting usecases
  hand-roll inserts, and the alternative — duplicating key minting at each
  create site — is how the bug happened.
- **The asset round-trip test is kept even though its bug is already fixed.**
  #1788 fixed `updateAsset` on `main` while this branch was in flight, so the
  code change collapsed on rebase. The test stays: the defect has now been
  introduced at two different layers of the same path, and nothing else in
  the suite would notice a third.
