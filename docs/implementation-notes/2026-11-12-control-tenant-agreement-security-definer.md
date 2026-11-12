# 2026-11-12 — The Control tenant-agreement triggers actually run as the owner

**Commit:** see `fix(prisma): tenant-agreement triggers run as the owner, as their header claimed`

Closes #5187, an `audit-2026-11` finding. Filed "not yet reproduced"; now
reproduced empirically, with a positive control.

## Design

Migration `20260913120000_control_tenant_agreement_triggers` added five triggers
as the DB backstop for #2532, and its header stated:

> Like an FK check, this runs as the table owner and is NOT subject to RLS — so
> it sees rows the writing session cannot, which is the point: a cross-tenant
> reference is refused rather than silently invisible.

Neither function was `SECURITY DEFINER`, so both ran as the **invoking** role.
A tenant write runs under `SET LOCAL ROLE app_user` with `app.tenant_id` set,
and `Control` is FORCE ROW LEVEL SECURITY. Consequences:

- `control_tenant_agreement` SELECTed the referenced control and found nothing —
  the foreign row is *invisible*, not absent. `NOT FOUND` was true, the function
  returned `NEW`, and the cross-tenant reference was stored. The single-column FK
  passed separately, because a real FK check *is* performed as the owner and the
  id does exist.
- `control_retenant_guard` was worse: it counts child rows whose `tenantId <>`
  the control's new tenant — precisely the rows RLS hides from `app_user` — so
  `offenders` was always 0 and the guard was entirely vacuous for the only role
  that reaches it.

The backstop therefore refused only when the writer could already see the other
tenant's row: a privileged session, the one case needing no backstop. The header
sentence names the exact failure it failed to prevent ("rather than silently
invisible"), which is the kind of safety argument the next contributor relies on.

Nothing was leaking. `finding.ts` checks tenancy inline (`id IN (…) AND tenantId:
ctx.tenantId`, throwing on a miss), `task.ts` uses `assertRefInTenant`, and every
`IntegrationExecution` writer sets `controlId` from a control it just read
in-tenant. This restores the layer beneath them.

### Why the existing test did not catch it

`tests/integration/control-tenant-agreement-triggers.test.ts` drives
`prismaTestClient()` — a privileged session. All four of its REFUSES cases
exercised the path that worked. The test was capable of failing and aimed one
level off, which is why it has been green since September.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261112220000_control_tenant_agreement_security_definer/migration.sql` | Both functions become `SECURITY DEFINER` with `SET search_path = public`; post-conditions assert both flags and that the five triggers are still attached |
| `tests/integration/control-tenant-agreement-triggers.test.ts` | Adds an `app_user` block (mechanism · positive control · the two refusals), a definition-level assertion of `prosecdef` + pinned `search_path`, and a proof that all four child triggers share the one function |

## Decisions

- **`SET search_path = public` is not optional.** A `SECURITY DEFINER` function
  whose search_path the caller controls is a privilege escalation: the caller
  decides which `"Control"` the owner-privileged body reads. The pin also
  excludes `pg_temp`, so a temp table cannot shadow the name. The migration's
  post-condition asserts the pin as well as the flag, because the flag alone
  would be the more dangerous half-fix.

- **`NOT FOUND → RETURN NEW` was kept.** The original comment's reasoning was
  sound — `SELECT … INTO` nulls its target on no match, and NULL is a legal
  value here (a global control), so a `v_tenant IS NULL` test cannot tell "no
  such control" from "library control". The branch was never wrong; its premise
  was. Once the SELECT is unrestricted, finding nothing genuinely means no such
  row, which the FK refuses on its own.

- **The refusal message no longer names the owning tenant.** Making a dead
  backstop live would otherwise turn it into an oracle: a caller who reaches the
  trigger with an arbitrary control id would learn which tenant owns it. Table,
  column and control id are all caller-supplied and stay. Verified the existing
  assertions pin `CONTROL_TENANT_MISMATCH` and the control id, not the tenant —
  so this tightens the message without weakening a test.

- **The new tests assert the DEFINITION, not only behaviour.** The migration's
  `DO` block runs once at apply time; a later `CREATE OR REPLACE` that forgot
  either clause would pass it and silently restore the no-op. A test over
  `pg_proc.prosecdef` / `proconfig` is what keeps failing afterwards. This is
  the same gap the original had — its post-condition counted triggers, which
  stayed true the whole time it was broken.

- **Two guarded columns are exercised under `app_user`, not four, and that is
  stated rather than silent.** All four child triggers execute the one function,
  so the fix reaches `Task` and `IntegrationExecution` by construction — and a
  test asserts that shared binding, so a fifth trigger pointed at a copied body
  would fail rather than quietly fall outside the proof.

- **The 20260913 migration was not edited.** Prisma records a checksum per
  applied migration, so correcting that header in place would put every
  environment into migration drift. The correction lives in the new migration's
  own header, quoting the sentence it supersedes.
