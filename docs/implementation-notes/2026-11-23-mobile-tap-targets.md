# 2026-11-23 — Mobile tap targets: card titles, text links, choice inputs, small controls

Mobile epic #5868: #5873 (3.3), #5876 (3.6), #5878 (3.8), #5881 (3.11),
#5885 (3.15). One pull request, because all five move the same ratcheted
metric (`tapUnder24`).

## Design

Two shared mechanisms already existed, and every fix uses one of them:

```
TOUCH_HIT_AREA_CLASS            transparent ::after, >= 44x44 on a coarse
(@inflect/ui .../hit-area)      pointer, the control's own box otherwise;
                                the painted control and its line do not move
pointer-coarse:min-h-11 / h-*   the control itself grows on a coarse pointer;
                                for an <input> (no pseudo-element) and for
                                controls packed 4px apart (a hit area would
                                answer for the neighbour)
```

**List-card titles (3.3).** `<DataTableCards>` wraps the title field in a
`TableTitleSurfaceProvider` (`src/components/ui/table-title-cell.tsx`) that
says whether the card is a button (`onRowClick`) or not. `<TableTitleCell>`
and the new `<TableTitleButton>` (the quick-view trigger Controls, Tasks and
Assets each hand-rolled) read it:

```
surface           TableTitleCell href     TableTitleButton
table (default)   link, unchanged         button + truncate, unchanged
card              link + hit area         button + hit area, no truncate
clickable-card    text (span)             text (span), no quick-view
```

The org Controls / Risks / Workspaces tables, Access reviews and the test-plan
list moved their hand-rolled title links onto `<TableTitleCell>`, so the
renderer reaches them too.

**TextLink (3.11, 3.15).** `src/components/ui/text-link.tsx`: `TextLink`
(Next `<Link>`, or `<a>` with `external`) and `TextButton`, styled by the
typography primitives' `textLinkVariants` plus `TOUCH_HIT_AREA_CLASS`. Used for
the stand-alone small links the audit named: auth pages (forgot, register,
resend, back, SSO back), the account and new-workspace back links, dashboard
quick-adds, org initiatives "see all", access-review "change…", the cycle's
hub link, the security-testing header link, the agent's classification link,
the trust-centre public URL, the Entra portal link, the test list's control
link.

**Native choice inputs (3.6).** Every `<input type="checkbox|radio|range">`
under `src/app` (18 sites, not only the six named) is now `Checkbox`,
`RadioGroup` + `RadioGroupItem` or `Slider`, each in a `<label>` row that is
44px on a coarse pointer. Radix's `role="checkbox|radio"` already gets a 44px
`::before` from `globals.css`. `Slider` gained `id` and `ariaLabelledBy` (a
`<label htmlFor>` cannot name its thumb) and the touch hit area on the thumb.
`local/no-native-choice-input` refuses a new one.

**Small controls (3.8).** The toast close button (`toastOptions.classNames`),
`CopyText` and the slider thumb wear the hit area; `NumberStepper` grows to
48px with no inset on a coarse pointer and its field fills the frame (it sat
at 23px); the rich-text toolbar's controls are 44px on a coarse pointer and the
mode toggle's text is 12px.

## Files

| File | Role |
|---|---|
| `src/components/ui/table-title-cell.tsx` | surface context, `TableTitleButton` |
| `src/components/ui/table/data-table-cards.tsx` | declares the title surface per card |
| `src/components/ui/text-link.tsx` | `TextLink`, `TextButton` |
| `src/components/ui/{number-stepper,copy-text,slider,RichTextEditor}.tsx` | touch sizing |
| `src/components/theme/AppToaster.tsx` | close-button hit area |
| `eslint-rules/rules/no-native-choice-input.js` | the lint rule, on in `eslint.config.mjs` for `src/app/**/*.tsx` |
| `docs/new-subsystem-checklist.md` | the 360 px checklist item |
| pages under `src/app` | migrations onto the primitives |

## Decisions

- **A clickable card's title becomes text rather than gaining a hit area.**
  A 44px link inside a 44px+ button is still a control inside a control, and
  on Controls / Tasks / Assets the two did different things (quick-view vs
  open). On a phone the card's own action (open the record) is the one kept;
  the quick-view is a desktop affordance for keeping the list in view.
- **Context, not DOM rewriting.** Neutralising links after render (`tabindex`,
  `pointer-events`, `inert`) either leaves them in the accessibility tree as
  links or hides the title from the card's accessible name. The title
  primitive renders the right element instead.
- **`TextLink` is not for prose.** WCAG 2.5.8 exempts a link inside a sentence,
  and the harness does too; a 44px square around a word would answer for the
  lines above and below. The sign-in form's forgot link lost its `-mt-2` so its
  hit area stays clear of the password field.
- **The stepper grows instead of wearing a pseudo hit area**, because an
  `<input>` renders no `::after`, and an `::after` on its wrapper would take
  the field's taps.
- **The lint rule covers `src/app` only**, as the issue asks. Primitives under
  `src/components` that still use a native checkbox (the widget picker, the
  card-list card, the treatment-plan card, onboarding) are outside it.
