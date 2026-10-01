# 2026-10-01 — display and feedback primitives: touch target, text-safe links, route-local dashboard shell

**Issue:** #3049 (upstream task T05 of #3003)

## Design

Seven independent defects in `src/components/ui/**`, grouped because the
files are vendored downstream byte-identical and each one would otherwise
force a local divergence there. Two of them are worth reading before
touching the files again.

### `button.tsx` has three render paths, and two of them are `cn`-only

```
disabledTooltip ──► <div>            cn(...)            ← no cva
disabled|loading ─► <button disabled> cn(...)           ← no cva
otherwise ────────► <button>          buttonVariants()  ← the cva recipe
```

Anything the cva base carries is therefore ABSENT from the first two
unless restated, and two things were: `pointer-coarse:min-h-11` (the
WCAG 2.5.5 / Apple HIG 44px touch floor) and `relative` +
`HIT_AREA_CLASS`. The visible consequence was the first one: a button
44px tall on a phone collapsed to its 28px desktop height the instant
`loading` went true — exactly while the user is most likely to tap it
again.

The existing mirror check in
`tests/guards/still-surface-button-material.test.ts` counts occurrences
of the 28px height rung across the file, which is the part that is
SUPPOSED to be 28px, so it could not see this. The restated classes now
live in one `INERT_BUTTON_SHELL` constant and
`tests/guards/mobile-touch-targets.test.ts` asserts both references
exist by exact count.

### The route-local / primitive split for skeletons

`DashboardSkeleton` — the compliance dashboard's loading shell — moved
out of `src/components/ui/skeleton.tsx` to
`src/app/t/[tenantSlug]/(app)/dashboard/DashboardSkeleton.tsx`.

The rule the move draws: **a skeleton whose correctness depends on ONE
route lives beside that route; a skeleton whose correctness depends only
on geometry lives in the primitives module.** `DashboardSkeleton` is a
tracing of one page's sections in that page's order, and the only thing
that can tell you it has gone stale is the page it sits next to. Keeping
it in `skeleton.tsx` meant the module defining "what a loading bar looks
like" also hard-coded this product's dashboard IA, so every consumer of
a plain `<Skeleton>` imported a file that knew about posture heroes and
evidence expiry.

`SkeletonDashboard` — one transposition away in the name — is the
generic list-dashboard shell the risks/controls/vendors pages share and
stays a primitive. Both guards and the rendered test assert BOTH facts,
because either alone is satisfiable by the wrong state.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/button.tsx` | `INERT_BUTTON_SHELL` restates the cva base's touch floor + hit area on both `cn`-only branches; the `disabledTooltip` wrapper becomes focusable with `aria-describedby`, and `aria-labelledby` keeps the reason out of the accessible name; `LoadingSpinner` imported by module path |
| `src/components/ui/button-variants.ts` | neutral header stating the `--brand-secondary-default` requirement; secondary's hover LABEL moves to `text-content-brand` (the EDGE keeps the fill token) |
| `src/components/ui/typography.tsx` | `TextLink` brand/link/default tones on `text-content-brand`, hovering to `text-content-emphasis` |
| `src/components/ui/initials-avatar.tsx` | initials on `text-content-emphasis` over the brand tint |
| `src/components/ui/error-state.tsx` | `renderSecondary` honours `secondaryAction.href`, mirroring `<EmptyState>`'s renderer |
| `src/components/ui/skeleton.tsx` | `DashboardSkeleton` + its two card helpers removed (110 lines) |
| `src/app/t/[tenantSlug]/(app)/dashboard/DashboardSkeleton.tsx` | new home, composing the primitives |
| `src/app/t/[tenantSlug]/(app)/dashboard/loading.tsx` | imports the sibling module |
| `src/components/ui/icons/loading-spinner.tsx` | `animate-pulse` + delays restaggered to its 2s cycle |
| `src/components/ui/icons/loading-circle.tsx` | semantic tokens for the track and the arc |
| `src/components/ui/toggle-group.tsx` | `capitalize` dropped |
| `src/components/ui/hooks/use-toast.ts` | the locked duration is forwarded on every call |
| `src/components/ui/{card,card-variants,status-badge,empty-state,breadcrumbs,undo-toast,hit-area}` + 3 hooks | product vocabulary and brand names out of the prose |

## Decisions

- **`animate-pulse`, not a new `spinner` keyframe.** `animate-spinner`
  resolved to nothing — no `spinner` entry in `tailwind.config.js`
  keyframes or animations, no `.animate-spinner` rule in `globals.css`,
  and the same hole downstream. Declaring the keyframe would have fixed
  the symptom in this repo and left the vendored copy still inert, since
  `tailwind.config.js` is not a vendored file. `animate-pulse` is a
  Tailwind built-in, so it resolves wherever the component lands, and it
  is already this repo's canonical loading animation.

  `animate-spin` was the other option the brief offered and is wrong
  here twice over: the twelve bars sit at 30° intervals, so the figure
  is twelve-fold symmetric and rotating it is invisible — and `spin`'s
  keyframes animate `transform`, which would override each bar's inline
  `rotate(...) translate(...)` placement and collapse all twelve onto
  the centre. The staggered per-bar opacity fade IS the spinner.

- **The secondary button's hover EDGE keeps `--brand-default`; only the
  LABEL moved.** Different WCAG floors apply: 1.4.3 asks 4.5:1 of text
  (which `--brand-default` fails on the light theme at ~4:1), 1.4.11
  asks 3:1 of a control boundary (which it clears). Moving the border
  too would also have broken the reciprocal hover trade that
  `still-surface-button-material.test.ts` and
  `cva-primitives.test.ts` both pin.

- **`aria-labelledby` on the `disabledTooltip` wrapper is not
  decoration.** Radix's Trigger takes a single child, so the
  `aria-describedby` target has to live INSIDE the element it describes
  — and the accessible name of a `role="button"` is computed from its
  contents, which folds the reason into the name and announces it twice.
  Naming the label explicitly confines the name to the label. The
  attribute is omitted when there is no label, so an icon-only button
  falls back to the contents algorithm rather than resolving to an empty
  name.

- **`aria-disabled`, never `disabled`.** A real `disabled` attribute
  removes the element from the tab order, which is the defect rather
  than the fix.

- **The `use-toast` comment was load-bearing and wrong.** It said the
  `<Toaster>` mount's `toastOptions` set the default duration per
  variant. `providers.tsx` mounts `<Toaster … duration={3000} />` and
  has no `toastOptions` key at all, so on the single-argument call three
  of the four documented durations were fiction and `error` —
  documented as `Infinity`, sticky-until-dismiss — auto-dismissed after
  three seconds. The same comment warned that forwarding
  unconditionally would break "test mocks that assert
  `toast.success(message)` with a single argument": measured across
  `tests/` and `src/`, there are zero such assertions (three sites read
  `toast.error.mock.calls[0]` and destructure, which is unaffected).
