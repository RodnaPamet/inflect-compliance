# 2026-10-24 — A revoked session is refused

**Commit:** `fix(auth): a revoked session is refused, not merely flagged`

## Design

Epic C.3 records a revocation correctly: `UserSession.revokedAt`, and a
`User.sessionVersion` bump as a backstop. The `jwt` callback noticed both. It
then returned the token with `error: 'SessionRevoked'`, every claim still on
it. Nothing read the flag: not the `session` callback, not `getSession()`, and
no tenant or org gate. So none of these signed anybody out:
- an admin revoking a member's sessions;
- "Revoke All User Sessions";
- the sign-out-everywhere step of a password change or reset;
- the per-workspace session age limit.

```
jwt callback (every server-side session read)
  verifyAndTouchSession → revoked/expired  ──► throw SessionRevokedError('session_revoked')
  sessionVersion bumped (5-min throttle)   ──► throw SessionRevokedError('session_version_bumped')

NextAuth v4 core/routes/session.ts
  catch(error) → body {}  (+ clear cookie where it can)
  getServerSession: empty body → null
  auth() / getSession() → null → every DB-backed gate refuses → sign-in page
```

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/session-revoked.ts` | `SessionRevokedError` and its two reasons |
| `src/auth.ts` | Both revocation checks throw, outside their fail-open `try`; a NextAuth `logger.error` logs a revocation at info level |
| `tests/unit/sso-handoff-session.test.ts` | The real NextAuth route and `auth()`: a live session reads as itself, and once its row is revoked the server sees none and the session endpoint clears the cookie |

## Decisions

- **Throw, not a stripped token.** NextAuth v4 already treats a throw from
  `jwt` as an invalid session, and that reaches every reader at once: `auth()`,
  `getServerSession` called directly, and `/api/auth/session`. Stripping claims
  would leave `sub` behind, and making `Session.user` optional would touch
  every caller.
- **Outside the `try`.** Both checks fail open on a database error, so a
  transient blip does not sign everyone out. A throw inside the `try` would be
  swallowed by that same `catch`.
- **The edge is unchanged.** The middleware decodes the cookie without running
  the callback, so a revoked browser passes the edge and is refused at the first
  server gate. The middleware does not redirect a signed-in token away from
  `/login`, so this does not loop.
- **A NextAuth `logger.error`.** Without it, every request from a revoked browser
  logged `[next-auth][error][JWT_SESSION_ERROR]` with a stack through
  `console.error`, until the person signed in again. Server components cannot
  clear the cookie, so that repeats on each request. Other NextAuth errors now
  go to the structured logger with their message only.
