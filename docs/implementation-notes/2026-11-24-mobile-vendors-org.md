# 2026-11-24 — Vendors, audits, assets and org pages on a phone; the last small tap targets

**Commit:** see the pull request for #5884 (squashed).

## Design

Issue #5884 listed local phone defects on the vendors, audits, incidents,
assets and org pages. Several were fixed by earlier mobile PRs before this one
started; the rest are fixed here, each at the narrowest seam that removes it:

- **New-vendor form** (`NewVendorFields.tsx`): every row of fields is one
  column below `sm` and keeps its two or three columns from `sm` up.
- **Vendor Overview** (`vendors/[vendorId]/page.tsx`): the ten facts are one
  list (`overviewFacts`). Below `sm` an unset fact is hidden and named once in
  a "Not set: …" line; from `sm` up the two-column grid shows every fact, "—"
  included, exactly as before.
- **Asset criticality in Bulgarian** (`src/lib/asset-criticality.ts`):
  `getAssetCriticality` also returns `level`, the enum member its English
  `label` stands for. The label stays the band's identity (the write path maps
  it to the stored enum); every surface renders `level` through
  `assets.filterEnums.criticality.<LEVEL>`: the form's score box, the detail
  badge, the list cell and the import preview.
- **English accessible names**: the new-risk date picker reads its label from
  the catalogue, and `enrichPolicyHtml` takes the Contents block's title and
  landmark name from the policy page's catalogue (English default for callers
  with no translator). A new lint rule, `local/no-literal-aria-label`, refuses
  a literal `aria-label` in any `.tsx` under `src/` or `packages/ui/src/`; the
  date picker's was the last one.
- **Audit-cycle readiness exports**: the three downloads are a full-width list
  below `sm` and a wrapping row from `sm`.
- **Tap targets the `mobile` E2E ratchet still counted**: the risk score chip
  (`RiskScoreExplainer`) wears the shared `TOUCH_HIT_AREA_CLASS`; the command
  palette's search field carries the bar's vertical padding itself, so the
  field is the bar's full height (47px) and the bar looks the same.
- **Native checkboxes in `src/components`**: the widget picker (org dashboard),
  the treatment-plan milestones (risk detail), the onboarding sovereignty step
  and the card list's selection box are the `Checkbox` primitive.
  `local/no-native-choice-input` now covers `src/components/` and
  `packages/ui/src/`, so a new one fails lint.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/vendors/_form/NewVendorFields.tsx` | rows stack below `sm` |
| `src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx` | Overview facts list, phone "Not set" line |
| `src/lib/asset-criticality.ts` | `level` beside the English identity label |
| `src/app/t/[tenantSlug]/(app)/assets/…` | the four criticality surfaces render the translated band |
| `src/lib/policy/policy-content.ts`, `policies/[policyId]/page.tsx` | translated TOC title and landmark name |
| `src/app/t/[tenantSlug]/(app)/risks/NewRiskModal.tsx` | translated date-picker name |
| `src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/readiness/page.tsx` | exports list on a phone |
| `src/components/risks/RiskScoreExplainer.tsx` | touch hit area on the score chip |
| `src/components/command-palette/command-palette.tsx` | full-height search field |
| `src/components/ui/dashboard-widgets/WidgetPicker.tsx`, `risks/RiskTreatmentPlanCard.tsx`, `onboarding/SovereigntySelfAssessmentStep.tsx`, `ui/card-list/card-list-card.tsx` | `Checkbox` primitive |
| `eslint-rules/rules/no-literal-aria-label.js`, `eslint.config.mjs` | the new rule; the native-choice rule's wider scope |
| `tests/e2e/mobile-ratchet.ts` | `tapUnder24` baseline as measured |

## Decisions

- **The vendor Overview hides unset facts on a phone only.** On a desktop the
  grid's fixed shape is how a reader scans for a field; on a phone a column of
  "—" pushed the description and enrichment data below the fold. The
  contract-renewal row keeps its id, so the calendar's deep link still lands on
  it (it only links when there is a date, which is when the row shows).
- **`label` was not translated in place.** It is the key `criticalityToEnum`
  maps through, and the write path runs on the server with no translator.
  Adding `level` keeps one source for the banding and moves the words to the
  catalogue.
- **The readiness exports are a grid below `sm`, not a menu.** Three downloads
  are the whole content of that card; hiding them behind "⋯" would add a step
  to the card's only purpose.
- **The palette field gets its height from padding, not a coarse-pointer
  minimum.** The bar was already 47px; moving its padding onto the input makes
  the whole bar the field at every pointer with no visual change, where a
  `min-h-11` would have grown the bar on touch.
- **The dashboard's chart marks (#5877) are left to that issue.**
