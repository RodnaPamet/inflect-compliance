# 2026-11-24 — Agents and admin pages on a phone (#5883)

## Design

The local phone defects on the agents and admin pages that the shared
primitives of the earlier batches did not reach. Each is fixed at its cause:

- **A spacing class that is not a token.** The joiner-passes page (and the
  write journal beside it) used `space-y-comfortable`. The scale has five names
  (tight, compact, default, section, page); Tailwind emits nothing for a class
  it does not know, so the page had no vertical rhythm at all and its intro ran
  straight into its buttons. Both now use `space-y-section`, and the spacing
  guard refuses any word-suffixed `gap` / `space-x` / `space-y` that the scale
  in `tailwind.config.js` does not define.
- **The browser's file input.** It draws "Choose File" / "No file chosen" in
  the browser's language at a width no stylesheet can shrink, so the trust
  center's gated-documents section was forced wider than a phone. A new shared
  `<FilePicker>` keeps the native input only to open the dialog (visually
  hidden, out of the tab order) behind a real `Button`, with the chosen file's
  name beside it; the row wraps and the name breaks anywhere.
- **The product's words shown raw.** The risk-matrix editor's preview drew the
  draft config as stored, so the default band and axis names were English on a
  Bulgarian page; it now goes through `localizeRiskMatrixConfig`, the display
  path every other matrix uses, while the editor's fields keep the stored
  values a save writes. Its band rows were one twelve-column line, which cut a
  band's name to four letters on a phone; below `sm` they now take three lines. The SCIM role-mapping note spelled six role names
  inside its sentence; they are now values from the `roles.*` vocabulary. The
  diagnostic workflow's run summary is a fixed sentence the product builds
  from three counts; it stays stored in English as the record, and the runs
  pages re-word it (`localizedRunSummary`), leaving every agent-written summary
  as written.
- **A page with no name on a phone.** A MAIN page hides its H1 and leads with
  its subtitle; on a desktop the sidebar says where the reader is. On a phone
  the sidebar is a closed drawer. `PageHeader` takes `titleOnPhone`, which
  keeps the H1 visible below `md` and `sr-only` from `md` up; `agents/ask`
  uses it (its subtitle does not name it). The processes page, whose header
  was retired for the canvas, carries one H1 above its tabs on the same terms,
  standing aside on the Rules tab, which has its own.
- **Two ways back.** The loaded `admin/security` page dropped the loading
  state's back link, so a phone showed the whole breadcrumb trail; it now shows
  the back link, and the trail yields to it as on every other admin page.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/file-picker.tsx` | New shared single-file chooser |
| `src/app/t/[tenantSlug]/(app)/admin/trust-center/GatedDocumentsAdmin.tsx` | Uses it |
| `src/app/t/[tenantSlug]/(app)/admin/identity-joiner-passes/JoinerPassesClient.tsx`, `…/identity-write-journal/JournalClient.tsx` | A real spacing token |
| `tests/guards/spacing-scale-discipline.test.ts` | Refuses a spacing name the scale lacks |
| `src/app/t/[tenantSlug]/(app)/admin/risk-matrix/RiskMatrixAdminClient.tsx` | Localised preview |
| `src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx` | Role names as values |
| `src/lib/agentic/workflow-labels.ts`, `workflow-registry.ts` | The diagnostic summary's one writer and its re-wording |
| `src/app/t/[tenantSlug]/(app)/agents/runs/page.tsx`, `…/runs/[runId]/page.tsx` | Show it re-worded |
| `src/components/layout/PageHeader.tsx` | `titleOnPhone` |
| `src/app/t/[tenantSlug]/(app)/agents/ask/AskClient.tsx`, `…/processes/ProcessesClient.tsx` | A title on a phone |
| `src/app/t/[tenantSlug]/(app)/admin/security/page.tsx` | One back link |
| `tests/guards/r31-document-bar.test.ts`, `tests/guards/page-breadcrumbs-coverage.test.ts` | The processes H1 is allowed only as `md:sr-only`, and has no breadcrumb strip (its trail is the canvas's) |

## Decisions

- **The rows were already fixed.** Notifications, the risk-matrix Save, the
  AI-features toggles, the org agent switches and the SCIM header were
  adopted onto `SettingRow` by #5907; nothing here touches them.
- **The run summary is re-worded at display, not re-written at source.** A
  run's summary is part of its record and an audit reads what the run said.
  The parser and the builder live together in `workflow-labels.ts`, and a test
  holds the English message equal to what the synthesis step stores, so the
  two cannot drift apart without a red build.
- **`titleOnPhone` is opt-in.** Showing every main page's title on a phone
  would reverse the subtitle-led header for the whole product; the two pages
  that read as nameless get it, and any other can ask for it.
- **The picker's id goes on the button.** Inside a `FormField` the label names
  the one focusable control and opens the dialog; the native input keeps a
  separate `inputId` for tests and E2E runs that set files on it.
