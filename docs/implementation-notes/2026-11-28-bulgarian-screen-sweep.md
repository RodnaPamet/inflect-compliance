# 2026-11-28 — Bulgarian screen sweep

**Commits:** the `claude/i18n-screen-sweep` branch (#5996).

## Design

With every catalogue string translated (#6003–#6007), the remaining English
a Bulgarian reader could meet was interface text. That text is held by three
populations, and each needed its own search:

1. **The message files.** `messages/bg.json` has every key `en.json` has. The
   sweep looked for values with no Cyrillic. Almost all of them are names or
   codes that rightly stay Latin, and the rest were fixed.
2. **Hardcoded strings the i18n adoption ratchet still budgets.** The sweep
   listed them with the ratchet's own detector and fixed every one a reader
   sees.
3. **Text built where no scanner looks.** Examples: template-literal
   `aria-label`s, `resourceName` noun callbacks, raw enum codes and
   server-built titles. The sweep found these by rendering the product. It
   took a production build of the branch, seeded as the E2E job does, and
   crawled every static route plus every page linked from them in Bulgarian.
   That came to 218 pages, each with the catalogue translations settled before
   its text, placeholders, `aria-label`s and titles were read.

## Files

| File | Role |
|---|---|
| `src/lib/content-i18n/use-content-text.ts` | Does not re-send a text whose lookup is already on the wire. |
| `src/components/ui/FreshnessBadge.tsx`, `filter/*`, `DonutChart`, `TreeView`, `GraphExplorer`, `FrameworkMinimap`, `FrameworkBuilder`, `selection-summary-panel`, `ai-assist-rail` | Shared labels, empty states and badge text through next-intl. |
| `.../calendar/_components/CalendarMonth.tsx` | Day-cell label uses `calendar.eventCount`. |
| `.../reports/ReportsClient.tsx`, `.../frameworks/FrameworksClient.tsx` | ISO Annex A themes by name; coverage bars' accessible names translated. |
| `.../access-reviews/[reviewId]/AccessReviewDetailClient.tsx`, `findings/FindingsClient.tsx`, `LinkedTasksPanel.tsx` | Table nouns through messages. |
| `NewAiSystemModal.tsx`, `ClassifyAiSystemModal.tsx`, `NewAgentModal.tsx` | EU AI Act options through `euAiActOptions`. |
| `src/app-layer/usecases/audit-readiness/scoring.ts` | A gap for a control with no code is titled by its name. |
| `messages/{en,bg}.json` | New keys; interface terms aligned with the content decisions. |

## Decisions

- **The translation store tracks lookups in flight.** Each answer re-renders
  every reader, and on that render the texts of the batches still to come were
  queued and sent again. The templates page sent 85 requests in 30 seconds and
  kept going. That could spend the 120-a-minute read budget before the last
  batch went out, leaving its texts in English. A rendered test now sends more
  than two batches' worth of texts and asserts each is sent exactly once.
- **Interface terms follow the project lead's content decisions.** The
  2026-11-27 decisions said the interface would be aligned separately:
  - „Точка“ for an ISO clause (the „Клаузи“ page and its labels);
  - „система с ИИ“, not „ИИ система“;
  - „опис“, not „инвентар“;
  - „неразрешен“, not „неоторизиран“.

  "Clause" in a legal sense, such as standard contractual clauses, keeps
  „клауза“.
- **The EU AI Act options' English labels are generated from the
  classifier's list.** `tests/unit/eu-ai-act-option-labels.test.ts` holds
  them to it, so the wording a reader picks from cannot drift from what the
  classifier decides on.
- **No `t.has()` in the new code.** Most local next-intl test mocks lack it
  (see `entity-prev-next-nav.tsx`), so known code sets are explicit.
- **What stays English, on purpose:**
  - framework and product names (decided with the headings);
  - example-value placeholders (domains, URLs, CPE strings);
  - configuration keys and environment-variable names;
  - Microsoft's "Service principal" (owner decision 2026-10-30);
  - text a workspace wrote or adopted, such as a policy's body or an edited
    control.
- **What the crawl does not cover.** It renders pages; it does not open
  dialogs, submit forms or trigger toasts. Dialog strings were covered from
  the ratchet's list and by reading the dialogs that list catalogue options.
