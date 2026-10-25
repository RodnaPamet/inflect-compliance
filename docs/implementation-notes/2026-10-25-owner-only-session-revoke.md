# 2026-10-25 — Signing out an Owner or an AI admin is an Owner's act

**Commit:** see the PR

## Design

#4118 made deactivating or removing an OWNER-managed membership (OWNER,
AI_ADMIN) an Owner's act. Revoking that person's sessions was still open to
any Admin, through two routes: `POST security/sessions/revoke-user` (every
session of one person) and `DELETE admin/sessions` (one session, from the
members page's Sessions dialog). The owner decided the targeted sign-out
follows the deactivation rule.

```
revokeUserSessions(ctx, target)      ─┐
DELETE admin/sessions {sessionId}    ─┴─► assertMayRevokeSessionsOf(ctx, { userId, role })
                                            self            → allowed
                                            OWNER/AI_ADMIN  → needs admin.owner_management (403, named)
                                            anyone else     → allowed
revokeAllTenantSessions              ──► not asked
```

The rule reads the target's membership role in this workspace, whatever its
status, as the deactivation rule does. The members page hides the Revoke
buttons in the Sessions dialog for such a member and says who can; the security
page's person picker carries no roles, so its field says so up front and the
server's refusal is shown if an Admin tries.

## Files

| File | Role |
| --- | --- |
| `src/lib/roles.ts` | `OWNER_MANAGED_SESSION_REVOKE_REFUSAL` and its message |
| `src/app-layer/usecases/session-security.ts` | `assertMayRevokeSessionsOf` / `…OfUser`; `revokeUserSessions` asks it |
| `src/app/api/t/[tenantSlug]/admin/sessions/route.ts` | DELETE asks it before revoking |
| `src/app/t/[tenantSlug]/(app)/admin/members/page.tsx` | Sessions dialog hides Revoke for an Owner-managed member |
| `src/app/t/[tenantSlug]/(app)/admin/security/page.tsx` | The picker's field explains the rule to a non-Owner |

## Decisions

- **Revoke All is not narrowed** (owner decision). It is the incident lever:
  signing everyone out after a compromise must not leave an Owner's stolen
  session alive because an Admin pressed it. It is audited as
  `ALL_TENANT_SESSIONS_REVOKED`.
- **One's own sessions are always one's own.** An AI admin revoking a session of
  their own through the members dialog is not refused, and the role is not
  even read.
- **No `AUTHZ_DENIED` row for the refusal**, matching the deactivation rule it
  copies: both are usecase refusals under a route `requirePermission` that
  already passed.
