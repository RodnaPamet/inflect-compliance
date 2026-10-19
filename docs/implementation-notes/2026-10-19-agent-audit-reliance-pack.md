# 2026-10-19 — The agent-audit reliance pack (4d, #3681)

**Commit:** see the pull request that closes #3681.

## Design

The external auditor relies on the auditor agent's workpapers on one basis:
internal audit's re-performance of a sample of them (3d). Step 4d puts that basis
into a pack the auditor can read, assembled from rows that already exist.

```
AuditCycle (period) ──► usecases/agent-audit-reliance.ts
                          reads: live library v1 plans → controls
                                 AuditWorkpaper of the period (+1 past the cap)
                                 each workpaper's AuditWorkpaperSampleReview
                                 its ControlTestRun's control
                          ──► lib/agentic/audit-reliance.ts  planReliancePack()  (pure)
                                 REFUSED { reason, detail }  → 409 + audit row
                                 PLAN    { CONTROL items, FRAMEWORK_COVERAGE summary }
                          ──► one tenant transaction: AuditPack + items + audit row
                          ──► freezeAuditPack()  (the existing freeze)
shared via the existing pack-scoped share link and auditor grant
rendered by components/audits/RelianceSnapshotBlock.tsx (shared page + pack page)
```

## Files

| File | Role |
|---|---|
| `src/lib/agentic/audit-reliance.ts` | Pure planner: period labels, scope, attribution, limits, refusals, the rate via `workpaperReviewRate` |
| `src/app-layer/usecases/agent-audit-reliance.ts` | Reads the rows, writes pack and items, freezes, records refusals |
| `src/app/api/t/[tenantSlug]/audits/cycles/[cycleId]/reliance-pack/route.ts` | `POST`, `audits.manage` and `admin.manage` |
| `src/lib/agentic/report-definitions.ts` | Two definitions over the pack's own population |
| `src/components/audits/RelianceSnapshotBlock.tsx` | The reliance view, closed vocabularies as local sets |
| `src/app/audit/shared/[token]/page.tsx`, `…/audits/packs/[packId]/page.tsx` | Render the block |
| `…/audits/cycles/[cycleId]/page.tsx` | The **Reliance pack** action, refusals shown inline |
| `docs/agentic-audit-reliance-memo.md` | The memo: basis, contents, limits, how the conclusion is recorded |

## Decisions

- **An ordinary pack, not a new model.** Freezing, sharing, expiry, revocation,
  the auditor grant and the return channel already exist and are the
  best-reviewed external-access code in the repository
  (`docs/audits-surface-do-not-touch.md` §1). A reliance pack is a pack whose
  items happen to carry a `reliance` block, so it inherits all of that, and no
  migration was needed.
- **CONTROL and FRAMEWORK_COVERAGE items, no new entity type.** A new
  `AuditPackItemEntityType` value is an enum migration, and an old container
  reading the new value during a rolling deploy throws. A reliance control item
  keeps the fields every CONTROL snapshot carries (code, name, status, mapped
  requirements), so the existing views still read it; the summary is coverage of
  the framework by relied-on procedures, which is what FRAMEWORK_COVERAGE means.
- **The snapshot is written at assembly, and the pack is frozen at once.** The
  freeze fills only items lacking a snapshot, so it leaves these alone. A DRAFT
  reliance pack would be one whose items could change, and the share path
  refuses to serve a DRAFT anyway.
- **A period is in only if wholly inside the cycle.** Reliance for the cycle
  cannot rest on work that also covers time outside it. Both ends are whole UTC
  days, so a cycle ending `2026-12-31` includes December.
- **Attribution: the run's control, else the procedure's one live plan, else
  refuse.** A test run is hard-purged with its soft-deleted plan after 90 days,
  and a workpaper outlives it. Falling back to the current plan is marked
  `ATTRIBUTED_BY_CURRENT_PLAN`; two live plans for one procedure is ambiguous and
  refuses the pack rather than guessing.
- **Limits are a set.** Whether to rely is the external auditor's conclusion; the
  pack states every limit that applies, the way the legacy findings are a set
  rather than one label that has to win.
- **Two new metric definitions, not a footnote.** The 3d rate is over rows drawn
  in a rolling window; the pack's is over the workpapers it holds. An auditor
  cites the id, so the id must name the population the figure was computed over.
- **Both keys on the route.** The roadmap gives reading workpapers
  `audits.manage`; freezing is OWNER or ADMIN by role, the `admin.manage`
  population. Requiring both leaves no custom role that passes the route and
  then fails the usecase with no `AUTHZ_DENIED` row. The roadmap's
  permission-keys row said "no new route"; it is corrected in the same change,
  because a reliance item's snapshot is built server-side and the item route
  takes a client-supplied one.
- **No personal identifiers in the pack.** It is read through a public token.
  Reviewers are described by the rule that admitted them (an ACTIVE third-line
  member who does not own the auditor, enforced by the database), not by id.
