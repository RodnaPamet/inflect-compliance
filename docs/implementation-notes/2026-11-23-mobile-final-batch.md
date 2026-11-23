# 2026-11-23 — Mobile roadmap, last batch: Bulgarian chrome, bulk apply and the home indicator on a phone

**Commit:** see the pull request that closes #5811, #5819 and #5828.

## Design

Three loose ends of the mobile roadmap (#5805), each closed by fixing the
mechanism and adding a test that fails when it comes back.

**English on Bulgarian pages (#5828).** The Phase 0 E2E measured five seeded
routes with English on them. Each leak had one source, and each now goes
through the catalog:

- *Keyboard-shortcut descriptions.* The command palette lists every registered
  shortcut by its `description`, so the description is UI copy. Six call sites
  passed an English literal ("Close navigation drawer" from the phone's nav
  drawer, which is mounted on every page). They read
  `shortcutDescriptions.*` (or the key that already existed, for the drawer).
- *The compliance status indicator.* `ComplianceStatusIndicator` built its
  `aria-label` and chip text from an English token map. It reads
  `complianceStatus.*`; the map keeps its English `label` for callers outside
  a render.
- *The toast host.* `sonner` names its close button "Close toast" and its
  region "Notifications" unless told otherwise; `AppToaster` passes both from
  `toaster.*`.
- *ISO 27001 domains.* The domain strings in `ISO27001_DOMAIN` are the
  taxonomy's grouping, ordering and filter keys and ride the URL, so they stay
  as they are. `controlCategoryLabel` — the one display funnel the browse rail,
  the Category column and the category filter already share — maps a domain to
  `controls.isoDomainLabels.<key>` through `iso27001DomainKey`. Any other
  derived category is a framework's persisted value (tenant data) and passes
  through as stored; the match is exact, so legacy free text such as
  "Business Continuity" is not mistaken for a domain.
- *ISO 27001 theme sections on the framework page.* The leak detector did
  not count them (an all-caps constant is not prose to it), but the framework
  tree, its detail pane and the minimap named the four sections
  "ORGANIZATIONAL / PEOPLE / PHYSICAL / TECHNOLOGICAL" — the stored theme — in
  every language. `frameworkSectionLabel` maps a theme constant to
  `frameworkThemes.*` ("Organizational controls" / "Организационни контроли");
  any section a framework names itself passes through.
- *"Infrastructure" on the risks list* was not product copy: it is the seeded
  risk's legacy free-text `treatmentOwner`, shown in the Owner column when no
  owner account is linked, which happens to equal an asset-type label in the
  catalog. The audit's `dataNames` now includes risks' free-text owners, as it
  already includes tenant, organisation and control names.

**Bulk apply on a phone (#5811).** The toolbar's phone layout shipped earlier;
what was missing is the E2E that drives it. `mobile-bulk-apply.spec.ts`
creates a control in an isolated tenant, ticks its card, checks the action
picker and Apply are fully inside the viewport and at least 44 px tall, sets
the status, taps Apply and reads the control back.

**The home indicator (#5819).** Chromium reports `env(safe-area-inset-bottom)`
as 0, so a drawer with its padding and one without measure the same. The spec
`mobile-safe-area.spec.ts` overrides the inset through the DevTools protocol
(`Emulation.setSafeAreaInsetsOverride`, 34 px), checks the page resolves
`env()` to that value, then asserts for the new-risk modal, the assistant
sheet, the navigation drawer and the user menu that the panel is on screen and
its lowest control (scrolled to the end) ends above the inset. Writing it found
one real gap: a SIDE sheet (`direction="left" | "right"`) was pinned
`bottom-2`, so the phone's navigation drawer ended 8 px above the screen edge,
inside the gesture zone. Side sheets now use
`bottom-[max(0.5rem,env(safe-area-inset-bottom))]`, which is exactly
`bottom-2` wherever there is no inset.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/ComplianceStatusIndicator.tsx` | Chip text and `aria-label` from `complianceStatus.*` |
| `src/components/theme/AppToaster.tsx` | sonner's close-button and region names from `toaster.*` |
| `src/components/layout/MobileNavDrawer.tsx`, `src/components/ui/filter/filter-{select,list}.tsx`, `src/components/ui/SankeyChart.tsx`, `src/components/ui/date-picker/date-range-picker.tsx`, `src/components/risks/RiskScoreExplainer.tsx`, `src/lib/processes/use-canvas-drill-stack.ts` | Shortcut descriptions through the catalog |
| `src/lib/controls/control-taxonomy.ts` | `iso27001DomainKey`: a domain value → its stable key |
| `src/app/t/[tenantSlug]/(app)/controls/filter-defs.ts` | `controlCategoryLabel` labels ISO domains from the catalog |
| `src/lib/framework-tree/section-label.ts`, `src/components/frameworks/FrameworkExplorer.tsx`, `src/components/ui/FrameworkMinimap.tsx` | ISO theme sections labelled from the catalog |
| `src/components/ui/sheet.tsx` | Side sheets clear the home indicator |
| `scripts/mobile-audit/resolve.ts` | Risks' free-text owners are data, not UI |
| `tests/guards/bulgarian-ui-chrome-sources.test.ts` | No literal shortcut description in `src/`; every ISO domain and theme section labels in Bulgarian |
| `tests/rendered/i18n-kept-primitives.test.tsx` | The indicator and the toast host render Bulgarian under `bg` |
| `tests/e2e/mobile-bulk-apply.spec.ts`, `tests/e2e/mobile-safe-area.spec.ts` | The two phone flows above |
| `tests/e2e/mobile-ratchet.ts` | `englishLeaks` baseline to 0 |

## Decisions

- **Translate ISO domains at display time, never in the data.** The values are
  keys in four places (grouping, `ISO27001_DOMAIN_ORDER`, the client-side
  category filter, URL state) and the catalog seed writes them; translating the
  constant would change every one of those.
- **The shortcut check is a source scan, by necessity.** A description is only
  visible once the palette lists it, and the call sites are spread over twenty
  files that each need different props to mount. The scan is an AST walk with
  no allowlist and its own probe that it can see a literal; the indicator and
  the toaster, which can be rendered, are checked by rendering them.
- **The inset is emulated, not inferred from CSS.** Reading the stylesheet for
  `env(safe-area-inset-bottom)` would certify that the text exists, not that
  the footer moves; the protocol override makes the browser lay the page out as
  a phone with a home indicator, and the spec refuses to run if the override
  does not take.
- **Seeded free text is data.** Widening `dataNames` to risks' legacy owners
  is not a UI exclusion: that column is what a person typed, and the detector
  flagged it only because the word is also an English catalog value.
