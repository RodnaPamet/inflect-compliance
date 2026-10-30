# 2026-10-30 — A manual leaver pass carries its requester's real authority, or none (#4400)

## Design

The "Run now" route for the identity leaver pass asserts `admin.tenant_lifecycle` and puts the caller's id in the job payload. Until now the pass built `buildDelegatedJobContext` from that id: an ADMIN-shaped context attributed to the requester, never checked again. A pass queued by somebody who was removed, deactivated or demoted before it ran still disabled directory accounts with full ADMIN, and the write journal named them as the actor. The two call sites called this "ACCEPTED, NOT OVERLOOKED" (#4388) because refusing the pass would leave a departed employee's accounts enabled, and the per-tenant SYSTEM user (#4400) did not exist yet.

The pass now decides whose authority it carries when it RUNS (`resolvePassActor`, `usecases/identity-pass-requester.ts`):

```
requestedByUserId absent ──────────────────────► buildSystemContext        triggeredBy scheduled
requestedByUserId present
  └─ resolveMemberContextWithReason
       ACTIVE and holds admin.tenant_lifecycle ─► the member's own context  triggeredBy manual
                                                  (real role, actorType JOB) request.authority REQUESTER
       no row / not ACTIVE / lacks the key /    ─► buildSystemContext        triggeredBy manual
       lookup failed                                                          request.authority JOB + refusal
```

- **An authorised requester** gets their own membership, resolved as a request would resolve it, custom role included. Nothing fabricates ADMIN. The journal's `actorUserId` and the audit extension's rows name them.
- **A refused requester's pass still runs**, under the scheduled pass's own context. The journal row carries `'system'`, as the 05:00 pass's does, and no audit row names them. The execution row's `resultJson.request` records `requestedByUserId`, `authority: 'JOB'`, the `refusal` (`REQUESTER_NOT_A_MEMBER`, `REQUESTER_NOT_ACTIVE` with `membershipStatus`, `REQUESTER_LACKS_PERMISSION`, `REQUESTER_UNRESOLVED`), and a warning is logged, because the two ladder refusals write no row.
- **`triggeredBy` is read off the request**, not off `ctx.userId !== SYSTEM_PRINCIPAL`. A refused manual pass runs under a system context, and the old check would have recorded it as `scheduled`.
- **A scheduled pass is unchanged**: the same context, and a row with no `request` block.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-pass-requester.ts` | New. `resolvePassActor`, `passRequestRecord`, `PASS_REQUEST_PERMISSION`. Worker-safe. |
| `src/app-layer/context-system.ts` | `resolveMemberContextWithReason`, which `resolveMemberContext` now wraps; the docblocks of `buildDelegatedJobContext` and `resolveMemberContext` say what is true now |
| `src/app-layer/usecases/identity-leaver-pass.ts` | Resolves its actor through `resolvePassActor`; every execution-row writer takes the `PassTrigger` |
| `src/app-layer/jobs/types.ts`, the leaver run route | Comments: the payload's requester is a claim, re-checked at run time |
| `tests/unit/identity-pass-requester.test.ts` | The resolution against the real `context-system`, and the key pinned to the route-permission map for both run routes |
| `tests/unit/identity-leaver-pass.test.ts` | What context reaches the writes, and the request block on the completed, refusal and error rows |
| `tests/integration/identity-leaver-pass-requester-authority.test.ts` | The real pass against a real database at AUTOMATIC, with only the directory writer faked |

## Decisions

- **The fallback is `buildSystemContext`, not `buildTenantSystemJobContext`.** The tenant system user exists for a NOT NULL `User` foreign key, and nothing on the leaver path has one: `IntegrationExecution` has no user column, `IdentityWriteJournal.actorUserId` has no foreign key, the directory-write audit row is written with `userId: null`, and the audit extension maps `'system'` to NULL. Using the scheduled pass's own context makes a refused manual pass write exactly what the 05:00 pass writes, and avoids a third actor value on the journal and a `User` row nothing needs.
- **A refusal falls back instead of stopping the pass.** `resolveMemberContext`'s rule is that a refusal must never fall back to a system context, because a refusal that would stop work must not be laundered into anonymous work. The leaver pass is not that work: it runs every morning on the job's own authority, and a request changes only when it runs. Refusing it would leave a departed employee's accounts enabled until the next morning. The owner decided this on 2026-10-30, and the docblock on `resolveMemberContext` now names this exception and its limit.
- **The requester's id is on the execution row in both manual cases.** It records who asked, which the route's `IDENTITY_LEAVER_PASS_REQUESTED` audit row already holds. It is not attribution of what the pass did: `authority` says whose authority the pass carried.
- **A membership read that throws is a refusal (`REQUESTER_UNRESOLVED`).** The pass must never throw and resolves its actor before its own `try`. Authority it cannot confirm is not authority.
- **The run-time key is a constant, not an import shared with the route.** The routes keep the literal `requirePermission('admin.tenant_lifecycle', …)` that the permission guardrail reads, and a unit test holds `PASS_REQUEST_PERMISSION` equal to the route-permission map for both run paths.
- **The passes page does not show the request block yet.** It renders the pass's decisions and refusal, not `triggeredBy`. The block is in the row and in the passes API's `resultJson`.
