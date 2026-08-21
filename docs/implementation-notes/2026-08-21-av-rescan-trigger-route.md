# 2026-08-21 — an admin trigger for `av-rescan`

**Commit:** `feat(av): give av-rescan a trigger that does not require SSH`

## Design

`av-rescan` shipped complete: registered in `executor-registry.ts`, typed in
`jobs/types.ts`, given its own `JOB_DEFAULTS` (`attempts: 1`), carefully argued
in a 90-line docblock — and enqueued by nothing. No route, no entry in
`schedules.ts`, no script under `scripts/`. Its own docblock instructs the
operator to "re-run it until `scanned` comes back zero", which was an
instruction with no mechanism.

It was run in production for the first time on 2026-08-20 by a hand-written
`queue.add` inside the worker container. That required VM access, the queue
name, a real `userId` to serve as the audit actor on every row the job writes,
and a hand copy of `JOB_DEFAULTS['av-rescan']` — because a raw `queue.add`
bypasses the `enqueue()` wrapper that normally applies them, and the job's
`attempts: 1` is a deliberate choice, not a default worth losing.

This note covers the route that closes that gap:

```
POST /api/t/:tenantSlug/admin/av-rescan     → 202 { jobId, limit, maxLimit }
GET  /api/t/:tenantSlug/admin/av-rescan?jobId=…  → { state, progress, result }
```

`admin/key-rotation` is the shape it copies — the closest precedent in the repo
for "enqueue one bounded per-tenant job, audit that somebody asked, hand back
the id". The GET is not decoration: the whole point of the job is reading the
counters and deciding whether to run again, and without a poll endpoint the
operator would still need a shell for the half that matters.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/admin/av-rescan/route.ts` | The trigger + the poll. |
| `src/lib/security/route-permissions.ts` | Declares the gate at `admin.tenant_lifecycle`. |
| `tests/guardrails/admin-route-coverage.test.ts` | `ADMIN_ONLY_ROUTES` entry — the walker fails on an unlisted `admin/*` route. |
| `tests/unit/av-rescan-admin-api.test.ts` | Authz, payload bounds, audit, disabled-mode refusal, rate limit, poll. |
| `public/openapi.json` | Regenerated; the route walker emits a stub path for both methods. |

## Decisions

- **`admin.tenant_lifecycle`, not `admin.manage`.** The instinct is to match
  key-rotation, the route whose shape this copies. The better comparison is
  `admin/files/:fileId/clear-quarantine` — the AV subsystem's only other admin
  route — which sits at the OWNER-only key because it decides what the download
  gate will serve. This job decides the same thing: `isDownloadAllowed` refuses
  PENDING in `strict` mode, and a run turns some number of PENDING rows into
  CLEAN, which is served in every mode from then on. That is clear-quarantine's
  authority in BULK. Gating the bulk case one tier below the single-file case
  would have been incoherent, so ADMIN — which is explicitly denied
  `tenant_lifecycle` — cannot fire it.

- **A sibling path, exactly anchored.** `admin/av-rescan` rather than nesting
  under `admin/files/`. Rule matching is first-match-wins, so a path that
  cannot collide beats inserting a rule above another one; a check against
  every existing rule confirmed nothing matches
  `/api/t/<slug>/admin/av-rescan` today. The regex ends in `$` rather than
  `(\/.*)?$` so a future sub-route is *uncovered* and fails the
  api-permission-coverage guardrail, forcing a decision, instead of silently
  inheriting an OWNER gate it may not want.

- **The caller cannot widen the blast radius.** `tenantId` and
  `initiatedByUserId` come from `ctx`; the body schema is `.strict()`, so a
  caller naming either gets a 400 rather than a silent strip — the two
  outcomes are indistinguishable to a client, and only one of them is honest.
  `limit` is capped at the job's own `AV_RESCAN_MAX_LIMIT`, imported rather
  than restated so route and job cannot drift, and an over-cap value is
  refused rather than clamped: an operator who asks for 5,000 should learn the
  ceiling exists.

- **An absent body and a malformed one are different.** `POST` with no body is
  a run at the job's default limit. `POST` with `{"limit":` is a 400. Reading
  the body as `await req.json().catch(() => ({}))` would have collapsed the
  two and turned a typo'd payload into a silently-defaulted run.

- **`AV_SCAN_MODE=disabled` is refused at the route, and the job keeps its own
  check.** This is not belt-and-braces for its own sake. The job's refusal is
  correct but expresses itself as a warning log plus all-zero counters, and
  from the caller's side zeros are ambiguous — they read exactly like "the
  backlog is already drained", the one answer that would stop an operator
  re-running. A 409 with a stated reason is the difference between a capability
  that is reachable and one that merely responds. The job's guard remains
  authoritative: it runs in the worker, whose env is the env that actually
  governs the scan.

- **`API_KEY_CREATE_LIMIT` (5/hr) was kept, deliberately, despite the
  "re-run until zero" loop.** A max-size run is 1,000 object reads plus 1,000
  clamd round trips, so five queued runs is already more work than the worker
  gets through in an hour. The binding constraint on drain rate is the worker,
  not this endpoint, and a looser preset would only let an operator pile up a
  queue they still have to wait on. Recorded here so the limit is not "fixed"
  later on the assumption that it throttles the drain.

- **The initiation audit row is separate from the job's per-file rows.** The
  job writes `FILE_RESCANNED` / `FILE_QUARANTINED` per verdict, but only for
  files it reaches. `AV_RESCAN_INITIATED` on the tenant is the record that
  somebody asked — it survives a worker that never picks the job up, and it
  survives BullMQ's `removeOnComplete` horizon.

## Follow-up worth a sweep of its own

This is the third capability found this week that exists and cannot be reached
(`reconcileIdentityAccountLinks` had no caller; `EntraIdDirectoryWriter.preflight()`
still has none). `tests/guardrails/runtime-wiring-coverage.test.ts` already
enumerates every registered executor and asks whether it is scheduled — it
accepts a written reason for the unscheduled ones, and `av-rescan`'s reason
("operator-triggered") was true and still left it unreachable. Asking the
stronger question — for each registered executor, does a production path
*enqueue* it? — is a separate change.
