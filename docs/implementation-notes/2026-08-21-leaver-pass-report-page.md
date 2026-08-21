# 2026-08-21 — Reading the dry-run leaver pass record on a page

**Commit:** `<pending>` feat(jml): give the dry-run leaver pass report a page to be read on

The record landed with an endpoint. `GET /api/t/:slug/admin/identity-leaver-passes`
returns one `IntegrationExecution` row per pass, gated `admin.tenant_lifecycle`,
with `resultJson` verbatim. That discharged the "opaque linkId **+ read surface**"
decision only half way: the seven-day observation window is meant to be compared
daily against what HR and IT actually did, and an authorised `curl` is not
something anyone can be asked to do for a week.

## Design

A master/detail pair, not a list. The list answers *did a pass run, and what kind
of pass was it*; the detail answers *what did it decide*. Both are `<DataTable>`.

```
/t/:slug/admin/identity-leaver-passes
  page.tsx              RequirePermission(admin.tenant_lifecycle) → ForbiddenPage
  LeaverPassesClient    useTenantSWR('/admin/identity-leaver-passes')
                        ├── Card: passes      (provider · status · refusal · decisions · ran at)
                        └── Card: selected    (facts · refusal notice · truncation notice · decisions)
```

### The third status is the whole point

`writeExecutionRow` is the only creator of these rows and it writes exactly
three statuses. Two of them are easy; the third is the reason the record exists:

| status | what happened | label |
| --- | --- | --- |
| `PASSED` | ran, report complete | Ran — complete |
| `PARTIAL` | ran, decision list cut at `MAX_REPORTED_DECISIONS` | Ran — report truncated |
| `NOT_APPLICABLE` | **ran AND REFUSED**; `resultJson.refusal` names which | Ran and refused |

`NOT_APPLICABLE` is deliberately not rendered as "not applicable", and not as a
missing row. "The pass ran and found nobody to offboard" and "no pass ran" are
the two readings an operator must be able to tell apart during the window, and
rendering a refusal as an absence puts back exactly the silence the record was
built to break. Its badge is `info`, not `neutral`, for the same reason — a
greyed-out badge reads as a gap.

The refusal CODE rides the list row, so seven days of passes can be scanned
without opening each one. The refusal SENTENCE (`resultJson.detail`) is rendered
verbatim in the detail panel rather than re-worded in the message catalog: the
pass authors it, and a second copy here would be free to drift from what the
refusal actually says.

### Truncation is stated in two places on purpose

`decisionsTruncated: true` means the list was cut. The detail panel banners it
with the count actually recorded; the list row carries a compact `Truncated`
badge next to the decision count. One place would have been enough for a reader
who clicks; the failure mode being prevented is a *short list read as complete*,
and the operator scanning the list is the one most exposed to it.

### Everything about `resultJson` is narrowed, nothing is trusted

It is a `Json` column returned verbatim by the endpoint. `readResult` /
`readDecisions` reject non-objects and decisions without a string `linkId`, so a
row written by an older build — or a future one — degrades to a thinner render
rather than throwing the page.

### Where the page lives, and where its link lives

The page is a SIBLING of the other admin surfaces at
`/admin/identity-leaver-passes`, mirroring the API path. Nesting it under
`/admin/integrations` would have re-suggested the connection-scoping the record
deliberately refused: the pass's unit is (tenant, provider) and it writes NULL
`connectionId` on purpose.

The link, however, sits on the integrations hub beside `identity-accounts-link`,
because that is where the identity connectors this pass acts on are configured.
It is wrapped in `RequirePermission(admin.tenant_lifecycle)` — the leaver-pass
report is the only identity surface there that is OWNER-only, and offering an
ADMIN a door that closes on them is worse than not showing it.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/page.tsx` | the OWNER-only gate + `ForbiddenPage` fallback |
| `src/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/LeaverPassesClient.tsx` | the report itself |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx` | permission-gated link to the report |
| `src/lib/nav/page-segregation.ts` | the route registered as a SUBPAGE |
| `src/lib/nav/canonical-parents.ts` | its cold-load back target — the Integrations hub |
| `messages/en.json` · `messages/bg.json` | `admin.leaverPasses.*` |
| `tests/guardrails/admin-layout-guard.test.ts` | allowlist re-keyed on path so a stricter-than-`admin.view` gate is expressible |
| `tests/guards/list-page-shell-coverage.test.ts` | exemption — master/detail, not a single clamped list |
| `tests/guards/filter-toolbar-coverage.test.ts` · `tests/guards/columns-dropdown-coverage.test.ts` | exemptions — a facet or a hidden column on this surface hides evidence |
| `tests/guardrails/design-system-drift.test.ts` · `tests/guards/rendered-coverage-floor.test.ts` | ceiling + floor moved with the new surface |

## Decisions

- **The page gate is client-side, and that is not the security boundary.** The
  endpoint's `requirePermission('admin.tenant_lifecycle', …)` is. The page gate
  exists so a non-OWNER ADMIN is told the true thing ("you do not have access")
  instead of the API's 403 arriving as "couldn't load leaver passes" — a
  permission refusal wearing the costume of a broken backend.

- **`admin-layout-guard`'s allowlist was keyed on `path.basename`.** Since every
  page file in the tree is called `page.tsx`, that set could only ever hold
  `layout.tsx` — so the "pages that need finer-grained checks should be
  explicitly allowlisted" carve-out its own comment promises was unreachable.
  The first page to need it would have had to choose between failing CI and
  hiding its guard from the scan. Re-keyed on the relative path, and each entry
  is now asserted to name a real file whose guard is genuinely narrower
  (`resource="admin"` present, `action="view"` absent) — so an entry cannot
  quietly become the redundancy the block exists to refuse.

- **DRY_RUN decisions are `info`, never `success`.** Nothing was written to a
  directory. A green tick against a decision that never happened is the single
  most misleading thing this page could render.

- **Selection is derived, not stored.** `rows.find(id) ?? rows[0]` — the most
  recent pass is open on first paint (the page is useful without a click), and a
  selection that disappears after a revalidation falls back rather than blanking
  the panel.

- **No facets, and no column gear — on purpose, not by omission.** Both are
  exempted with the same reason: the surface exists so an operator can read
  EVERY pass in the seven-day window and every decision inside the one they are
  looking at. A facet that hides a pass and a gear that hides a column both hide
  evidence, and the read is already bounded (100 passes, 200 decisions) and
  ordered most-recent-first.

- **The page needed six ratchets updated, and none of them were noise.** Running
  only the suites that looked related would have found two of them. The full
  `tests/guards` + `tests/guardrails` sweep is what surfaced the other four —
  `text-xs` inside a `cell:` renderer (admin rows a size smaller than every
  other list page), an unclassified route, an off-canon empty-state title, and
  the rendered-test floor. Each was a real defect in the new surface, not a
  ratchet being pedantic.
