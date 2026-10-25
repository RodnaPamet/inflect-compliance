# 2026-10-25 — Security & MFA page: sessions kept, revocations scoped, pre-flight from the gate

**Commit:** `fix(security): sign out other sessions keeps this one, and the page stops guessing` (#4117)

## Design

Two revocation mechanisms already existed, and the page only ever used the blunt one.

```
User.sessionVersion bump      every JWT of the person dies, the requesting one included
UserSession.revokedAt stamp   one sign-in each, named by the JWT's userSessionId
```

"Sign Out Other Sessions" called `revokeUserSessions(ctx, ctx.userId)`, a version bump, so it
signed out the session that clicked it. It is now `revokeOtherSessions(ctx, currentSessionId)`:
the route reads `userSessionId` from the verified session token (`currentSessionIdOf`, a
`getToken` read in `session-tracker.ts`), the usecase checks that row is the caller's own and
live, and stamps every OTHER live row of the caller's. No version bump. When the current
session cannot be named — no id on the token, no row, a row that is revoked, expired or someone
else's — the others cannot be told apart from it, so everything is revoked (bump plus rows) and
`currentSessionKept: false` tells the page to go to the sign-in page.

"Revoke All" reads ACTIVE memberships only (owner decision). For every member but the caller
it bumps the version and stamps their live rows; for the caller it does what "Sign Out Other
Sessions" does. A session belongs to the person, so this signs members out of every workspace,
and the confirm dialog says so. `revokeUserSessions` also stamps the target's rows now, so the
Members page's session count stops listing sessions that are already dead.

The agent-enforcement pre-flight ("would stop working") used its own rule: every live key with
`agentId: null`. Enforcement is `assertRegisteredAgent`, called only from `/api/mcp`
(`authenticateMcpRequest`, `exchangeMcpToken`), behind `admitsMcpEndpoint`. The gate's decision
was extracted into a pure `verdictForBinding(enforcing, boundAgentId, agentRow)` that
`evaluateAgentRegistration` now calls, and `keysRefusedWhenEnforcing` applies the capability
gate and then that verdict to a batch of keys, reading agents with the gate's own scope and
select. The pre-flight hands it every live key.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/session-security.ts` | `revokeOtherSessions`; Revoke All over ACTIVE members, keeping the caller's session; rows stamped on every full revocation |
| `src/lib/security/session-tracker.ts` | `currentSessionIdOf(req)` — the JWT's `userSessionId`, or null |
| `src/app/api/t/[tenantSlug]/security/sessions/revoke-current/route.ts`, `revoke-all/route.ts` | Pass the current session id; report `currentSessionKept` |
| `src/lib/agentic/agent-registration-gate.ts` | `verdictForBinding` (pure, shared) and `keysRefusedWhenEnforcing` |
| `src/app-layer/usecases/tenant-security-settings.ts` | Pre-flight computed by the gate's code |
| `src/app-layer/usecases/mfa.ts` | `MFA_POLICY_CHANGED` / `SESSION_MAX_AGE_CHANGED` with before/after |
| `src/app/t/[tenantSlug]/(app)/admin/security/*` | Load error blocks Save; `ConfirmDialog`; `UserCombobox`; `apiErrorMessage` in both cards; 403-only permission note |

## Decisions

- **Rows, not a re-issued cookie.** Keeping the current session through a version bump would
  mean re-encoding and setting the session cookie from the route. Stamping rows needs nothing
  new and is checked on every request (the version check is throttled). The residue: a token
  whose row insert failed at sign-in (`recordNewSession` swallows that) is not revoked by "Sign
  Out Other Sessions". It is revoked by every full revocation, which still bumps the version.
- **Fail towards revoking everything.** An unidentifiable current session revokes it too. The
  alternative, revoking nothing, would leave a stolen session alive behind a success message.
- **The caller is not in the Revoke All version bump**, or the kept session would die with it.
- **The pre-flight shares the decision, not a copy of it.** A key the capability gate refuses
  never reaches the registration gate, so it is not listed; a key bound to a DRAFT, SUSPENDED or
  RETIRED agent, or to one the register no longer holds, is refused like an unbound one, so it is.
- **The member picker leaves the caller out.** Picking yourself would revoke your current session
  too; "Sign Out Other Sessions" is the self action. The server still accepts any member, and an
  Admin may still revoke an Owner's sessions (owner decision, unchanged).
- **The MFA audit is not best-effort**, matching the other security-settings writer: a failed
  audit write fails the request rather than reporting an unrecorded change as a success.
- **`revoke-current` is a `SESSION_SELF_SERVICE` exemption** in the layer-2 authorization
  guardrail. It used to pass on `revokeUserSessions`' `canAdmin` check, which guarded only the
  other-user branch and so never applied to it.
