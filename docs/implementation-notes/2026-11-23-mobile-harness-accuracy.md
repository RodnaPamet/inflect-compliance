# 2026-11-23 — The mobile audit harness stops counting what isn't a defect

Issue #5869, part of the mobile epic #5868.

## Design

`scripts/mobile-audit/measure.ts` is the one definition of every mobile metric:
the whole-product audit and the `mobile` E2E project both call it. The
2026-11-23 re-audit found five places where it counted something that is not a
defect. The E2E ratchet's `tapUnder24` baseline included some of them, so a real
fix could be hidden by noise and a real defect could sit under a count that never
moved. Each fix is narrow, and each has a proof in
`tests/e2e/mobile-measure.spec.ts`: one page with the false positive (not
counted) and one with the defect it sits next to (counted).

| | False positive | Fix |
|---|---|---|
| H1 | The localhost/staging environment badge (`text-[10px]`) counted as small text on every page | `textUnder12` skips `[data-testid="top-chrome-env-badge"]` and nothing else; the bell's count badge still counts |
| H2 | The list card's 16px selection circle was measured instead of the 44px wrapper that takes the tap | When an element has `pointer-events: none`, the tap metric measures the nearest ancestor that receives pointer events |
| H3 | Radix puts `tabindex=0` on a RadioGroup root for roving focus, so the root counted as a control | The control population drops focusable group containers (`radiogroup`, `group`, `tablist`, `toolbar`, `menubar`) unless they are native controls; their items are measured instead |
| H4 | A link inside a sentence was exempt only when `display: inline` | A link laid out `inline-flex` or `inline-block` inside a sentence is exempt too |
| H5 | "Button group on 3+ lines" counted stacked form rows and link-pill navigation | A row counts only when every shown child is a button: the button itself, or a wrapper holding exactly one button and no bigger than it |

The English-leak detector (`scripts/mobile-audit/leaks.ts`) gains a fourth input,
`libraryTexts`. The owner decided that the English library the product ships is
content, not interface text. That covers control and policy templates, framework
names and descriptions, requirement titles and sections, ISO clause names, and
the seeded vendor questionnaires. `libraryTexts(db)` in
`scripts/mobile-audit/resolve.ts` reads those values from the library tables, and
a page string that is exactly one of them is not a leak.

## Files

| File | Role |
|---|---|
| `scripts/mobile-audit/measure.ts` | H1–H5, and the docblock's definitions of each metric |
| `scripts/mobile-audit/leaks.ts` | The library exclusion; `optionLabels`, which reads a question's option labels |
| `scripts/mobile-audit/resolve.ts` | `libraryTexts(db)` |
| `scripts/mobile-audit/run.ts`, `tests/e2e/mobile-layout.spec.ts`, `tests/e2e/mobile-support.ts` | Pass the library set to the detector |
| `tests/e2e/mobile-measure.spec.ts` | The metric proofs for H1–H5 |
| `tests/unit/mobile-audit-leaks.test.ts` | The library exclusion, and what it must not exclude |
| `tests/e2e/mobile-ratchet.ts` | Baselines re-measured |
| `docs/mobile-audit.md` | What each metric ignores |

## Decisions

- **Library text is excluded by exact value, never by kind.** No leak reason is
  weakened. A page full of library titles still has its interface strings
  judged, and a unit test holds that.
- **A one-word library value that is also an English catalog message is still
  judged.** A seeded questionnaire option "High" is the same string as the
  severity label "High". A one-word label is far likelier to be the product's
  own, so the detector keeps calling it a leak and the library loses that
  coincidence. A multi-word value ("Risk Management", "Information Security
  Policy") is the library's phrase wherever it appears. This is the rule that
  keeps the exclusion from hiding interface strings, which the owner ruled out.
- **Only library tables are read.** A vendor questionnaire counts as library
  only when it was seeded as a global (`isGlobal`). A tenant's own
  questionnaire, policy text and control edits are tenant data. `dataNames`
  already covers the record names, so this set does not need to.
- **H2 follows pointer events, not the DOM shape of one component.** Any control
  that ignores pointer events is measured by what actually takes the tap. A
  disabled button with `pointer-events: none` is therefore measured by its
  container. That is fine, because a disabled button takes no tap.
- **H4 widens the exemption for links only.** A button laid out `inline-block`
  in a sentence (a "copy" button beside a key) is still a small target. WCAG
  2.5.8's inline exception is about text that flows, and a link styled
  `inline-flex` around an arrow icon still flows.
- **H5 asks "is this row a button group?", not "is it a `nav`?".** A caption or
  a current-page marker among the links (the identity cross-links) makes the
  row a navigation strip. A label around a picker makes it a form row. A
  tooltip or permission wrapper is still a button, so the agent runs page's
  wrapped workflow buttons keep counting.
