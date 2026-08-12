# 2026-08-13 — Machine writes say they are machine writes

**Commit:** `<sha>` `fix(audit,jobs): background work runs as a job, not as a fabricated ADMIN`

Closes **B2-1c (#35)**, the last item of the Tasks-surface audit round and the
only one the round did not itself contain — it was found by verifying the
premises of B2-1.

## The two problems

Thirteen jobs and sweeps each hand-rolled a `RequestContext` carrying
`role: 'ADMIN'`. Reading them as one defect is what made the item look
larger and vaguer than it is; they are two different problems.

**1. The audit trail lied about who acted.** `logEvent` hardcoded
`actorType: 'USER'` and took no override, so every row a nightly sweep wrote
claimed a person did it. Eight of the thirteen also set the literal
`userId: 'system'` — not a real `User.id`, so the row resolves to nobody. A
reviewer could neither filter machine activity out of a review nor tell a
scheduled sweep from a deliberate human change.

**2. Four of them escalated a REAL user.** These kept a genuine `userId` —
the policy owner, the evidence owner, the test-plan author — and pinned
ADMIN on top. `policyReviewReminder` stated it outright in its own docblock:
*"ADMIN permissions clear `assertCanWriteTasks`"*. A READER who owned a
policy therefore had an admin-authority write committed under their name.

## Design

`ActorType` (`'USER' | 'SYSTEM' | 'JOB'`) already existed in
`src/lib/audit/types.ts`, documented for exactly this, and
`appendAuditEntry` already accepted an optional `actorType` defaulting to
`'USER'`. Nothing new was needed at the storage layer — `logEvent` was
simply throwing the information away.

```
RequestContext { …, actorType?: ActorType }      ← new optional field
        │
        ├─ absent  → every HTTP-borne context, unchanged
        └─ 'JOB'   → buildSystemContext(...)
                          │
   logEvent ─────────────►│ appendAuditEntry({ actorType })
                            (already defaults absent → 'USER')
```

`buildSystemContext` and `resolveMemberContext` live in
`src/app-layer/context.ts`, which already owns *how a RequestContext comes
into existence* (`getTenantCtx`, `getLegacyCtx`, `getOrgCtx`).

**The ADMIN role is unchanged, deliberately.** These are platform
operations: an evidence-expiry sweep must see every tenant row whoever owns
it, and there is no signed-in person whose authority could stand in. This
change buys honesty, not least privilege — the audit row now says `JOB`, so
machine writes are filterable and nobody reads a sweep as a human decision.

**Where a real person is accountable, the schema decides how far this can
go — and that is worth stating plainly rather than glossing.**

`Task.createdByUserId` is `String` (NOT NULL) with a foreign key to `User`.
A task therefore *cannot* be created by `SYSTEM_PRINCIPAL`; the insert dies
on `Task_createdByUserId_fkey`. That constraint is precisely why those jobs
borrowed a real member's id in the first place, and no context helper can
wish it away. The first attempt at this change did route them through
`buildSystemContext`, and `tests/unit/jobs/retention-notifications.test.ts`
caught it immediately — a real-DB test, which a mock would not have.

So the sites split three ways, not two:

| | sites | fix |
|---|---|---|
| writes nothing FK'd to `User` | 9 | `buildSystemContext` — synthetic principal, `actorType: 'JOB'` |
| writes a row FK'd to `User` | 3 | `buildDelegatedJobContext` — real principal kept, `actorType: 'JOB'` |
| already narrower than the builder | 1 | `actorType` added in place |

For the delegated three the audit row now reads *"a job did this,
attributed to \<user\>"* instead of *"\<user\> did this"*, which is the
half that is fixable today. `control-test-runner` keeps the plan author
deliberately — an earlier decision, and the right one: attribution to "a
missing / impersonated actor" is worse than attribution to the plan's owner.

**The ADMIN role on those three is a known remaining gap, documented in
`buildDelegatedJobContext` rather than disguised.** Resolving the owner's
real role instead would mean a READER-owned policy silently gets no review
reminder — compliance work vanishing quietly, which is worse than the
escalation it would close. Closing it properly needs a real per-tenant
SYSTEM `User` row so the foreign key can be satisfied without borrowing
anyone; that is a migration and belongs in its own change.

`resolveMemberContext` is provided for the case this change did NOT need but
the next one will: a job that must act *with* a named user's authority. It
resolves the membership, honours custom roles, and returns `null` for a
non-ACTIVE one. Its docblock is explicit that `null` is a refusal — falling
back to a system context there would re-open the hole from the other side.

## Files

| File | Role |
|---|---|
| `src/app-layer/types.ts` | `RequestContext.actorType?: ActorType` |
| `src/app-layer/events/audit.ts` | `logEvent` forwards `ctx.actorType` instead of hardcoding `'USER'` |
| `src/app-layer/context.ts` | `SYSTEM_PRINCIPAL`, `buildSystemContext`, `resolveMemberContext` |
| `jobs/{sla-monitor,snapshot,vendor-monitoring}.ts` · `usecases/{aws-posture,cloud-posture,hris-sync,identity-sync,device}.ts` | the eight synthetic-principal sites, migrated |
| `jobs/{policyReviewReminder,retention-notifications,control-test-runner}.ts` | the three FK-bound sites — real principal kept, now marked `JOB` |
| `usecases/webhook-processor.ts` | inbound webhook; keeps `system:webhook` and the delivery id |
| `jobs/report-delivery-jobs.ts` | gains `actorType` only — see below |
| `tests/unit/system-actor-context.test.ts` | behavioural cover + the structural allow-list |

## Decisions

- **`report-delivery-jobs` keeps its own literal.** It was already the
  best-behaved of the thirteen: a synthetic principal AND an
  `appPermissions` deliberately narrowed below plain ADMIN
  (`admin.manage`, `tenant_lifecycle`, `owner_management`,
  `reports.schedule_external` all forced false). Routing it through the
  shared builder would have *widened* it. It is the sole allow-list entry,
  with the reason written down and a stale-entry check beside it.
- **`permissions` is an explicit parameter, not a flag.** Three distinct
  coarse shapes existed across the callers — full, read-only (`snapshot`),
  and write-but-not-admin (`control-test-runner`). A `readOnly?: boolean`
  covered two of the three and would have silently widened the third.
- **The structural check is narrow on purpose.** It matches a literal that
  pins `role: 'ADMIN'` *and* carries `appPermissions`. Several Prisma
  `where: { role: 'ADMIN' }` filters exist — `compliance-digest` selecting
  digest recipients, `tenant-admin` counting remaining admins — and none of
  them is a fabricated context. An `appPermissions`-free filter is not
  matched.
- **`buildDelegatedJobContext` is a separate function, not a flag on the
  first one.** The two have genuinely different contracts — one asserts
  there is no user, the other asserts there must be one — and collapsing
  them into `buildSystemContext({ principal })` would make the FK-bound
  case look like an incidental override rather than a distinct situation
  with a written reason.
- **Did not backfill existing rows.** Historical rows keep
  `actorType: 'USER'` and `userId: 'system'`. The audit trail is
  hash-chained and immutable by design; rewriting it to look better is
  precisely what an audit trail must not permit.
