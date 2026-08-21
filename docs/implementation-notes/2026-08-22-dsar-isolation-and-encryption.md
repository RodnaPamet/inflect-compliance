# 2026-08-22 — DataSubjectRequest: one absence, three blind guards

**Commit:** `(this branch) fix(security): give DataSubjectRequest RLS and encrypt its free text`

## Design

`DataSubjectRequest` shipped in `20260626130000` with **no row-level security** —
no `ENABLE`, no `FORCE`, no policy. Verified against a live migrated database
before writing anything: `pg_policies` returned zero rows for the table and
`relrowsecurity/relforcerowsecurity` were both `false`.

Nothing was bypassed to allow that. The model is **deliberately USER-scoped** —
a DSAR concerns a person, not a tenant (`prisma/schema/auth.prisma:1521`) — so it
carries no `tenantId` column. And `tenantId` is the marker that both halves of
the isolation population key on:

- `enumerateDirectTenantScopedModels()` filters the DMMF on a `tenantId` field.
- `OWNERSHIP_CHAINED_MODELS`, the hand-curated other half, did not list it.

So `TENANT_SCOPED_MODELS` excluded it. That set is the denominator for
`rls-coverage.test.ts` **and** for `isTenantScopedModel`, which the Prisma
tripwire consults before deciding whether to warn about a context-less query —
and which short-circuits before the warn for any model it rejects.

## The part worth remembering: one absence, three guards

Listing the model for RLS did not fix one thing. It put the table into three
denominators at once, and **two more guards failed immediately**:

| guard | what it found |
|---|---|
| `rls-coverage` | no `tenant_isolation` / `superuser_bypass` policy, no FORCE |
| `encryption-manifest-coverage` | `rejectionReason` + `fulfilmentNotes` in plaintext |
| `sanitize-rich-text-coverage` | the model unclassified for rich-text coverage |

The third was already satisfied in substance — `dsar-register.ts` routes both
columns through `sanitizeOptional`. What was missing in every case was the
model's MEMBERSHIP IN A LIST, and each list is the denominator for a different
guarantee.

The encryption one is the sharpest. Those two columns hold narrative about an
identified person who has exercised a privacy right — why their request was
refused, and what was done to fulfil it. By subject matter that is the most
sensitive free text the platform stores, and it shipped in plaintext for two
months because the guard that would have said so scans tenant-scoped columns.

## The load-bearing line in the policy

```sql
WHERE m."userId" = "DataSubjectRequest"."userId"   -- qualified, deliberately
```

`TenantMembership` has its own `userId` column, so an unqualified `"userId"`
inside the subquery resolves to the INNER relation — making the condition
`m."userId" = m."userId"`, true for every membership row. The
`PolicyAcknowledgementAssignment` precedent could safely use a bare column name
because `PolicyVersion` has no `policyVersionId`; that is not the case here.

**The broken form is not obviously broken, which is why this is written down.**
`EXISTS` then succeeds for any tenant holding at least one ACTIVE membership and
fails for a tenant holding none — so *"an unknown tenant sees nothing" still
passes*. Measured on a live database rather than reasoned about:

| | correct | unqualified |
|---|---|---|
| tenant A sees | `d-A` | `d-A, d-B` |
| tenant B sees | `d-B` | `d-A, d-B` |
| unknown tenant | `<none>` | `<none>` |

A fail-closed assertion alone would certify a policy leaking every subject
request to every tenant. The discriminating assertion is the positive one.

## Files

| file | role |
|---|---|
| `prisma/migrations/20260822010000_dsar_rls_isolation/migration.sql` | the policy, the rationale, the rollback |
| `src/lib/db/rls-middleware.ts` | `DataSubjectRequest` added to `OWNERSHIP_CHAINED_MODELS` |
| `src/lib/security/encrypted-fields.ts` | `rejectionReason` + `fulfilmentNotes` encrypted |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | model classified against its sanitising usecase |
| `tests/integration/dsar-rls.test.ts` | behavioural policy semantics |
| `tests/unit/encryption-middleware.test.ts` | manifest round-trip (checklist step 3) |

## Decisions

- **The policy mirrors the application's predicate exactly.**
  `scopedToTenantMembers()` is
  `user.tenantMemberships.some({ tenantId, status: 'ACTIVE' })`; the policy is
  that statement in SQL. So this is a no-op for every query the app makes today,
  and a subject belonging to two tenants stays visible to both — correct, since
  their request is legitimately each tenant's business.

- **Latent, not live — and the compensating control is real.** `dsar-register.ts`
  is the only module touching the model and all three of its functions apply the
  predicate; `tests/integration/dsar-register-isolation.test.ts` is a genuine
  two-tenant behavioural control over that. What was missing is the backstop
  *underneath* it, so a fourth access path — a new usecase, an export, a report —
  could read across tenants with nothing to stop it and nothing even to log it.

- **No backfill migration.** Production holds zero `DataSubjectRequest` rows —
  measured on the VM, not assumed. Encrypting the two columns therefore has no
  existing ciphertext to reconcile. Had there been rows, checklist step 4 would
  require a backfill before the next tenant write.

- **Listing the model cannot break runtime.** The tripwire logs (`warn` on
  writes, `debug` on reads) and then calls `query(args)` regardless — it never
  throws. So the new membership changes observability, not behaviour.

- **Encrypt rather than justify.** The coverage guard offered both doors. These
  columns are free text about a named person's privacy request, `Risk.treatmentNotes`
  and `ControlException.rejectionReason` are already encrypted analogues, and
  neither column is used in a `contains` / `startsWith` / `orderBy` anywhere in
  `src/` — so the plaintext door would have been a written excuse for the wrong
  answer.
