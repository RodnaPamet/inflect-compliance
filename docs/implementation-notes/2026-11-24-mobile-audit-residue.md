# 2026-11-24 — What the first whole-product phone audit still found

**Issue:** #5924 (part of epic #5868). The "Not captured" section (audit seed
coverage) is a separate change.

## Design

The first nightly run of the whole-product audit (`.github/workflows/mobile-audit.yml`,
main `b560db2`) reported six rows above zero. Each was fixed at its cause, and
where the cause was shared, in the shared thing:

- **Text under 12 px.** Owner decision: 12 px everywhere. None of it was the
  type scale's: every case was an arbitrary size written beside it
  (`text-[10px]`, `text-[11px]`, `text-[9px]`, `text-[0.625rem]`) — 157
  occurrences in 72 files, among them the shared `Badge`, `kbd` hints in the
  command palette and tooltips, the sidebar's section headings, the filter
  count chip, the risk matrix's axes and the avatar initials. All became
  `text-xs`. The new ESLint rule `local/no-sub-12px-text` refuses an
  arbitrary font size under 12 px in any string a class list is built from,
  so the floor cannot erode one call site at a time.
- **Tap targets under 24 px.** Three stand-alone text links got the shared
  touch square (`TEXT_LINK_HIT_AREA` / `TOUCH_HIT_AREA_CLASS`): the
  frameworks card's title, the org evaluations card's GitHub links, and
  "Edit review schedule" (now a `TextButton`). A policy's Contents entries
  are 44 px rows on a coarse pointer (CSS on `.policy-content .policy-toc`,
  since the block is generated HTML). The product-tour state's 13 radar marks
  were the harness, not the chart: driver.js sets `pointer-events: none` on
  everything outside the step it shows, and the harness, finding no ancestor
  that takes pointer events, measured each mark's own 8 px box. It now
  counts nothing a tap cannot reach.
- **Button groups on 3+ lines.** The admin hub's sections and the agent
  runs page's "Start a workflow" are lists of destinations or actions, so
  below `sm` they are a column of full-width rows; from `sm` up they wrap as
  before.
- **Clipped.** The org evaluations card's name-and-badge row wraps.
- **English on a Bulgarian page.** Decided case by case — see Decisions.
- **Console errors.** All were React #418 (a hydration text mismatch) on the
  dashboard and the org dashboard, which `/tenants` redirects to, and on the
  open states captured over the dashboard. That is `AnimatedNumber`
  formatting with the runtime locale (#5921, fixed in its own change), so
  nothing here touches it.

## Files

| File | Role |
| --- | --- |
| `eslint-rules/rules/no-sub-12px-text.js` | The small-text floor as a lint rule |
| 72 files under `src/`, `packages/ui/` | `text-[9–11px]` / `text-[0.625rem]` → `text-xs` |
| `src/lib/library-language.ts` | `LIBRARY_LANG`: the language the shipped library is in |
| `src/app/t/.../clauses/ClausesBrowser.tsx` | ISO clause text marked `lang="en"` |
| `src/app/t/.../policies/_form/NewPolicyFields.tsx` | A template tile marked with the template's language |
| `src/app/t/.../policies/[policyId]/page.tsx`, `src/lib/policy/policy-content.ts` | The document marked with the policy's language; the Contents labels with the page's |
| `src/lib/risk-report/system-templates.ts` | The stock report templates and their names in the reader's language |
| `src/lib/agentic/report-definitions.ts`, `messages/*.json` (`agentMetrics`) | Every metric definition in words |
| `scripts/mobile-audit/measure.ts` | Unreachable controls are not tap targets; declared-other-language text and code are not leak candidates |
| `scripts/mobile-audit/leaks.ts` | A word of a library value carried whole in a Bulgarian sentence is the library's |
| `scripts/mobile-audit/resolve.ts` | An AI system's typed provider is data |

## Decisions

- **The English hits, one by one.**
  - *Clause titles* ("Planning", "Improvement"): ISO 27001 clause titles from
    the library — content. Marked `lang="en"` (WCAG 3.1.2, so a screen reader
    reads them in English), with the description, artefacts and checklist.
  - *Policy template categories* ("Technical", "Cryptography"): the template
    library's classification — content, marked with the template's `language`.
  - *The policy's "Scope" heading in its Contents*: the policy's own text,
    and `Policy.language` already declares it; the document now carries it.
  - *Report names* ("Portfolio Risk Summary"): the product's words stored on
    a row — UI. A stock system template still under its stock name reads in
    the reader's language on both report pages; a tenant's own as written.
  - *Metric definitions*: UI, and identifiers. Rewritten in words (below).
  - *CSV column names* in the import instructions: literal identifiers the
    importer reads, so they are `<code>`, not translated.
  - *"Application (client) ID"* on the Entra page: worded as the same page's
    form label already is in Bulgarian.
  - *The SSO client-id placeholder*: moved into the catalog.
  - *"Actions" in the GitHub variables link*: the product is "GitHub Actions";
    named in full.
  - *"Избор на A-5.22 Monitoring, review…"* (control templates): a control
    template's title inside the catalog's "Избор на {name}" — the detector
    now treats a word of a multi-word library value carried whole as the
    library's.
  - *"Internal"* on AI systems: the provider a person typed in the audit
    records — data, added to the detector's data names.
- **Metric definitions are words, and the registry is where they change.**
  The governance pack's definitions named tables, columns, enum values and
  other metric ids ("rows in RegisteredAgent … provenance = THIRD_PARTY").
  Owner decision: a definition shown to a reader is words. The registry
  (`report-definitions.ts`) is the single source — it ships in the payload
  and the exported pack, and the English catalog is held equal to it word for
  word — so it was rewritten, not the catalog alone. The metric ids, which an
  assessor cites, are unchanged; a cross-reference to another figure now
  names it by its label. The registry's docblock records the rule.
- **The harness reads declared language, not a list.** `lang` other than
  the page's, and `<code>`, are the page's own statements that a text is not
  interface text in its language; an allowlist in the detector would be a
  second, silent source of that fact. A page can abuse `lang` to hide a leak,
  but only by a reviewed attribute that also misleads a screen reader.
- **Lists, not a strip, for the two action groups.** Both groups are
  destinations or one-shot actions the reader scans by name; a cued strip
  would show two of ten. A column of rows shows every name, keeps each
  disabled control's reason, and costs no client code (the list pages sit at
  their bundle budgets).
- **The text floor is a lint rule, not a guard.** It is a property of a
  token in a string; ESLint sees every string and reports the token, where a
  source regex would need its own comment stripping.
