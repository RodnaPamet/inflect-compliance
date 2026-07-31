# 2026-07-30 — Report coherence, query bounds, and the print view

**Commit:** `<sha>` fix(reports): make the report families agree, bound their queries, and give the print view no chrome

Prompt 3 of the report-surface audit — the last of three. Seven findings; the
notable thing is how many of R3.7's sub-claims did not survive being checked.

| Finding | Outcome |
|---|---|
| R3.1 two report families disagree on soft-deletes | **Confirmed**, both halves |
| R3.2 unbounded generation, no timeouts | **Confirmed** |
| R3.3 print view is not chrome-less | **Confirmed**, both halves |
| R3.4 non-ISO framing incoherent | **Confirmed** — dead branch + 2 dead keys removed |
| R3.5 hub duplicates the template list | **Confirmed** |
| R3.6 audit + error taxonomy | Download audit landed in #1759; the `requirementId` half was real |
| R3.7 primitives + i18n | **Mostly refuted** — see below |

## R3.1 — the disagreement was one-directional, and that matters

`getRiskRegisterData` had no `deletedAt` filter while `assembleReportData`
filters risks and `getSoA` filters controls. Same tenant, same moment, two
different compliance numbers depending on which report an auditor opened.

Worth stating precisely: the Risk Register was the **optimistic** one. It counted
rows the product considers deleted, and the readiness report did the same for
soft-deleted controls — a deleted control kept satisfying the requirement it used
to cover, inflating `mapped`, `coveragePercent`, `readinessScore` and
`controlsMissingEvidence`. A GRC number that drifts upward when data is removed
is the worst direction for it to drift.

The readiness fix is the *second half* of a filter the evidence side had already
made (there is a comment there explaining exactly this reasoning about the two
families not diverging) — the control side of the same query was simply missed.

## R3.2 — bounds where they change nothing, and a lookback that does

`generateReadinessReport` materialised every link → control → **all** tasks →
**all** evidence links → exceptions with no `take` anywhere. Three bounds, each
chosen against what the code actually reads:

- `exceptions: take: 1` — only `.length > 0` is consulted, so one row settles it.
- `tasks` / `evidenceControlLinks`: `take: 500` — generous per control, and the
  dominant cost on a large tenant.

`loadLatestTestResults` was the interesting one: it pulled **every** completed run
for every mapped control and then kept the first per control in JS. The query grew
without limit over a tenant's lifetime while the answer it produced stayed the
same size — one row per control. It now carries a **730-day lookback** as well as
a row cap, on the reasoning that a two-year-old passing test is not evidence about
the control today, so the window costs nothing the SoA was using.

`maxDuration = 60` added to the four report routes that lacked it.

## R3.3 — the narrower fix was the right one

`SoAPrintView`'s docblock claims "No nav", but the route lives under `(app)`,
whose layout mounts `AppShell`, and **no shell chrome carried `no-print`** —
while the print rule in `globals.css` hides only elements that do. So the auditor
artefact carried the nav rail on every page.

Two fixes were available: move the route out of `(app)`, or mark the chrome. The
second is narrower and better — the print view genuinely wants the layout's
providers (tenant context, theme), just not its furniture.

The Back button called `window.history.back()`, which is a **no-op in the tab
this page opens in**: the SoA "Print" affordance uses `target="_blank"`, so the
fresh tab has no history. It was the only control on an otherwise chrome-less
page and it did nothing. Now falls back to the reports hub.

## R3.4 — deciding, then deleting

`SoAClient`'s non-ISO notice was **unreachable**: both `soa/page.tsx` and
`soa/print/page.tsx` redirect when `!report.isIsoFamily`, so the component only
ever renders for an ISO-family framework. The branch and its two i18n strings
(in both catalogues) are gone rather than kept "just in case" — dead UI that
looks live is how a reviewer concludes a case is handled when it is not.

The CSV route's non-ISO branch is **not** the same kind of dead code: it emits a
genuine neutral Coverage export and names the file `_Coverage_`. That is a
working capability someone deliberately built, reachable only because the hub
renders the CSV button inside `{isIso && …}`. Deleting it to "make the surfaces
agree" would have removed function to satisfy a symmetry argument. Left in place
and called out.

## R3.7 — most of it did not survive checking

| Claim | Reality |
|---|---|
| `FormField` imported and never used | **False** — it is not imported at all |
| `SoAClient:586` raw `title=` | **False** — that is a `<Tooltip content=…>` |
| `PdfExportButton` uses blocking `window.alert` | **False** — no `alert` in the file |
| `src/components/ui/table/data-table.tsx` has **zero** importers | **False** — the barrel re-exports it and 97 files reference `DataTable` |
| `SoAClient:524` row expander has no a11y | **True** |
| `SoAClient:471` raw `<textarea>` | **True** |
| `UpgradeGate` hardcodes English tooltip/aria | **True** |

The DataTable claim is the one worth recording: it was framed as a repo-wide
decision ("worth a repo-wide decision, not just a SoA fix"), and it rested on a
premise that a single grep disproves. The convention in CLAUDE.md is alive and
followed.

The genuine a11y defect was the most valuable item in the finding: a bare
`onClick` on a `<tr>` is invisible to the keyboard and to assistive tech — no
role, no tab stop, no Enter/Space, nothing announcing expansion state. Those rows
carry the per-requirement control detail, so the SoA's substance sat behind a
mouse-only affordance.

`SoAClient`'s raw `<table className="data-table">` is **left alone**: converting
it to `<DataTable>` means reworking custom expandable rows, which is a refactor,
not a polish item, and it would have arrived in the same commit as seven
unrelated fixes.

## Decisions

- **A rendered test pinned the hardcoded template list.** It asserted
  `riskTplPortfolio` appears — the exact string the fix removes. Rewritten to
  assert the opposite: that no hardcoded `riskTpl*` key survives in the list.

- **`ReportsClient` uses plain `useSWR`, not `useTenantSWR`.** The component is
  handed its `tenantSlug` explicitly and is rendered in tests without a
  `TenantProvider`; reaching for tenant context would add a provider dependency
  it does not otherwise have, for one read-only list. The first attempt used
  `useTenantSWR` and broke five rendered tests, which was the signal.

- **`UpgradeGate` prefers a localized feature label and falls back to
  `FEATURE_LABELS`.** A new `FEATURE_KEY` then renders in English rather than
  crashing on a missing key — the gate is the last thing that should break when
  someone adds a plan feature.
