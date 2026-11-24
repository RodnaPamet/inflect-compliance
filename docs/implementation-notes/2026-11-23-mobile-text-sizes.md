# 2026-11-23 — Small text is 12 px; the plus glyph gets its gap back

Mobile epic #5868, Phase 3 shared causes: #5871 (status badges), #5872 (KPI and
meta-strip eyebrow labels), #5880 (the "+" glued to its label).

## Design

Three primitives were the shared cause of most pages the re-audit counted under
"text < 12 px", and one copied class was the cause of every "+Одит":

- `StatusBadge size="sm"` was `text-[10px]`. It is now `text-xs` (12 px). `sm`
  and `md` now differ only in padding. 147 call sites pass `sm`, and MetaStrip's
  status items pass it too; none of them changes.
- The KPIStat eyebrow label and the MetaStrip label were `text-[11px]`. Both are
  `text-xs`, keeping `uppercase tracking-wide`. A MetaStrip `metric` item renders
  a KPIStat, so the two labels stay one size.
- Thirty-one buttons rendered `<Plus className="-ml-0.5 -mr-2.5" />` in the
  Button's `icon` slot. The slot is spaced from the label by `gap-tight` (8 px);
  `-mr-2.5` (-10 px) cancelled it and overlapped by two pixels. The margins are
  gone, and `local/no-negative-margin-icon` refuses a negative margin on any
  element imported from `lucide-react` or an `icons` module.

The owner decided 12 px everywhere (2026-11-23), so none of this is gated
behind a breakpoint: desktop gets the larger badges and labels too.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/status-badge.tsx` | `sm` is 12 px |
| `src/components/ui/metric.tsx` | KPIStat label is 12 px |
| `src/components/ui/meta-strip.tsx` | MetaStrip label is 12 px |
| 26 files under `src/app` and `src/components` | `<Plus />` without the negative margins |
| `eslint-rules/rules/no-negative-margin-icon.js` | the rule |
| `eslint-rules/__tests__/no-negative-margin-icon.test.ts` | RuleTester, valid and invalid |
| `eslint.config.mjs`, `eslint-rules/index.js`, `eslint-rules/README.md` | registration, wiring at `error`, the rule's entry |
| `tests/guards/eslint-local-rules-wired.test.ts` | the rule is wired at `error` |
| `tests/rendered/small-text-floor.test.tsx` | no badge or eyebrow label under 12 px |

## Decisions

- **`text-xs`, not `text-[12px]`.** The named step is the scale's own 12 px and
  carries its own line height, where the arbitrary `text-[10px]` / `text-[11px]`
  set none and took the parent's. A badge's height now depends on its size, not
  on the row it sits in. At 360 px the meta strips, KPI grids and list cards
  wrap as before; nothing new clips or wraps badly.
- **The rendered test reads the size utility and converts it to pixels**, rather
  than asserting a class name. Swapping `text-xs` for `text-[12px]` or
  `text-sm` stays green; any utility under 12 px, or no size utility at all
  (an inherited size is not a floor), goes red. With conflicting utilities it
  judges the smallest.
- **The rule names icons by their import, not by a list of names.** Anything
  bound from `lucide-react` or a specifier with an `icons` path segment is an
  icon, so a new glyph is covered the day it is imported. A negative margin on a
  non-icon (the combobox's `Command.Separator -mx-1`) is untouched: it is a
  full-bleed divider, which is what a negative margin is for.
- **The margins were dropped, not the sites rewritten.** Every one of the 31
  already passed the glyph through `icon={…}` with a bare noun, except the
  policy page's "Version" button, a raw `<button>` styled with `buttonVariants`,
  whose `gap-tight` spaces a child glyph the same way.
