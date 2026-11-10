# 2026-11-10 — A deleted workspace's integrations stop (#5017)

## Design

A soft-deleted workspace kept its integration connections enabled. Ten reads
pick connections across every tenant: eight nightly jobs, the inbound-webhook
processor and the connection-freshness gauge. Each filtered on `provider` and
`isEnabled` alone. So a removed workspace went on calling its customer's
directory, HRIS and cloud accounts every night until the tenant purge, 90
days later. The freshness gauge reported those connections as stale on every
scrape.

It was found on production on 2026-11-10. A member-less test workspace had
failed its Entra sync every night for a month, and soft-deleting it would not
have stopped the dispatch. Its connections were disabled by hand.

Two halves, either of which closes the exposure:

1. **Every cross-tenant read names `tenant: { deletedAt: null }`.** This is
   inline, as the codebase already writes it in `auth.ts`, `tenant-context.ts`
   and the retention jobs. The ten reads are listed in the guard below.
2. **`deleteTenantUnderOrg` switches the workspace's enabled connections off**
   in the same transaction as the soft-delete. It counts them as
   `disabledConnections` on the `TENANT_REMOVED` audit row. This is the same
   reasoning as the membership revocation beside it: a removal should not
   depend on every future reader's `WHERE` clause.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/{identity-sync,hris-sync,identity-joiner,identity-leaver,cloud-posture-collect-dispatch,sharepoint-delta-sync,agent-credential-hygiene,integration-passport-sweep}.ts` | dispatch reads skip deleted workspaces |
| `src/app-layer/usecases/webhook-processor.ts` | an inbound webhook no longer matches a deleted workspace's connection |
| `src/lib/observability/connection-freshness.ts` | the gauge no longer reports them as stale |
| `src/app-layer/usecases/org-tenants.ts` | the delete switches the connections off, in its transaction |
| `tests/guards/connection-reads-skip-deleted-tenants.test.ts` | every `integrationConnection.findMany` without `tenantId` names the filter |
| `tests/integration/connection-dispatch-skips-deleted-tenants.test.ts` | the dispatch and the gauge, against a real database |
| `tests/unit/usecases/org-tenant-delete.test.ts` | the switch-off, its place in the transaction, and its count |

## Decisions

- **The guard reads the syntax tree.** A `where` scoped by `tenantId` is
  exempt, because a tenant-scoped read is already inside a workspace somebody
  resolved. Any other `where` must name the filter, and a `where` the walk
  cannot read as an object literal fails rather than passes. The tenth read,
  the freshness gauge, was found by the guard and was not in the issue.
- **The delete touches only enabled connections**, so the audit count says
  what was live. Nothing re-enables them: there is no tenant restore. Whoever
  restores a tenant by hand re-enables what it still needs, and the docstring
  says so.
- **A job already queued for a deleted workspace still runs.** That run is
  bounded by one night. Checking the tenant inside every job body as well
  would mean ten more edits for a window the dispatch filter already closes
  on the next run.
