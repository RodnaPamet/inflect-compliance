# 2026-08-09 — Audits surface: five verified defects

**Commit:** `<pending>` fix(audits): unblock cycle frameworks, surface partial exports, guard revokes, address audits, make audits editable

Five independent defects on the Audits surface. What they share is a shape:
each one sits behind a capability that is *otherwise fully built*, and each
fails **silently** — no error, no log, nothing a test that only checked the
happy path would notice. That is why every item here carries a behavioural
test rather than a structural ratchet: the structure was already right in
four of the five cases, and the conduct was wrong.

## Design

### 1 — An audit cycle can be created for any INSTALLED framework

`POST /api/t/:slug/audits/cycles` validated `frameworkKey` against
`z.enum(['ISO27001', 'NIS2'])`. Every other layer already supported any key:
`AuditCycle.frameworkKey` is a free `String`, `createAuditCycle` validates the
key against the tenant's installed `Framework` rows, and the picker offers
every installed framework. Scoring even dispatches non-seed keys to
`computeGenericReadiness` — which was unreachable, therefore dead.

The route now takes `z.string().min(1)` and the *usecase* remains the gate.
The pair matters: widening the route without keeping the installed-framework
check would turn a wall into a hole, so the test asserts both directions.

### 2 — A partial pack export is reported as partial

`exportAuditPackToSharePoint` counted every skipped evidence file into one
`skipped` number, wrote `status: 'PASSED'`, and the UI said "Exported". An
auditor could receive a pack missing its infected, unscanned, deleted,
oversized and unreadable files and be told it was complete.

Skips are now counted per reason (`SkippedBreakdown`), the execution row
carries `status: 'PARTIAL'` when anything was dropped (new
`IntegrationExecutionStatus` value), `resultJson` carries the per-reason
breakdown, and the button raises a `toast.warning` naming the count and the
reasons instead of an unconditional success.

### 3 — Two revokes, two different safeguards

Both auditor revokes went through the same click-through `ConfirmDialog`.
They are not the same kind of act:

- **one pack grant** is routine and reversible → Epic 67 undo toast. The
  DELETE is *scheduled*, not sent; Undo cancels it before it reaches the
  server. This matters because nothing un-revokes an auditor server-side, so
  "send it then compensate" is not an available implementation.
- **the whole account** cascades across every grant at once → Epic 67's
  documented exception, where five seconds is too short to reconsider. It now
  requires typing the auditor's email.

Both sites are registered in `SITE_CONTRACTS`, which previously had no audit
entry at all.

### 4 — An audit has an address

The findings register linked a finding to its audit. Inside a cycle that
resolved to a real route; outside one it linked to `/t/{slug}/audits/{id}`,
which has never existed — the hub is master-detail, not a route per audit.

A stub `/audits/[id]` page would mean two renderings of the same audit
drifting apart, so instead the hub answers to `?selected=<auditId>`. The
effect is **ref-guarded, not dependency-guarded**: `selected` changes on every
row click, and a dep-guarded effect would drag the pane back to the query
param and make the list unclickable.

### 5 — Audit metadata is editable

`CreateAuditSchema` accepted `schedule`, `departments`, `frameworkKey` and
`auditCycleId`. `UpdateAuditSchema` accepted none of them and ends in
`.strip()` — so a PUT carrying those keys returned **200 with the fields
discarded**. With no other write path, all four were write-once: a mis-typed
date or a wrong cycle could only be fixed by deleting the audit, taking its
checklist and findings with it.

The update schema now carries the same four shapes as create, `updateAudit`
forwards them with the three-state contract intact (`undefined` = unchanged,
`null` = cleared), and it repeats `createAudit`'s tenant-scoped cycle check.
`<EditAuditModal>` is the surface that sends them.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/audits/cycles/route.ts` | enum → `z.string().min(1)`; the installed-framework gate stays in the usecase |
| `src/app-layer/usecases/audit-pack-sharepoint-export.ts` | `SkippedBreakdown` per reason; `PARTIAL` status; breakdown in `resultJson` |
| `prisma/schema/enums.prisma` + migration | `IntegrationExecutionStatus.PARTIAL` |
| `src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/SharePointExportButton.tsx` | warning toast naming count + reasons |
| `src/app/t/[tenantSlug]/(app)/audits/auditors/page.tsx` | grant revoke → undo toast; account revoke → typed confirmation |
| `src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx` | link the cycle-less audit to `?selected=` |
| `src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx` | consume `?selected=`; mount the edit modal |
| `src/app/t/[tenantSlug]/(app)/audits/EditAuditModal.tsx` | new — the write-back surface for audit metadata |
| `src/lib/schemas/index.ts` | four fields added to `UpdateAuditSchema` |
| `src/app-layer/usecases/audit.ts` | forward them; tenant-scope the cycle ref on update |

## Decisions

- **The brief's diagnosis of item 3 was wrong, and the prescription was still
  right.** It described both revokes as a "fire-and-forget direct DELETE".
  They were not: both had gone through `ConfirmDialog` since 2026-07-17
  (PR #1640) — `git log -S "revokeAccountTarget"`, and the buttons called
  `setRevokeTarget` / `setRevokeAccountTarget`, not the DELETE. What was
  accurate is that `ConfirmDialog` is the wrong safeguard for *both*, and that
  neither site appeared in `SITE_CONTRACTS`. Implemented as prescribed.

- **`PARTIAL` over a boolean `complete` flag.** The execution row already has
  a status enum that operators filter on; a second parallel signal would mean
  two things to check and one of them eventually not checked.

- **Per-reason counts, not just a total.** "12 files skipped" and "12 files
  skipped, 11 unscanned" call for different actions — the first reads like
  data loss, the second like a scanner backlog.

- **No stub `/audits/[id]`.** See item 4 above. The cost of the alternative is
  paid continuously, in drift.

- **A rendered test needs a memoised `next-intl`.** The repo-wide
  `__mocks__/next-intl.js` returns a fresh `t` function per render. Any
  component whose effect deps include `t` — which is the house style here —
  re-runs that effect on every render under the mock, sets state, and renders
  again. Both new rendered files declare a local mock that caches `t` per
  namespace, which is what real next-intl does. Without it the suites hang
  before the first assertion, and the failure reads as a timeout rather than
  as a mock artefact. Worth knowing before writing the third one.
