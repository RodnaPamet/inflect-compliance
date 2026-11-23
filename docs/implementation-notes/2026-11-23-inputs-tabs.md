# 2026-11-23 — Touch fields at 16px, and a tab strip that shows it scrolls

Mobile roadmap Phase 1, items 3 and 5 (#5812, #5814).

## Design

**Fields at 16px on touch.** iOS Safari zooms the page when a field whose
computed font size is under 16px takes focus. Every field in the product was
14px (`text-sm` on `.input`, `<Input>`, `<Textarea>`) or 12px (`<Input
size="sm">`, the sign-in resend field). One unlayered rule in the existing
`@media (pointer: coarse)` block of `src/app/globals.css` sets `input`,
`select`, `textarea` and an editable `contenteditable` to 16px. Because it is
unlayered it beats every Tailwind utility, which v4 emits inside
`@layer utilities`, and because it is an element selector (0,0,1) a
third-party editor that sizes its own field by class (tldraw's
`.tl-text-input`) keeps its size.

**The scroll-cue strip.** `src/components/ui/scroll-cue-strip.tsx` is a tab
strip that says it scrolls. The detail-page tab bar
(`EntityDetailLayout`) and the processes page's tab bar both use it, and the
processes page no longer keeps its own copy of the bar. It provides:

- an edge fade and a chevron on each side that hides items. It measures on
  scroll, on window resize and with a `ResizeObserver` over the list and each
  item. The fade is a CSS mask over the list, so it needs no colour and works
  on the translucent `--bg-shaded` band. The outer 24px of each fade is fully
  transparent, so the chevron never sits on legible text;
- the active item scrolled into view, instantly on mount and smoothly on a
  change, with `prefers-reduced-motion` turning the smooth scroll into an
  instant one. The scroll is horizontal only (`scrollTo({ left })` on the
  list, never `scrollIntoView`, which also scrolls the page), and it stops
  48px inside the edge so the fade does not cover the item;
- an end spacer while the strip overflows, so the last item can be scrolled
  fully clear;
- with `sticky`, `max-md:sticky` under the 4rem top bar plus the safe-area
  inset, on a separate opaque `bg-bg-page` wrapper.

Prop routing: `className` and `data-testid` go to the outer band. Every other
attribute (`role="tablist"`, `aria-label`, …) goes to the scrolling list, so
the tabs' parent is the tablist.

## Files

| File | Role |
| --- | --- |
| `src/app/globals.css` | The coarse-pointer 16px rule for fields. |
| `src/components/ui/scroll-cue-strip.tsx` | The shared strip. |
| `src/components/layout/EntityDetailLayout.tsx` | The detail tab bar is a sticky `ScrollCueStrip` with the same shaded band. |
| `src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx` | Its copied bar replaced by `ScrollCueStrip`. |
| `messages/{en,bg}.json` | `ui.scrollCueStrip.scrollStart` / `scrollEnd` (chevron labels). |
| `docs/_status/ui-core-classification.json` | Triage entry for the new shared-UI file. |

## Decisions

- **A pointer media query, not `text-base md:text-sm` in each cva.** The zoom
  is a property of touch input, not of viewport width: a narrow desktop window
  keeps 14px, and an iPad gets 16px. One element rule also reaches every field
  that the cva change would miss, with nothing left to remember: the `.input`
  recipe, the ad-hoc inputs on the public questionnaire and shared-audit
  pages, the sign-in resend field, cmdk's search input, the date picker, the
  rich-text editor's markdown textarea and its Tiptap `contenteditable`, and
  any field added later. Desktop rendering is unchanged by construction.
- **Not `!important`.** It would beat tldraw's canvas text field, whose size
  is the canvas zoom rather than a reading size, and the `!`-prefixed Tailwind
  utilities a site might use on purpose.
- **The chevrons are not in the tab order** (`tabIndex={-1}`, but labelled).
  Keyboard users reach every tab with Tab, and focusing a tab scrolls it into
  view natively. The chevrons render outside the tablist so that it holds only
  tabs, plus the processes governance link that was already there.
- **The end spacer is conditional.** An always-present spacer would move an
  `ml-auto` item at the end of a strip that fits (the processes governance
  link) 16px on desktop. Adding the spacer only while the list already
  overflows is stable: it can never be what makes the list overflow.
- **The processes governance link scrolls with the tabs.** Pinned outside the
  strip, it took more than half of a 390px phone's width.
- **Sticky only below `md`.** On a desktop the detail page scrolls inside the
  content column, and the owner decision was about phones.
- **No Phase 0 baseline was lowered.** The issues ask for it, but the mobile
  audit harness and its ratchet (`scripts/mobile-audit/`, Phase 0) are not in
  the repository yet, so there is no baseline to lower.
