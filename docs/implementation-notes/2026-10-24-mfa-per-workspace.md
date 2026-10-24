# 2026-10-24 — MFA is asked of every workspace, not only the first

**Commit:** `fix(auth): every workspace's MFA policy applies, not only the oldest one's`

## Design

Sign-in evaluated the MFA policy of one workspace: `token.tenantId`, the
session's primary, which is the member's oldest membership. Nothing asked any
other workspace. Someone who joined a workspace that requires MFA after one that
does not was never challenged there: the workspace said Required, and its
members got in on a password.

```
sign-in        mfaPending            ← primary's policy (unchanged)
               mfaPendingTenantIds   ← every OTHER reachable workspace whose policy asks
                                       (REQUIRED, or OPTIONAL with a verified enrolment)
each request   drop each pending workspace whose challenge was passed since `iat`
claims refresh drop workspaces left; ask any workspace gained since sign-in
               (a token from before this change asks all of them once)
edge           mfaPending           → whole session to /t/<primary>/auth/mfa
               pending workspace    → its own paths, and /org/**, to /t/<slug>/auth/mfa
challenge      verifies the code against the URL's workspace (active members only)
```

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/workspace-mfa.ts` | Which workspaces ask, which are still pending, the refresh rule, and the URL workspace for a challenge |
| `src/auth.ts` | The pending set at sign-in, its clearing on each request, and its refresh with the claims |
| `src/lib/auth/guard.ts` | `pendingMfaWorkspaceSlug`: the workspace a request must pass first |
| `src/middleware.ts` | Holds a pending workspace's paths. A pending primary goes to the primary's challenge |
| `src/app/api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts` | Verifies against the URL's workspace |

## Decisions

- **The primary keeps its own flag.** `mfaPending` still holds the whole
  session, and the fail-closed setting still reads the primary. Everything
  already built on that flag is unchanged.
- **Another workspace holds only its own paths, plus org paths.** Holding the
  whole session for a workspace a person rarely opens would lock them out of
  the one they work in. Org routes are held because an org portfolio includes
  the pending workspace, the reasoning the primary's org rule already uses.
- **The challenge verifies the URL's workspace.** Enrolment is per workspace,
  so each workspace's code is its own. The primary's redirect now names the
  primary's own slug, where it used to prefer the URL's. Before, a primary
  pending on `/t/<other>/…` was sent to the other workspace's page, which then
  checked the primary's code anyway.
- **A read failure at sign-in fails open for the other workspaces**, as the
  primary does unless it is set to fail closed. A failure while clearing
  leaves them pending; the person can still pass the challenge.
- **Existing sessions** pick the check up when their cookie is next rewritten
  (a sign-in, or the session refresh the challenge page makes). An admin who
  wants it at once can revoke the workspace's sessions, which is enforced since
  #4119.
