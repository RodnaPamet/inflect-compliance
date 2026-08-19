# 2026-08-19 — the gate before the first directory write

**Commit:** `(this PR)` feat(jml): per-direction identity-write opt-in with a mandatory dry-run

## What this is

Every integration in this product reads. JML will be the first that **writes to a
system we do not own** — disabling and creating accounts in a customer's Entra ID
or Active Directory. This is the setting that decides whether it may, and it
ships before the write primitive rather than alongside it.

## Why a ladder and not a boolean

```
DISABLED → DRY_RUN → PROPOSE → AUTOMATIC
```

Configured **per direction**, because the two mistakes are not symmetric. A
wrongful disable locks an employee out of their job until somebody notices. A
wrongful create spends money on a licence and leaves an unowned account in the
directory. A tenant may rationally accept one unattended and not the other.

The ladder is not ceremony. The Workday status normalisation that triggers all of
this has **never run against a real tenant** — the operator decision to proceed
without a sandbox is recorded in the task log. A mapping bug there is invisible
until it acts on a person. `DRY_RUN` is where it surfaces: intentions computed
and recorded, compared against what HR and IT actually did, nothing written.

That is also why widening is one rung at a time. Jumping `DISABLED → AUTOMATIC`
skips the exact step whose purpose is to catch the mistake the next step would
then make for real.

## Where it lives, and why not a new model

Two columns plus two timestamps on `TenantSecuritySettings`, not a new table.
That model already holds tenant policy posture (`mfaPolicy`, `aiGuardMode`, AI
sovereignty), is tenant-unique, and **already carries RLS** — so extending it
sidesteps the new-model isolation burden entirely rather than re-deriving it.

`admin.tenant_lifecycle` gates the route: the same OWNER-only key as tenant
deletion and per-tenant DEK rotation, because this is authority of the same
class. ADMIN explicitly does not hold it —
`getPermissionsForRole('ADMIN').admin.tenant_lifecycle` is `false` by type.

## Decisions

- **Narrowing is never blocked**, including `AUTOMATIC → DISABLED` in one step.
  Someone turning this off is reacting to something. A ladder that slowed them
  down on the way *out* would be actively harmful — this is the emergency stop,
  and it must not have a speed limit.

- **A null `dryRunSince` refuses rather than passing.** Absent evidence of
  observation is not evidence of observation. The obvious implementation treats
  a missing timestamp as "infinitely long ago" and silently grants the widest
  authority to exactly the tenants whose state is unclear.

- **The window is days, not runs.** A tenant with a quiet week has observed
  nothing by running the job seven times. Seven days is chosen to span a real
  termination-and-hire cycle, which is the thing being observed.

- **Refusals name the path, not just the fact.** An operator told "no" without
  being told the route tries again, or concludes the feature is broken. The GET
  returns each direction's next rung *and* its blocking reason, so the UI can
  explain a disabled control rather than merely greying it out.

- **`withApiErrorHandling` wraps `requirePermission`, not the reverse.** The
  denial must be raised inside the wrapper so it becomes the standard
  `ApiErrorResponse` and its `AUTHZ_DENIED` row is written. Two guardrails
  caught this composition being wrong on the first attempt.

## Not built here

Dry-run execution, circuit breakers and reversibility capture are the remaining
three pieces of the rails. Reversibility has a hard ordering constraint worth
repeating: it must land **before** the disable primitive, because the prior
`userAccountControl` cannot be reconstructed once an account is disabled.
