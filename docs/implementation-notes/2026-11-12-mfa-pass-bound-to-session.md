# 2026-11-12 — MFA pass bound to the session; TOTP codes accepted once

## Design

- `verifyMfaChallenge(userId, tenantId, code, remaining, userSessionId)` refuses
  before checking the code when the request names no live session of this user
  (`currentSessionIdOf` reads the JWT's `userSessionId`). On a right code it
  claims the code's time step on the enrolment, then appends the workspace to
  the session's `UserSession.mfaPassedTenantIds`.
- The jwt callback clears the primary workspace's `mfaPending`, and
  `workspacesStillAskingForCode` clears the others, only from that session's
  own row (`workspacesPassedBySession`).
- `matchTotpStep` returns the RFC 6238 step a code matched. The enrolment stores
  `lastAcceptedTotpStep`; a code is accepted only for a later step, through a
  conditional `updateMany`, so a replay or a concurrent second use fails.
  Enrolment verification records its step too, so the enrolling code cannot
  also pass the challenge.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma`, migration `20261112140000_mfa_pass_bound_to_session` | The two columns |
| `src/app-layer/usecases/mfa-challenge.ts` | Session binding and the step claim |
| `src/lib/auth/workspace-mfa.ts` | `workspacesPassedBySession`; pending workspaces read the session row |
| `src/auth.ts` | Primary `mfaPending` reads the session row |
| `src/lib/security/totp-crypto.ts` | `matchTotpStep` |
| `src/app/api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts` | Passes the session id; the unread `mfa-cleared` cookie is gone |

## Decisions

- **The session row, not the enrolment, holds the pass.** The enrolment is one
  row per person and workspace; a per-session fact on it cannot tell sessions
  apart.
- **No session, no pass.** A request without a live `UserSession` cannot bind a
  pass, so it is refused before the code is checked rather than passing
  unbound. The person signs in again.
- **`lastChallengeAt` is still written**, for display; nothing decides on it.
