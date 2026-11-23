# 2026-11-23 — Page header on a phone: primary + "⋯", one way back, translated back links

**Commit:** see the pull request for #5815 / #5822 / #5823 / #5830.

## Design

Three shared primitives change; pages only mark intent.

**Header actions (`PageActions`, #5815).** Below `md` the cluster shows the
actions a page left unmarked as buttons, and every action wrapped in
`<OverflowAction>` becomes an item of a labelled "⋯" menu (the `Popover`
primitive's `Menu`/`Item`; a phone opens it as a bottom sheet).

```
<PageHeader actions={<>
  <PrimaryAction><Button>Amend</Button></PrimaryAction>      visible, first on a phone
  <OverflowAction label="Use for Ask" onSelect={…}>…</OverflowAction>   "⋯" on a phone
  <OverflowAction label="Connect" onSelect={…}>…</OverflowAction>       "⋯" on a phone
  <OverflowAction label="Open on canvas" href={…}>…</OverflowAction>    "⋯" on a phone
  <AgentKillSwitchAction />                                  visible, destructive
</>} />
```

Each `OverflowAction` registers itself with the nearest `PageActions` through
context (so it works through wrapper components and permission gates), and
renders its desktop form inside `hidden md:contents` — on desktop it is the
same button, in the same place, as a direct flex item. The menu sorts entries
by the document position of those slots, i.e. source order. `PrimaryAction`
adds `max-md:order-first`. The cluster wraps forwards below `md`
(`flex-wrap md:flex-wrap-reverse`), left-aligned below `sm`; `PageHeader` is a
column below `sm`, so the title is full width with the actions under it. A
single plain `<div>` child of `PageActions` that only lays its children out
(no other prop, only flex/gap/alignment classes) is unwrapped, so a page's own
non-wrapping `flex` wrapper can no longer make the group one clipped item; a
div that is a box in its own right (the admin page's theme chip) is kept.

**One way back (#5822).** `phoneShowsBackLinkOnly(pathname)`
(`src/lib/nav/mobile-wayfinding.ts`) is true on every subpage that owes a back
affordance. There `PageHeader` and `PageBreadcrumbs` render no inline (phone)
trail. They ask a slot, `PhoneBreadcrumbsPolicy` in `breadcrumbs-store.tsx`
(default: show the trail), and the tenant app fills it with
`<PhoneWayfindingPolicy>` from `ClientProviders`; the back link, which every subpage mounts first above its title, is the
only way back, in one place. The trail is still pushed to the top chrome, so
desktop is unchanged. Main pages and the exempt subpages keep their inline
trail. The back link gets `TOUCH_HIT_AREA_CLASS` (#5847); breadcrumb links,
which `truncate` and so would clip a pseudo-element, get 44 px through
touch-only padding and an equal negative margin.

**Translated back links (#5823).** `PARENT_MAP` stores `labelKey`, a closed
`BackLabelKey` union of keys under `common` (`sections.*`, plus the new
`parentLabels.*`), and `resolveBackDestination` takes `labelForKey` to localise
it. The referrer-derived section map moved to `canonical-parents.ts`
(`SECTION_LABEL_KEYS`), gained `/agents` and four other sections, and an
unknown section now reads "previous page" instead of the raw URL segment.

## Files

| File | Role |
|---|---|
| `src/components/layout/PageActions.tsx` | Overflow registry, "⋯" menu, `OverflowAction`, `PrimaryAction`, wrapper unwrap |
| `src/components/layout/PageHeader.tsx` | Column below `sm`; no inline trail on a back-link subpage |
| `src/components/layout/PageBreadcrumbs.tsx` | Same rule for pages that mount the trail directly |
| `src/components/layout/breadcrumbs-store.tsx` | `PhoneBreadcrumbsPolicy` slot; content key tolerates a ReactNode label |
| `src/lib/nav/mobile-wayfinding.ts` | `phoneShowsBackLinkOnly` |
| `src/components/nav/PhoneWayfindingPolicy.tsx`, `src/components/layout/ClientProviders.tsx` | The tenant app supplies the rule to the slot |
| `src/lib/nav/canonical-parents.ts` | `labelKey`, `BACK_LABEL_KEYS`, `SECTION_LABEL_KEYS` |
| `src/lib/nav/back-destination.ts` | `BackDestination`, `labelForKey` |
| `src/components/nav/BackAffordance.tsx` | Localised keys, "previous page" fallback, touch hit area |
| `src/components/ui/breadcrumbs.tsx` | Touch hit area on crumb links |
| `src/components/test-plans/TestPlanDetailView.tsx` | Hand-rolled header → `PageHeader` (#5830) |
| agent detail, framework detail, BIA, audits hub, NIS2 gap, vulnerabilities, access-review detail | Marked primary / overflow; page wrappers removed |

## Decisions

- **Explicit marking, not variant guessing.** Whether an action can wait behind
  a menu is a decision about the page. A `secondary` button is the primary
  action on several pages (re-run, close campaign).
- **Overflow actions are data plus their desktop node.** The menu item calls
  the action's handler; the desktop button is the page's own element, hidden
  below md. Rendering the same element in the menu would duplicate component
  state, and a modal owned by a component inside a closing menu would unmount.
- **A destructive action is never an `OverflowAction`.** The agent's kill switch
  moved from a red-tinted ghost to the destructive variant on all sizes — the
  owner named the ghost as a defect, and a button's tone should not depend on
  the viewport.
- **The phone-trail rule is a slot, not an import.** `PageBreadcrumbs` is shared
  UI recorded GENERIC; importing the product's route registry into it is a
  `domain-import` the shared-UI ratchet refuses. The host supplies the rule.
- **No shell-level back bar.** Every subpage already mounts its back link first,
  so removing the phone trail on subpages gives one way back in one place
  without a new slot in the app shell (where the top-bar batch is working).
- **Access-review detail on desktop is now one row** (progress, evidence actions,
  close) rather than two stacked rows; the nested rows were what clipped on a
  phone.
- The Phase 0 mobile ratchet the issues ask to lower is not on `main` yet, so
  there is no baseline to lower in this change.
