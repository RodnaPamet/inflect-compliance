# 2026-10-08 — the accent seam: focus and the current page stop naming the brand

**Commit:** `(this branch) feat(ui): focus indicators and the active nav band read their own tokens`

## Design

playerz.bg (RodnaPamet/projectZ#362) vendors this repo's UI. Its owner's dark theme fills with
purple and points with yellow: primary buttons, links and the active row's label are purple, while
focus rings, the active-row marker and counts are yellow. Two things in the shared UI made that
impossible with token VALUES alone:

- **Solid focus indicators named the brand.** The Button's two-stop halo
  (`0_0_0_4px_var(--brand-default)`, written twice: the cva base and `button.tsx`'s inert
  `disabledTooltip` branch) and the rings on clickable rows, cards, tree rows and graph nodes
  (`ring-[var(--brand-default)]/40`, `ring-brand-default`, the undo toast's `ring-brand-emphasis`).
  A host could only make those yellow by making every brand fill yellow.
- **The active nav band named the page.** `NAV_ITEM_ACTIVE` paints the band with three
  `var(--bg-page)` stops, a page-tone cut-out (2026-05-13). A host could only colour it by
  repainting its page.

Three tokens, all ALIASES, so Inflect renders exactly as before:

| token | value, both themes | read by |
|---|---|---|
| `--accent-default` | `var(--brand-default)` | Button halo, table / virtual-table / mobile-card / card-list / tree / graph / dropzone / minimap / metric-card focus rings |
| `--accent-emphasis` | `var(--brand-emphasis)` | the undo toast's focus ring |
| `--nav-band-active` | `var(--bg-page)` | the active NavItem's band |

`--ring` and `--focus-ring`, the translucent ring on NavItem, menus and checkboxes, were already
their own tokens and are untouched.

Two accessibility defects surfaced while measuring playerz's palette. Both were in files this change
already touched, so they were fixed in the same diff:

- **The row focus rings were translucent.** `table.tsx`, `virtual-table-body.tsx` and
  `data-table-cards.tsx` drew the ring at `/40`. That measured about 1.7:1 on Inflect's light card,
  about 2.2:1 on its dark one and 2.8:1 on playerz's midnight card, all under WCAG 1.4.11's 3:1 for a
  focus indicator. The rings are now solid (4.18:1 light, 7.26:1 dark, 12.02:1 playerz). This is a
  visible change in Inflect: the keyboard-focus ring on a table region or a mobile card is now the
  full brand colour. `local/no-translucent-focus-indicator` keeps every shared focus ring solid.
- **The active NavItem announced nothing.** It is now `aria-current="page"` on a link row. An action
  row never carries it.

## Files

| file | role |
|---|---|
| `src/styles/tokens.css` | the three aliases, in both theme blocks |
| `src/components/ui/button-variants.ts`, `button.tsx` | halo reads `--accent-default` |
| `src/components/ui/table/{table,virtual-table-body,data-table-cards}.tsx` | focus rings read `--accent-default`, solid (were `/40`) |
| `card-list/card-list-card.tsx`, `TreeViewItem.tsx`, `TreeExpandCollapseToggle.tsx`, `GraphExplorer.tsx`, `FileDropzone.tsx`, `FrameworkMinimap.tsx`, `MetricCard.tsx` (all in `src/components/ui/`) | focus rings read `--accent-default` |
| `src/components/ui/undo-toast.tsx` | focus ring reads `--accent-emphasis` |
| `src/components/layout/nav-item.tsx` | active band reads `--nav-band-active`; an active link row is `aria-current="page"` |
| `eslint-rules/rules/no-brand-focus-indicator.js` | the invariant, scoped to the shared UI |
| `eslint-rules/rules/no-translucent-focus-indicator.js` | focus rings are drawn solid, same scope |
| `packages/ui/tokens.contract.css`, `packages/ui/README.md` | the contract is 47 names |
| `tests/rendered/focus-accent-seam.test.tsx` | resolves the rendered halo against both themes |

## Decisions

- **Aliases, not literals.** `--content-brand` is a literal on purpose (a TEXT token must be
  re-measured when the brand moves). These are the opposite case: their contract is "the same as
  the brand unless a host says otherwise", and a copied hex would silently stop following a palette
  change. The rendered test pins the alias spelling as well as the resolved colour.
- **Not one `--accent` for everything.** The band's Inflect value is the page tone and the halo's
  is the brand. One token cannot alias both without moving an Inflect pixel, so the band gets its
  own name in the existing `--nav-band-*` family, next to `--nav-band-glow-active`.
- **No StatusBadge variant.** playerz's yellow count badge is its own code.
  `status-badge-no-brand` forbids a brand-toned status variant ("status is not brand"), and a
  count is not a status anyway.
- **Every shared focus ring, not only the files playerz vendors today.** The rule is scoped to
  `src/components/{ui,layout}` and `packages/ui/src`, and converting the seven non-vendored sites
  costs one class each. Leaving them would mean an allowlist, and every later vendoring would
  inherit a brand-coloured focus ring. App code outside the shared directories, where Inflect's
  accent is its brand, is out of scope.
- **The contract grows by decision, not measurement.** `tokens.contract.css` declared 45 measured
  names. The two accent names join with brand ALIASES as their fallbacks, so a consumer that never
  overrides them focuses in its brand, as every consumer did before.
