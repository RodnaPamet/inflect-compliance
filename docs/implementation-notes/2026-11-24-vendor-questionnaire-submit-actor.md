# 2026-11-24 — Vendor questionnaire submit: a real actor on the audit row

**Commit:** `fix(vendor-assessment): attribute the external submit to the tenant system user (#5910)`

## Design

`submitResponse` (the public, token-gated vendor questionnaire submit) wrote
its audit rows as `userId: 'external-respondent'`. No migration or seed
creates that user, and `AuditLog.userId` is a foreign key to `User`, so the
`VENDOR_ASSESSMENT_SUBMITTED` insert failed with SQLSTATE 23503 inside the
submit transaction and every real submission rolled back. The integration
suite seeded a `User` with that id itself, so it stayed green.

The respondent context now names the tenant's SYSTEM user (#4400,
`ensureTenantSystemUser` in `src/app-layer/context-system.ts`), created on
first use, with `actorType: 'SYSTEM'`. Who actually acted is recorded as a
structured, PII-free member of the audit row's `detailsJson`:

```json
"actor": { "kind": "EXTERNAL_ASSESSMENT_RESPONDENT", "authenticatedBy": "ASSESSMENT_ACCESS_TOKEN" }
```

The same context drives `runWithAuditContext` and `runInTenantContext`, so the
per-statement rows the Prisma audit extension writes for the answer upserts
and the status transition land too (they were failing the same FK, silently).

The search for other fabricated actors found two job principals in the
`system:` namespace that reach `AuditLog.userId` through
`runInTenantContext`: `system:report-delivery` (scheduled report delivery)
and `system:webhook` (inbound integration webhooks: the sync orchestrator's
local-store writes, inline and in the `sync-pull` jobs it enqueues with the
same context). Their rows come only from the audit extension, which swallows
its own failures, so they were lost without a sign. The audit write seam
(`auditUserIdOrNull`) now maps that namespace to NULL, exactly as it already
mapped the bare `'system'` sentinel.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/vendor-assessment-response.ts` | Respondent context names the tenant system user; `detailsJson.actor` |
| `src/lib/audit/audit-writer.ts` | `system:*` principals map to a NULL `userId` at the write seam |
| `tests/integration/vendor-assessment-lifecycle.test.ts` | No seeded actor; asserts the submit's audit row |
| `tests/integration/audit-hash-chain.test.ts` | Named job principals land with a NULL user id |
| `tests/unit/vendor-assessment-response.test.ts` | Attribution and zeroed authority of the respondent context |
| `tests/guards/audit-system-principal-never-reaches-the-fk.test.ts` | The namespace mapping, and the system user left alone |

## Decisions

- **The identity of `buildTenantSystemJobContext`, not its authority.** That
  builder grants a job's ADMIN role and full coarse flags. The respondent
  context has deliberately carried no authority since the token-gate
  hardening (role READER, every flag false), so it takes only the identity
  half, `ensureTenantSystemUser`, which the builder itself calls.
- **`actorType: 'SYSTEM'`, not `'JOB'` and not a new value.** The submit is
  not a background job, and the row used to claim `'USER'` by default. A new
  `ActorType` member would reach SIEM consumers and every reader of the
  column; `SYSTEM` plus the structured `actor` member says the same thing
  inside the existing vocabulary.
- **No respondent email or name in the audit row.** Both are already on the
  assessment, and `detailsJson` streams to the tenant's SIEM. The row's
  `entityId` names the assessment; the `actor` member names the kind of party
  and how it authenticated.
- **The load path names the same user.** `loadResponseByToken` writes
  nothing, but it shares the context builder, so a write added there later
  cannot reintroduce a principal that is not a `User` row. The cost is one
  `INSERT … ON CONFLICT DO NOTHING` per page load.
- **Job principals stay as they are on the context.** Moving
  `system:report-delivery` and `system:webhook` onto the tenant system user
  would change `ctx.userId` everywhere those contexts flow. The audit column
  is the only place the id is wrong, and the seam already had the rule for
  the bare sentinel. The agent kill-switch actors
  (`system:agent-owner-orphan-pass`, `system:agent-kill-switch-drill`) are
  written only to CHECK-pinned kill-switch columns, never as a context's
  `userId`, and are untouched.
