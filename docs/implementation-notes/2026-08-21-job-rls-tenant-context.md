# 2026-08-21 — background jobs and the tenant RLS context

**Commit:** `(this PR)` fix(av-rescan): write FileRecord inside the tenant's RLS context

Task #152. Production emitted three `rls-middleware.missing_tenant_context`
warnings during a sanctioned `av-rescan` run — `hasAuditContext: false`,
`source: null`, one per `updateMany`. Observed, not inferred.

The writes were correct: the predicate is keyed by a row id the job had just
read from a tenant-filtered `findMany`. So this was never a data-integrity
incident. It was a defence-in-depth layer not engaged for an unattended bulk
write, which is the exact operation it exists for — and, as the survey below
shows, `av-rescan` was not special.

## Design

### Why a job gets no tenant context

Two AsyncLocalStorage stores, no bridge between them:

```
runJob(name, fn, { tenantId })
  └─ runWithRequestContext({ requestId, route, tenantId })   ← lib/observability/context.ts
        │                                                       (logs, traces, Sentry)
        └─ fn()
              └─ prisma.fileRecord.updateMany(...)
                    ├─ rls-tripwire extension     ─┐
                    ├─ field-encryption extension  ├─ all read getAuditContext()
                    └─ audit-middleware extension ─┘   ← lib/audit-context.ts  (EMPTY)
```

`runJob` populates the *observability* store. Every Prisma extension reads the
*audit* store. A job carrying a perfectly good `tenantId` therefore issues each
statement with `getAuditContext()` undefined, and three things follow:

1. **No RLS.** The connection never becomes `app_user`, `app.tenant_id` is
   never set, `superuser_bypass` matches, the database enforces nothing.
2. **No auto-audit.** The audit extension in `lib/prisma.ts` returns early when
   the audit context has no `tenantId`, so job writes are absent from the trail
   their API-path equivalents land in. Same root cause, second missing layer.
3. **The warning**, which is the tripwire correctly reporting 1 and 2.

### The trap next to the fix

The reflexive repair is `runWithAuditContext({ tenantId, source: 'job' }, …)`.
It silences the tripwire and fixes nothing: `'job'` is one of the encryption
middleware's bypass sources, so the per-tenant DEK stops resolving. Encrypted
reads come back **`null`** (the `no_dek_by_design` branch nulls the field
deliberately, including on columns Prisma types as non-nullable `string`) and
encrypted writes get sealed under the global KEK.

This already happened once. `app-layer/automation/tenant-dek-read.ts` exists
because the automation dispatchers hit the read half: the middleware handed
back raw `v2:` ciphertext for `AutomationRule.webhookSecretEncrypted` and
`executeAction` used those bytes as the outbound HMAC key.

The list was previously a private `const` in `encryption-middleware.ts`, with a
second hand-spelled copy in the RLS tripwire and a prose warning in
`tenant-dek-read.ts`. It is now one leaf module, `lib/db/kek-bypass-sources.ts`,
that all three read — and `runInTenantJobContext` **refuses** those labels at
the door, so the mistake fails loudly instead of silently.

### The shape of the fix

`runInTenantJobContext({ tenantId, source, actorUserId, requestId }, cb)` —
`runInTenantContext`'s posture without a `RequestContext` to build. `source` is
the job's own name (`'av-rescan'`), which is also what reaches
`AuditLog.metadataJson.source`.

In `av-rescan` it wraps each **statement**, not the loop. That is not a
compromise: the job's docblock forbids holding a transaction across
`scanBuffer` (clamd's timeout is 30 s, and a held transaction pins a Postgres
backend and, through PgBouncer, a pooled server connection). Per-statement
contexts satisfy both constraints, and the pre-existing
`#126 holds no transaction open across the scan` test now actually exercises
its depth-counter — before this change the ledger contained no `tx:` markers at
all, so that assertion was passing vacuously.

## The survey — which other jobs write tenant-scoped models outside a context

Every direct Prisma write in `src/app-layer/jobs/**`, classified. 164 of the
203 models carry a `tenantId`, so nearly every write below is on a tenant-scoped
model.

**Bound already (RLS engaged), but labelled `source: 'api'`:**

| Job | Helper | Note |
|---|---|---|
| `control-test-runner.ts` | `runInTenantContext` | 4 writes, all inside |
| `sla-monitor.ts` | `withTenantDb` | 1 write, inside |
| `snapshot.ts` | `withTenantDb` | 1 write, inside |

These are correct on isolation. The only defect is cosmetic-but-misleading:
both helpers hard-code `source: 'api'`, so an unattended sweep's audit rows
claim to be request traffic.

**Single-tenant, no context — the same shape as `av-rescan`, and the class
`runInTenantJobContext` drops into:**

| Job | Writes | Models |
|---|---|---|
| `automation-event-dispatch.ts` | 5 | `AutomationExecution`, `AutomationRule` |
| `automation-runner.ts` | 8 | `IntegrationExecution`, `Evidence`, `EvidenceControlLink`, `Control`, `Finding` |
| `rule-chain-dispatch.ts` | 2 | `AutomationExecution`, `AutomationRule` |
| `subflow-dispatcher.ts` | 2 | `AutomationExecution`, `AutomationRule` |
| `evidence-import.ts` | 2 | `Evidence`, `FileRecord` |
| `report-delivery-jobs.ts` | 1 | `ReportSchedule` |

`evidence-import.ts` is the sharpest of these: it *builds* a `RequestContext`
(`buildJobContext`) and routes evidence creation through a usecase that binds
it — then applies retention and deletes the staging `FileRecord` with the bare
client, outside everything. `report-delivery-jobs.ts` is the same story with
`buildSystemCtx`, and one notch worse than `av-rescan` was: its claim is
`updateMany({ where: { id: s.id, nextRunAt: { lte: now } } })` — no tenant
context AND no `tenantId` column in the predicate, with `s.tenantId` sitting
in scope two lines above. Having the context available is not the same as
using it.

**Optional `tenantId` — per-tenant when an operator names one, ALL-TENANT on
the cron. `runInTenantJobContext` does not apply as written:**

| Job | Writes | Models |
|---|---|---|
| `control-test-scheduler.ts` | 3 | `ControlTestPlan` |
| `deadline-monitor.ts` | 1 | `RiskTreatmentPlan` |
| `exception-expiry-monitor.ts` | 1 | `ControlException` |
| `incident-notification-deadlines.ts` | 3 | `IncidentNotification`, `Notification` |
| `policyReviewReminder.ts` | 3 | `AuditLog`, `NotificationOutbox`, `Task` |
| `retention-notifications.ts` | 3 | `Task`, `NotificationOutbox`, `AuditLog` |
| `retention.ts` | 2 | `Evidence`, `AuditLog` |
| `data-lifecycle.ts` | 3 | `AuditLog` |

**Cross-tenant by construction — a tenant context would be the wrong fix:**
`key-rotation.ts` and `tenant-dek-rotation.ts` (write `Tenant`, which has no
`tenantId`, plus raw SQL sweeps); `nvd-cve-sync.ts` (writes `Cve`, a global
catalogue model — not tenant-scoped, no gap).

## Decisions

- **The rule is "bind the tenant", never "label the source".** Enforced, not
  documented: `runInTenantJobContext` throws on a `KEK_BYPASS_SOURCES` label
  before opening the transaction. A substring check was deliberately avoided —
  `'job-runner'` is a legitimate job name and refusing it would push its author
  towards `'api'`.

- **One list, three readers.** `KEK_BYPASS_SOURCES` moved to a leaf module.
  The refactor immediately broke `tests/guards/automation-dispatch-tenant-dek.ts`,
  which sliced the literal out of `encryption-middleware.ts` with a regex — it
  asserted where the list was *written* rather than what the middleware
  *reads*, and went red on a behaviour-preserving move. It now imports the real
  value (the module has no imports of its own, so the guard stays DB-free).

- **Binding the context turns the auto-audit on, and that is welded to the same
  field.** `AuditContextData.tenantId` is simultaneously the RLS-intent signal
  and the auto-audit trigger; you cannot engage one without the other. For
  `av-rescan` that is accepted and arguably desirable — an operator ought to
  see an unattended bulk verdict write — and the volume is bounded by
  `AV_RESCAN_MAX_LIMIT` on an on-demand tool. **For the recurring crons it is a
  real decision, not a detail:** each would begin writing hash-chained
  `AuditLog` rows in proportion to rows touched, every run, forever, each row
  taking a per-tenant advisory lock, on a table the retention policy never
  deletes. That is the reason the rollout stops here rather than sweeping all
  20 sites in one diff.

- **The optional-`tenantId` jobs need restructuring, not a wrapper.** They are
  single-tenant and cross-tenant through the same code path. Binding RLS means
  enumerating tenants outside the context and opening one per tenant — turning
  one bulk statement into N transactions plus N× the audit rows above. Per job,
  with its own cost. Filing them as "wrap in `runInTenantJobContext`" would be
  wrong, and the wrapper refuses an empty `tenantId` explicitly so nobody tries.

- **`tenantId` added to the verdict predicate as well.** Not redundant with
  RLS: RLS is what still holds if a later edit widens the `where`, and the
  explicit column is what keeps the query correct on a connection that
  legitimately bypasses RLS (a superuser maintenance run).

- **`source: 'api'` on `withTenantDb` / `runInTenantContext` left alone.**
  Three jobs are mislabelled by it. Changing the shared helpers to take a
  source would touch every usecase in the codebase; the three call sites should
  move to `runInTenantJobContext` instead, which is a follow-up, not this diff.

## Files

| File | Role |
|---|---|
| `src/lib/db/kek-bypass-sources.ts` | NEW. The three tenant-less `source` labels, one copy, with the incident that explains why they matter |
| `src/lib/db-context.ts` | `runInTenantJobContext` — tenant RLS + audit context for a job, refusing bypass labels and an empty tenantId |
| `src/lib/db/encryption-middleware.ts` | Reads the shared list instead of its own private copy |
| `src/lib/db/rls-middleware.ts` | Tripwire reads the shared list; re-exports the new helper |
| `src/app-layer/jobs/av-rescan.ts` | Selection + verdict write + attempt write each inside the tenant context; `tenantId` added to the claim predicate |
| `tests/unit/tenant-job-context.test.ts` | NEW. The helper's SQL, its audit context, and its refusals |
| `tests/unit/av-rescan-job.test.ts` | `#152` block: every statement bound, labelled `av-rescan`, claim scoped to the tenant |
| `tests/unit/av-rescan-backoff.test.ts` | Mocks the tenant context (keeping the refusal rule); pins the attempt write as bound |
| `tests/guards/automation-dispatch-tenant-dek.test.ts` | Imports the real bypass set instead of regexing the middleware source |
