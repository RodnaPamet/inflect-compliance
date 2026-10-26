# MFA & Session Security — Architecture & Operations Guide

## Overview

Epic 4 implements tenant-level MFA enforcement, TOTP enrollment, session revocation, and brute-force protections. All features are tenant-scoped with server-side enforcement only.

The *policy* is tenant-scoped; the *enforcement* is not. `mfaPending` is set
from the active tenant's `mfaPolicy` and then rides the session, so the edge
gate applies it to every authenticated request the user makes — tenant routes,
the 93 flat API routes, `/api/org/**` and `/api/admin` alike. Until #2223 the
gate was keyed on the `/t/` URL prefix instead, which left everything outside
that prefix reachable mid-challenge — including `GET /api/audit-log` and
`GET /api/evidence`. The allowlist (`isMfaAllowedPath` in
`src/lib/auth/guard.ts`) is the only thing that softens enforcement, and it
holds just the challenge page, the enrolment page, their APIs, and
`/api/auth/`. Public and machine-caller paths need no entry: `isPublicPath`
returns them before the JWT is read.

## Architecture

```
Login → JWT callback → check tenant MFA policy
 ├─ DISABLED → full access
 ├─ OPTIONAL + enrolled → mfaPending=true → challenge
 ├─ OPTIONAL + not enrolled → full access
 └─ REQUIRED → mfaPending=true → challenge

Middleware intercepts EVERY authenticated request when mfaPending=true
 ├─ Pages → redirect to /t/[slug]/auth/mfa   (slug from the URL, else the token)
 ├─ APIs → 403 "MFA verification required"
 └─ MFA challenge + enrolment + /api/auth/ → allowed (exempt)

Session revocation: sessionVersion bump (all of a person's JWTs) or
UserSession.revokedAt (one sign-in each, named by the JWT's userSessionId)
 └─ JWT callback detects either → SessionRevokedError → no session
```

## MFA Policy Modes

| Policy | Not Enrolled | Enrolled (verified) | Admin Protection |
|--------|-------------|-------------------|------------------|
| **DISABLED** | Full access | Full access | None needed |
| **OPTIONAL** | Full access | Challenge at login | — |
| **REQUIRED** | Redirect to enrollment | Challenge at login | Anti-lockout check |

## TOTP Enrollment

- **Algorithm**: RFC 6238 (SHA-1, 30s step, 6 digits)
- **Crypto**: Pure Node.js `crypto` — no external TOTP library
- **Storage**: AES-256-GCM encrypted secrets, HKDF-derived keys from `AUTH_SECRET`
- **Never logged**: TOTP codes, secrets, otpauth URIs

### Enrollment Flow
1. `POST /security/mfa/enroll/start` → generates secret, returns `otpauthUrl` + `secret`
2. User scans QR or copies setup key into authenticator app
3. `POST /security/mfa/enroll/verify` → verifies first code, marks enrollment as verified
4. On next login, if policy requires → challenge page

## Session Revocation

**Strategy**: two mechanisms, both checked by the JWT callback in `src/auth.ts`, which throws `SessionRevokedError` on either.

- `User.sessionVersion` — incrementing it invalidates every JWT the person holds, the one making the request included. It is how "revoke everything" works.
- `UserSession.revokedAt` — one row per sign-in, named by the JWT's `userSessionId`. Stamping rows revokes those sign-ins only, which is the only way to sign out a person's other sessions and keep the current one.

A session belongs to the person, not to a tenant, so either mechanism signs the person out of every workspace. Logic lives in `src/app-layer/usecases/session-security.ts`.

### Endpoints

| Endpoint | Access | What it revokes | Audit Event |
|----------|--------|-----------------|-------------|
| `POST /security/sessions/revoke-current` | Self | Every session of the caller's except the one making the request. When that session cannot be identified (no live `UserSession` row for the token's `userSessionId`), every session, and the response says `currentSessionKept: false` | `OTHER_SESSIONS_REVOKED`, or `CURRENT_SESSION_REVOKED` when nothing could be kept |
| `POST /security/sessions/revoke-user` | Admin | Every session of one member | `SESSIONS_REVOKED_FOR_USER` |
| `POST /security/sessions/revoke-all` | Admin | Every session of the tenant's ACTIVE members; the caller's current session is kept as above | `ALL_TENANT_SESSIONS_REVOKED` |

## Brute-Force Protection

### MFA Challenge Verify
- **Limit**: 5 attempts per 15 minutes
- **Lockout**: 5 minute lockout after exhaustion
- **Reset**: On successful verification

### MFA Enrollment Verify
- **Limit**: 10 attempts per 15 minutes
- **No lockout** (enrollment is less sensitive than login-time challenge)

### Implementation
In-memory sliding-window rate limiter (`src/lib/security/rate-limit.ts`). For multi-instance deployments, swap to Redis-backed limiter.

## Anti-Lockout Safeguards

### REQUIRED Policy Guard
When enabling REQUIRED MFA policy, the system verifies at least one admin in the tenant has a verified TOTP enrollment. This prevents all admins from being locked out.

**Error**: `"Cannot enable REQUIRED MFA: at least one admin must be enrolled in MFA first."`

### Break-Glass Recovery
- Local login remains accessible for SSO-bypass if configured
- Admin can always downgrade policy from REQUIRED → OPTIONAL → DISABLED
- Session revocation does not affect login ability (login page is public)

## Audit Events

These are the audit events actually emitted today (via `logEvent`):

| Event | When | Emitted from |
|-------|------|--------------|
| `MFA_CHALLENGE_PASSED` | Successful login-time MFA challenge | `mfa-challenge.ts` |
| `MFA_CHALLENGE_FAILED` | Failed login-time MFA challenge | `mfa-challenge.ts` |
| `OTHER_SESSIONS_REVOKED` | User signs out their other sessions | session-revoke routes |
| `CURRENT_SESSION_REVOKED` | User revokes all own sessions, the current one included | session-revoke routes |
| `SESSIONS_REVOKED_FOR_USER` | Admin revokes a user's sessions | session-revoke routes |
| `ALL_TENANT_SESSIONS_REVOKED` | Admin revokes all tenant sessions | session-revoke routes |
| `MFA_POLICY_CHANGED` | The tenant MFA policy changes; `detailsJson.before` / `after` carry the old and new policy | `mfa.ts` |
| `SESSION_MAX_AGE_CHANGED` | The tenant's maximum session age changes; `before` / `after` carry the old and new minutes (`null` is the default) | `mfa.ts` |

**Safety**: Audit details never contain TOTP codes, secrets, session tokens, or otpauth URIs.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | Used for TOTP secret encryption (AES-256-GCM with HKDF) |
| `NODE_ENV` | Controls secure cookie flags |

## Routes Reference

### Admin Routes
| Route | Purpose |
|-------|---------|
| `/t/[slug]/admin/security` | Security settings page (MFA policy + session management) |

### User Routes
| Route | Purpose |
|-------|---------|
| `/t/[slug]/security/mfa` | MFA enrollment and status |
| `/t/[slug]/auth/mfa` | MFA challenge page (during login flow) |

### API Routes
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/security/mfa/policy` | Read tenant MFA policy |
| PUT | `/security/mfa/policy` | Update tenant MFA policy (admin) |
| POST | `/security/mfa/enroll/start` | Start TOTP enrollment |
| POST | `/security/mfa/enroll/verify` | Verify enrollment code |
| GET | `/security/mfa/enroll` | Get enrollment status |
| DELETE | `/security/mfa/enroll` | Remove enrollment |
| POST | `/security/mfa/challenge/verify` | Login-time TOTP challenge |
| POST | `/security/sessions/revoke-current` | Revoke own sessions |
| POST | `/security/sessions/revoke-user` | Revoke user sessions (admin) |
| POST | `/security/sessions/revoke-all` | Revoke all tenant sessions (admin) |

## Future Work (Non-Blocking)

- **Backup codes**: Not implemented. Add as an alternative 2FA method when the user loses their authenticator. Requires schema addition and separate verify flow.
- **Redis rate limiting**: Current in-memory limiter works for single-instance. For HA/multi-instance, replace with Redis-backed sliding window.
- **QR code rendering**: Challenge page shows a setup key and QR icon placeholder. Add a real QR code library (e.g., `qrcode`) for better enrollment UX.
- **Admin MFA enrollment reset**: Let admins reset a user's MFA enrollment (for lost device recovery). Currently users must contact admin to downgrade policy.
- **Enrollment audit events**: the action names `MFA_ENROLLMENT_STARTED`, `MFA_ENROLLED` and `MFA_ENROLLMENT_VERIFY_FAILED` are reserved but NOT yet emitted — `mfa-enrollment.ts` makes no `logEvent` calls. Wire `logEvent` into the enrollment start/verify/remove paths so these surface in the audit trail alongside the policy, challenge and session-revoke events above.
