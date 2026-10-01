# 2026-10-01 — overlay depth, keyboard inset, popover menu keys, left Sheet, Modal focus, pending Confirm

Upstream task T03 of #3003. Tracking issue #3050.

## Design

Two new modules, both ported from playerz `origin/main` and then wired into the
three overlay primitives. Upstream-first: these files are copied back into
playerz byte-identical, so they carry no product vocabulary and no brand names.

### `src/components/ui/overlay-depth.tsx` — ask the tree, don't pass a flag

On mobile, `Popover`, `Modal` and `Sheet` all present as Vaul drawers. A
searchable `Combobox` (a Popover) opened inside a `Modal` therefore mounted a
SECOND drawer on top of the first: two scroll locks, a drag gesture that
dismissed the wrong sheet, an Escape that closed both or neither.

`forceDropdown` was the existing fix, and it is the wrong shape for one: an
opt-out every call site must remember, in a situation the call site frequently
cannot see. Whether a `Combobox` sits inside a `Modal` depends on where the
component was *used*, not how it was *written* — a shared form component has no
idea. There are 95 `forceDropdown` occurrences in `src/` today.

So each overlay that mounts as a drawer wraps its CONTENT (not its trigger) in
`OverlayDepthProvider`, and `Popover` reads `useIsNestedInOverlay()` to present
as a dropdown automatically. `forceDropdown` stays as an explicit override, so
every existing call site keeps working and simply becomes redundant.

The provider wraps content, never the page: a `Popover` elsewhere on the page is
not nested and must still get its bottom sheet. The depth is a counter rather
than a boolean so a sheet in a modal in a sheet still knows.

### `src/lib/hooks/use-keyboard-inset.ts` — `vh` is the wrong viewport

Every overlay caps its height in viewport units (`max-h-[92vh]` on the sheet,
`max-h-[min(85vh,680px)]` on the modal). `vh` is the LAYOUT viewport and does
not shrink when the soft keyboard opens, so a 92vh sheet keeps its full height,
the keyboard slides up over the bottom half, and the field the user just tapped
is behind it. On a 851px Pixel 5 a keyboard is ~340px — nearly half the sheet.

`VisualViewport` knows the difference. `useKeyboardInset()` listens to BOTH its
`resize` (keyboard opens) and `scroll` (browser shifts the viewport to follow
the focused input) events, and subtracts `offsetTop` as well as the height
delta — the hidden region is what lies *below* the visual viewport, not merely
the difference. A 100px threshold keeps a collapsing URL bar from reading as a
keyboard. No `VisualViewport` (older browsers, jsdom) degrades to "no keyboard".

`keyboardAvoidanceStyle()` returns `{}` when the keyboard is closed, so the
component's own CSS governs in the 95% case.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/overlay-depth.tsx` | NEW — depth context + `useIsNestedInOverlay` |
| `src/lib/hooks/use-keyboard-inset.ts` | NEW — `VisualViewport` inset + `keyboardAvoidanceStyle` |
| `src/components/ui/popover.tsx` | nested auto-dropdown, keyboard cap on both surfaces, ONE `Drawer.Overlay`, `bg-opacity-10` → `/10`, `Popover.Menu` roving focus, `data-popover-drawer` |
| `src/components/ui/modal.tsx` | Radix auto-focus restored + `preventAutoFocus` opt-out, keyboard cap + `OverlayDepthProvider` on the drawer, `Modal.Confirm` pending state |
| `src/components/ui/sheet.tsx` | `direction="left"`, keyboard cap merged into the existing `style`, `OverlayDepthProvider` |
| `src/components/ui/tooltip.tsx` | vocabulary only — the JSDoc examples |
| `tests/rendered/overlay-depth.test.tsx` | ported — the context accumulates |
| `tests/rendered/keyboard-inset.test.tsx` | ported + an integration section proving the Sheet surface carries the cap |
| `tests/rendered/popover-nested.test.tsx` | ported — the Popover actually reads the context |
| `tests/rendered/popover-menu-keys.test.tsx` | NEW — arrow / Home / End roving focus |
| `tests/rendered/modal-focus-return.test.tsx` | NEW — focus in, focus back, and the opt-out |
| `tests/rendered/sheet-left.test.tsx` | NEW — left edge, negative transform, right/bottom unchanged |
| `tests/rendered/confirm-dialog-pending.test.tsx` | NEW — spinner, no double submit, reject clears pending |
| `tests/unit/modal-primitive.test.ts` | the two auto-focus source assertions now pin the opt-out, not the defect |
| `tests/unit/sheet-popover.test.ts` | the `direction` union assertion is a set, not one literal sequence |
| `tests/guards/modal-width-tokens.test.ts` | vocabulary only — a docblock example |

## Decisions

- **`Modal` no longer prevents Radix's auto-focus, and that was a defect in both
  halves at once.** `onOpenAutoFocus` AND `onCloseAutoFocus` were both
  `preventDefault()`ed unconditionally, so focus never entered the dialog (a
  keyboard user's next Tab continued through the page behind the overlay, and a
  screen reader announced nothing) and never returned to the trigger on close.
  The reason recorded in the old test name was "so cmdk / filter popovers keep
  focus control" — and neither needs it: the command palette mounts its own
  Radix Dialog with its own `onOpenAutoFocus`, and `Popover` takes both handlers
  as props. The tooltip flicker it also guarded against is handled at the
  source, since `Tooltip` gates its focus-open on `:focus-visible`, so
  programmatic focus does not pop a tooltip. `preventAutoFocus` exists for
  content that genuinely manages focus itself.

- **`Modal.Confirm`'s props doc had promised a pending state since it was
  written, and nothing implemented it.** A confirm wired to a slow DELETE looked
  inert for as long as the request took, and a second click ran `onConfirm`
  again. The fix uses `Button`'s existing `loading` prop, which paints the
  spinner AND sets `disabled`, so the double-submit is closed in the DOM as well
  as by the guard at the top of `handleConfirm`. Cancel is disabled while
  pending, and so is Escape/backdrop (`preventDefaultClose={pending}`) — all
  three would otherwise close the dialog under an in-flight promise. A REJECTED
  promise clears pending and keeps the dialog open, because the alternative is a
  dead button the user cannot retry from.

- **The keyboard style is MERGED into the sheet's existing `style` object, not
  added as a second `style` prop.** JSX keeps only the last `style` and silently
  drops the first, so getting this wrong would have deleted the sheet's own
  `--initial-transform` — a failure invisible to a test that checked only
  `maxHeight`. `keyboard-inset.test.tsx` asserts both.

- **`direction="left"` rather than a new `side` prop.** The brief called it
  `side='left'`, but the prop this file has always had is `direction`, and Vaul's
  own prop is `direction` too. Adding a fourth member to that union is the
  non-breaking change; a parallel `side` prop would be a second way to say the
  same thing. `isSide` widened from `=== 'right'` to `!== 'bottom'`.

- **`--initial-transform` flips sign for `left`.** Vaul slides the panel in from
  its anchored edge along this offset, and the existing code had the SAME
  positive value on both arms of an `isSide` ternary — harmless while both arms
  meant "right". Copied to a left-anchored sheet it would pin the panel left
  while animating it in from the right, travelling the whole viewport.

- **`Popover.Menu` roving focus runs AFTER the caller's `onKeyDown` and stands
  down if the caller claimed the key.** `preventDefault()` is called only once
  an enabled item has actually been found, so an empty menu does not swallow
  arrow keys belonging to the page behind it.

- **`popover.tsx` rendered two `Drawer.Overlay` elements.** The second, after
  `Drawer.Content`, had no className — so the blur applied twice and the stray
  element sat above the content in paint order. Removed. The same file held the
  last `bg-opacity-*` in `src/`, which Tailwind v4 dropped; it is now
  `bg-bg-subtle/10`.

- **`data-popover-drawer` on the drawer surface.** The ported playerz test counts
  `[data-vaul-drawer]`, which only real Vaul emits — inflect's jsdom project maps
  `vaul` to a pass-through stub, so that probe would have counted zero in both
  worlds and asserted nothing. The attribute follows the file's existing
  `data-popover-*` convention and gives E2E a handle too.

- **Test files are NOT in playerz's ui-sync set**, which is
  `src/components/{ui,layout,theme,nav,filters}` plus the vendored `src/lib`
  modules — `docs/ui-sync/inflect-paths.txt` lists zero `tests/` paths. So
  `check-portable` was driven to clean on every changed `src/` file, and on every
  test file this PR creates; it is not used to rewrite the fixtures of
  inflect-specific feature tests that will never be copied.
