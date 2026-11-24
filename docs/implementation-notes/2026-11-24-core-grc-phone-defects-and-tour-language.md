# 2026-11-24 — Core GRC pages on a phone, and the product tour in the reader's language

**Commit:** see the pull request for #5882 (Mobile 3.12) and #5904.

## Design

**The product tour (#5904).** driver.js writes its own chrome in English
("Next", "Previous", "Done", "Close", "1 of 7"), and the step headings and
bodies were English literals in `src/lib/onboarding-steps.ts`. A step now names
a catalogue entry (`messageKey`, a closed union) and carries no words; the
provider reads `onboardingTour.*` through next-intl and hands driver.js every
string as config (`tourChromeText`, `tourStepText`). The progress template keeps
driver.js's own `{{current}}` / `{{total}}`, filled into the catalogue's ICU
`{current}` / `{total}`.

Fixing the words exposed that the tour could not be restarted at all: the
sidebar's "Take the tour" button renders only inside `OnboardingTourProvider`,
and `ClientProviders` (which mounts it) sat inside `AppShell`, around the page
tree only, so the button rendered nowhere while the last step told readers to
use it. `ClientProviders` now wraps `AppShell` in the tenant app layout.

On a phone the button sits in the navigation drawer, a dialog that a tap on the
popover (outside it) would close, taking a highlighted item with it. The button
closes the drawer as the tour starts (`onStart`), and a step never anchors
inside a dialog or inert content, nor on a hidden copy of its anchor (the
desktop sidebar on a phone): it takes the first visible match outside an
overlay, and a step with none is dropped. A phone's tour is therefore its three
centred steps.

The popover's phone fit is unlayered CSS in `globals.css`, keyed on driver.js's
`#driver-popover-content`: width capped at the viewport less 32 px, a wrapping
footer, buttons 32 px tall (44 px on a coarse pointer, as is the close button),
and the theme's colour tokens.

**Core GRC pages (#5882).** Each item was checked against main first:

| Item | State |
| --- | --- |
| Onboarding banner (dashboard; `/tenants` redirects there for one workspace) | already fixed by #5907 (`SettingRow`) |
| Correlations header | already fixed by #5907 (`SettingRow`) |
| Control-templates selection visible and counted | already fixed by #5908 (phone cards, `TemplateInstallDock`) |
| Raw theme enum on the SoA | already fixed by #5902 (`useSoASectionLabel`) |
| Raw theme enum on control templates | the phone cards by #5908; the table column fixed here |
| Loss-events ToggleGroup | fixed here |
| Framework install confirm row | fixed here |
| Framework card titles truncated | fixed here, in the `CardList.CardHeader` primitive |
| Evidence page toast on load | fixed here |

- **Loss events.** The source group's wrapper is a flex item, as wide as its
  content; `min-w-0 max-w-full` caps it at the row, so the ToggleGroup's own
  sideways scroll and edge chevron engage.
- **Framework install.** The step names, the confirm row and the done row wrap;
  the three preview and result figures stack below `sm`; the install cards get
  `density: 'compact'` padding (they were `none`, which renders 0 since #3143);
  the preview rows' codes are narrower on a phone and their counts never wrap.
- **Theme labels.** The control-templates table column reads
  `controls.categoryLabels.*` (and search matches the label too); the framework
  template library's section filter labels a theme constant the same way.
- **Card titles.** `CardListCardHeader` wraps its title below `md`
  (`break-words md:truncate`); a larger screen keeps one line.
- **Evidence celebration.** It fires when the register REACHES all-current
  while the page is open, never on opening a register already current.

## Files

| File | Role |
| --- | --- |
| `src/lib/onboarding-steps.ts` | Steps name catalogue keys, not words |
| `src/components/ui/OnboardingTour.tsx` | Words from next-intl; anchors outside overlays; `onStart` |
| `src/components/layout/SidebarNav.tsx` | The drawer's tour button closes the drawer |
| `src/app/t/[tenantSlug]/(app)/layout.tsx` | `ClientProviders` wraps `AppShell` |
| `src/app/globals.css` | The tour popover's phone fit and tokens |
| `messages/{en,bg}.json` | `onboardingTour` |
| `scripts/mobile-audit/states.ts` | `onboarding-tour` open state for the audit harness |
| `src/app/t/[tenantSlug]/(app)/risks/loss-events/page.tsx` | Source group capped at its row |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/install/page.tsx` | Wrapping rows, stacked figures, padded cards |
| `src/app/t/[tenantSlug]/(app)/controls/templates/page.tsx` | Theme label in the table and search |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page.tsx` | Theme label in the section filter |
| `src/components/ui/card-list/card-list-card.tsx` | Title wraps below `md` |
| `src/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient.tsx` | Icon keeps its size beside a wrapped title |
| `src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx` | Celebrate reaching all-current, not finding it |

## Decisions

- **Every tour string as config, none left to driver.js.** Leaving a default in
  place is how "1 of 7" survived on a Bulgarian page; the rendered test compares
  each string with BOTH catalogues and with driver.js's defaults.
- **Unlayered CSS, keyed on an ID.** driver.js's stylesheet is unlayered and
  loads later, so a layered override would lose whatever its specificity; the
  ID keeps the rules outside the class-keyed scope of the layering guard, which
  protects `className` composition that this DOM never takes part in.
- **No anchor inside a dialog, rather than waiting for the drawer to close.**
  vaul keeps `data-state="open"` through its close animation, so any timing
  rule would race; the structural rule does not, and a drawer's items only
  duplicate the sidebar's.
- **The tour is not in the mobile E2E ratchet's route set.** The ratchet's
  overlay metrics would count the popover itself; the audit harness state is
  the measurement #5904 asks for, and the rendered test holds the language.
- **The celebration change applies at every width.** Finding a register already
  current is not a milestone on a desktop either; a toast on every first visit
  of a session was noise that a phone made visible.
