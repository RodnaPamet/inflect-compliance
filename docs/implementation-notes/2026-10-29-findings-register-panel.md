# 2026-10-29 — The Findings register: a panel per finding, and a status filter

**Commit:** `597023f11 feat(findings): a finding opens in a side panel, editable by roles that can write (#4461)`
(with `f0abe1001` for the status filter and `a5764515b` for the links)

Issue #4461 listed eight findings on the register. Five were small (an error
envelope read wrongly, write controls offered to read-only roles, a status
rollback with no message, a default-on select column, a dead link). Three
shared one cause: a finding had no address and the register had no filter. This
note records the two pieces of structure that fixed them.

## Design

```
/findings?status=OPEN,IN_PROGRESS&finding=<id>
          │                         │
          │                         └─ FindingsClient reads it ─▶ FindingDetailSheet
          │                                                          GET  /findings/:id
          │                                                          PUT  /findings/:id   (canWrite only;
          │                                                                                changed fields only)
          └─ FilterProvider (URL-synced) ─▶ toApiSearchParams ─▶ GET /findings?status=…
                                                                   └─ FindingRepository.list
                                                                      parseEnumListFilter → 400 on an unknown status

linked from: integration passport (open findings) · calendar (finding-due)
             dashboard "Open Findings" arrow → ?status=<every status but CLOSED>
```

A finding's address is the register with its panel open. There is no
`/findings/[id]` route, and the owner's decision (2026-10-29) was a side panel
rather than a page, so `?finding=<id>` is the one address other surfaces use.
Closing the panel removes the parameter and keeps the others.

The status facet is applied by the API. The register used to be fetched whole
and filtered nowhere; a client-side filter over that fetch would have narrowed
only the 5,000 rows the backfill cap returned, leaving the truncation banner's
"refine your filters" still untrue.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/findings/FindingDetailSheet.tsx` | The panel: every field the create dialog collects, an Edit form for the write tier |
| `src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx` | Row click and `?finding=` open the panel; `FilterProvider` + `FilterToolbar`; filter-aware SWR key |
| `src/app/t/[tenantSlug]/(app)/findings/filter-defs.ts` | The status facet and `FINDING_STATUSES` |
| `src/app/t/[tenantSlug]/(app)/findings/page.tsx` | Passes `canWrite` and renders the first page with the URL's facet |
| `src/app-layer/repositories/FindingRepository.ts` | `list` takes `status`, validated by `parseEnumListFilter` |
| `src/app/api/t/[tenantSlug]/findings/route.ts` | Forwards `?status=` |
| `src/app-layer/usecases/finding.ts` | `updateFinding`: `dueDate: null` and `analysis: null` clear |

## Decisions

- **The edit form sends only what changed.** `updateFinding` re-validates every
  reference in the body, so resending the stored assignee would refuse an edit
  to the title once that person left the tenant.
- **The originating audit is shown, not edited.** `UpdateFindingSchema` has no
  `auditId`; a picker would save nothing.
- **No delete,** per the owner decision.
- **`null` now clears `dueDate` and `analysis`.** Both collapsed `null` to
  "untouched", so a due date could never be removed. The other nullable text
  fields (`rootCause`, `correctiveAction`, `owner`, `verificationNotes`) keep
  that behaviour; no surface clears them today.
- **The panel's Save was paid for** under `primary-secondary-ratio`'s ceiling by
  demoting the Statement of Applicability's per-row "map control" button to
  secondary. `modal-action-order` requires a `Sheet.Actions` block to end on a
  primary, and the ceiling has no headroom.
- **No index.** `[tenantId, createdAt]` serves the register's sort; the status
  predicate filters within one tenant's findings. A `[tenantId, status]` index
  would be a migration for a read that does not need one at this scale.
- **Bad facet values.** The API refuses them (400); the server page and the
  client drop them before asking, so a `?status=ACTIVE` carried over from
  another list shows the unfiltered register rather than an error page.
