# 2026-08-20 — Localise the record stepper (prev/next entity nav)

**Commit:** `wip(fix/localize-record-stepper)` — see the branch's squashed commit.

## Design

`<EntityPrevNextNav>` built its a11y label, its tooltip and its
keyboard-shortcut description in source:

```ts
step(prevId, 'up', `Previous ${labelSingular}`)
```

so a fully Bulgarian detail page still announced "Previous policy" over the
stepper — including in the command palette's shortcut list, which never
reaches the DOM and so was invisible to every rendered assertion.

The fix resolves whole PHRASES from the catalog rather than interpolating an
adjective into a noun:

```
ui.recordStepper.previous.<entity>
ui.recordStepper.next.<entity>
```

with `item` as the fallback entry. The component does
`t.has(key) ? t(key) : t('<direction>.item')`, mirroring the existing
`AutomationSuggestionsRail` lookup shape.

**Why whole phrases and not `"Предишен {entity}"`.** Bulgarian adjectives
agree in gender with the noun. Five of the seven entities the detail pages
pass are masculine (актив, контрол, инцидент, риск, доставчик) but *policy*
(политика) and *task* (задача) are feminine, so one interpolated template
renders "Предишен политика" / "Предишен задача" — ungrammatical, and a bug a
naive single-key implementation would ship looking correct in English. The
per-entity phrase also leaves every future locale free to reorder or decline
the pair however its grammar requires.

**Why the task noun is not `nav.tasks`.** That key is `План` — a repurposed
sidebar label meaning *Plan*. Wrong word and wrong gender. The stepper's
noun derives from `common.sections.tasks` (*Задачи*) in the singular:
*задача*.

## Files

| File | Role |
|---|---|
| `src/components/ui/entity-prev-next-nav.tsx` | Resolves both labels + both shortcut descriptions from `ui.recordStepper`; `labelSingular` is now a catalog KEY, not a display noun |
| `messages/en.json` / `messages/bg.json` | New `ui.recordStepper.{previous,next}.<entity>` phrase pairs for the seven entities plus `item` |
| `tests/guardrails/i18n-adoption-ratchet.test.ts` | The component left `UNMIGRATED_BASELINE` (it now imports `useTranslations`) |
| `tests/rendered/entity-prev-next-nav.test.tsx` | Per-entity, per-direction bg/en label assertions + a shortcut-registry probe for the non-DOM descriptions |
| `tests/rendered/entity-detail-prev-next-prop.test.tsx` | Proves the entity key survives the `EntityDetailLayout` composition |

## Decisions

- **No prop-shape change to `EntityDetailLayout`.** Callers already pass the
  lowercase entity slug (`'asset'`, `'policy'`, …), which is exactly the
  catalog key, so `labelSingular` changed meaning without changing type or
  any call site. Seven detail pages stayed untouched.
- **Local, memoised `next-intl` mock in both rendered suites.** The repo-wide
  `__mocks__/next-intl.js` is pinned to `messages/en.json` (half of what is
  under test here is the bg rendering) and returns a fresh `t` per render,
  which makes a consumer that feeds `t` output into a hook dependency
  re-register forever — the suite TIMES OUT instead of failing. One `t` per
  (locale, namespace) removes both hazards.
- **The shortcut descriptions are asserted through the registry, not the
  DOM.** `useKeyboardShortcut`'s `description` only surfaces in the
  command-palette help list, so a DOM-only suite would have gone green with
  half the English still in place.
