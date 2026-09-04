# Authentication

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md) — the developer onboarding guide.

Inflect's auth stack is **NextAuth v4.24.14 (stable)** with the
`@next-auth/prisma-adapter@1.0.7` Prisma adapter and a JWT session
strategy. Provider paths share one session shape:

| Provider | Files | Session shape |
|---|---|---|
| Credentials (email + password) | `src/lib/auth/credentials.ts`, `src/lib/auth/passwords.ts`, `src/lib/auth/credential-rate-limit.ts` | JWT with `userId`, `tenantId`, `role` |
| Google OAuth | `src/auth.ts` | Same JWT shape, tenant resolved post-signIn |
| Microsoft Entra ID (via v4's `azure-ad` provider — same OAuth endpoints, Microsoft renamed the product to "Entra ID") | `src/auth.ts` | Same JWT shape |
| SAML/SSO | `src/app/api/auth/sso/` | Same JWT shape, tenant resolved via SAML attribute |

This doc is the operator-facing reference for the credentials path. For
a deeper architectural rationale, see
`docs/implementation-notes/2026-04-22-auth-*.md` (early hardening) and
`docs/implementation-notes/2026-04-25-gap-04-nextauth-v4-migration.md`
(v5-beta → v4 migration).

> [!IMPORTANT]
> **GAP-04 — production stack.** This codebase migrated off
> `next-auth@5.0.0-beta.30` to `4.24.14` (stable) on 2026-04-25.
> Both `next-auth` and `@next-auth/prisma-adapter` are pinned exactly
> in `package.json`; silent drift is blocked by lockfile + a
> structural guardrail at `tests/guardrails/auth-stack-pinning.test.ts`.

## Type augmentation — extending Session and JWT safely

The codebase stores 15+ custom fields on the JWT (memberships, MFA
state, session-tracker id, OAuth refresh tokens, sessionVersion). Two
module augmentations in `src/auth.ts` declare these once so every
read site is statically typed end-to-end:

```ts
declare module 'next-auth' {
    interface Session { user: { id, email, tenantId, role, mfaPending, memberships, … } }
}
declare module 'next-auth/jwt' {
    interface JWT { userId, sessionVersion, tenantId, role, memberships, mfaPending, … }
}
```

To add a new field, declare it in BOTH augmentations (if it's
client-facing) or just in `JWT` (if it's server-only — accessToken,
refreshToken, mfaFailClosed, error). The middleware reads
`token.role` / `token.memberships` directly with full type safety.

**There are zero `as any` casts in the auth-critical path** — the
v5-beta-era 8 casts were eliminated as part of GAP-04. The
guardrail at `tests/guardrails/auth-stack-pinning.test.ts` fails CI
if a future PR reintroduces them in `src/auth.ts`,
`src/middleware.ts`, or `src/app/api/auth/[...nextauth]/route.ts`.

## Server-side helpers

| Helper | Where to use | What it does |
|--------|--------------|--------------|
| `getServerSession(authOptions)` | New code, all server contexts | The canonical v4 helper. Returns `Session \| null`. |
| `auth()` | Existing 15+ server-component sites | Back-compat shim for the v5 export name. Internally calls `getServerSession(authOptions)`. New code should not use it. |
| `signOut({ redirectTo })` | The 2 pages that log a user out before showing a "no access" UI | Server-side shim for v5's `signOut`. Redirects to `/api/auth/signout?callbackUrl=…`. |
| `next-auth/react.signIn` / `signOut` | Client components | The standard NextAuth client API. Unchanged from v5. |

## Middleware enforcement

`src/middleware.ts` reads the JWT directly via `getToken({ req,
secret: env.AUTH_SECRET })` and applies five gates:

1. Public-path allowlist (login, auth callbacks, static, etc.)
2. Unauth → `401 JSON` for API routes, `redirect(/login?next=…)` for pages
3. Admin-path role check (ADMIN ∪ OWNER) + Sec-Fetch-Site cross-site CSRF guard
4. MFA enforcement when `token.mfaPending === true` and the path is not
   in the MFA-allowed list (challenge / enrollment / signout)
5. Tenant-access gate — the URL slug must appear in `token.memberships`

All gate decisions read from the JWT — zero DB hits per request.

## Credentials flow

```
                 POST /api/auth/callback/credentials
                                │
                                ▼
                     NextAuth Credentials.authorize
                                │
                                ▼
                    authenticateWithPassword       ← src/lib/auth/credentials.ts
                        │
                        ├─▶ checkCredentialsAttempt (per-email rate limit)
                        ├─▶ prisma.user.findUnique by lowercased email
                        ├─▶ verifyPassword vs stored bcrypt hash
                        │      (dummy-compare on unknown email → timing-safe)
                        ├─▶ if AUTH_REQUIRE_EMAIL_VERIFICATION=1 and
                        │   user.emailVerified is null → reject
                        ├─▶ silent rehash-on-verify (if BCRYPT_COST ↑)
                        ├─▶ resetCredentialsBackoff (clear rate bucket)
                        └─▶ recordLoginSuccess → audit + structured log
                                │
                                ▼
                      JWT callback enriches with
                   userId / tenantId / role / MFA state
                                │
                                ▼
                    __Secure-authjs.session-token cookie
                    (HttpOnly, Secure, SameSite=lax, JWT in body)
```

Every failure path that isn't rate-limited runs the same bcrypt CPU
cost as the real-verify path (via `dummyVerify` in `passwords.ts`), so
an attacker can't enumerate registered emails via response time.

Every failure path collapses to `CredentialsSignin` on the client —
"Invalid credentials" regardless of whether the email exists, the
password is wrong, or the account isn't verified. The typed
`AuthResult.reason` (`credentials_invalid | email_not_verified |
rate_limited`) stays server-side for audit / observability.

## Registration flow

`POST /api/auth/register` body `{ action: 'register', email, password,
name, orgName }`. Creates the `User`, a personal `Tenant`, and an
`ADMIN` `TenantMembership` in sequence, then issues a verification
token (`issueEmailVerification`). Response is `{ user, tenant,
emailVerificationRequired: boolean }`; the client uses the last flag
to decide whether to show the "check your inbox" copy.

`action: 'login'` was removed on 2026-04-22 — login now flows
exclusively through NextAuth. `AuthLoginSchema` is gone from
`src/lib/schemas/`.

### Legacy `token` cookie — deprecated

> [!CAUTION]
> The register route also sets a legacy `token` HttpOnly cookie
> (signed via `signToken` from `@/lib/auth`, separate
> `LEGACY_JWT_SECRET`). **This cookie is unused by the product** —
> NextAuth's `__Secure-authjs.session-token` carries the session,
> and there are **zero callers of `verifyToken`** anywhere in the
> codebase, so the legacy cookie is never validated server-side.
>
> Kept for one more release in case any external integration reads
> it. The next release will:
>   - Drop the `cookies.set('token', ...)` in `register/route.ts`.
>   - Drop the `cookies.set('token', '', ...)` in `logout/route.ts`.
>   - Remove `signToken` + `verifyToken` from `@/lib/auth` (and the
>     `LEGACY_JWT_SECRET` env var).
>   - Add a structural ratchet rejecting reintroduction.
>
> **If an external integration depends on this cookie:** open an
> issue *during this window* with the consumer details, otherwise
> the next release will break it.

## Verification flow

```
               issueEmailVerification(email, { userId })
                        │
                        ├─▶ generate 32-byte raw token (hex)
                        ├─▶ sha256(raw) → store in VerificationToken
                        │      (raw NEVER touches DB)
                        ├─▶ prisma.$transaction: delete prior tokens
                        │   for this email + delete expired tokens
                        │   globally + create the new row
                        ├─▶ sendEmail with ${APP_URL}/api/auth/verify-email?token=<raw>
                        └─▶ recordEmailVerificationIssued → audit

               GET /api/auth/verify-email?token=<raw>
                        │
                        ├─▶ sha256(raw) → lookup VerificationToken
                        ├─▶ if expired → delete row → 302 ?verifyStatus=expired
                        ├─▶ if not found → 302 ?verifyStatus=invalid
                        ├─▶ prisma.$transaction: delete token + set
                        │   User.emailVerified = now()
                        ├─▶ recordEmailVerified → audit
                        └─▶ 302 ?verifyStatus=verified

               POST /api/auth/verify-email/resend  body: { email }
                        │
                        ├─▶ per-email rate limit (shared with login bucket)
                        ├─▶ if user exists AND !emailVerified →
                        │   issueEmailVerification (re-issue; prior links
                        │   invalidated by the deleteMany in the transaction)
                        └─▶ 200 + uniform copy, always (no enumeration)
```

- Token TTL: **24h** (`VERIFICATION_TOKEN_TTL_MS`)
- Token entropy: **256 bits** (32 bytes / 64 hex chars)
- Storage: **SHA-256 hash only**; raw lives in the email body, never in the DB
- Single-use: consume deletes the row inside the same transaction as
  `User.emailVerified = now()`
- Maintenance: `issueEmailVerification` opportunistically prunes all
  expired rows on every write. `pruneExpiredVerificationTokens()` is
  also exported for cron/job wiring if issuance ever becomes infrequent

## Audit event catalog

| Action | When | Tenant attribution |
|---|---|---|
| `AUTH_LOGIN_SUCCESS` | Successful credentials sign-in | User's first ACTIVE `TenantMembership` |
| `AUTH_LOGIN_FAILURE` | Wrong password for a *known* user | Same |
| `AUTH_LOGIN_RATE_LIMITED` | Per-identifier bucket tripped for a known user | Same |
| `AUTH_LOGIN_EMAIL_VERIFICATION_REQUIRED` | Gate on, user unverified | Same |
| `AUTH_EMAIL_VERIFICATION_ISSUED` | Token written, email queued | Same |
| `AUTH_EMAIL_VERIFIED` | Token consumed, `emailVerified` set | Same |

**Unknown-user failures** (email not registered) do **not** write
audit rows — no tenant to attribute to, and writing every attempt
would become a DoS sink. Those still leave structured logger entries
for SRE visibility (`event: "login_failure"`, `reason: "unknown_email"`,
`identifierHash`).

### Privacy invariants (enforced by tests)

- Raw email never written to audit `detailsJson` or structured logs —
  only `hashEmailForLog(email)`, a deterministic 16-char SHA-256 prefix
- Raw verification tokens never logged
- Passwords never logged, anywhere, ever
- `userId` suppressed from the `unknown_email` log line specifically,
  so a future log leak doesn't enable enumeration

## Rate limiting

**Two independent gates, same Upstash/memory fallback** (both in
`src/lib/rate-limit/authRateLimit.ts` and `src/lib/auth/credential-rate-limit.ts`):

| Gate | Key | Limit | Catches |
|---|---|---|---|
| Per-IP | SHA-256(ip + UA-hash) | 10 per 60s | Volumetric abuse from one source (any NextAuth endpoint) |
| Per-email | SHA-256(lowercased email) | 5 per 15-min sliding window | Credential stuffing across rotated IPs |

### Operator kill switches

Matching `authRateLimit.ts` semantics:

- `AUTH_TEST_MODE=1` — both gates short-circuit. E2E tests use this.
- `RATE_LIMIT_ENABLED=0` — both gates short-circuit. Emergency kill
  switch if Upstash misbehaves.

On Upstash exception (network partition, credential expiry), **both
gates fail open** — one log line per failure, auth path proceeds.
Losing logins across the fleet would be a bigger incident than letting
one extra brute-force attempt through.

### Reset-on-success

After a successful verify, the chokepoint calls
`resetCredentialsBackoff(email)` to clear the per-email counter. A user
who typo'd their password four times and then got it right isn't
locked out on the correct fifth attempt. Both stores are cleared
synchronously — the in-process memory fallback gets a `Map.delete`,
and Upstash mode gets a direct `DEL` on the sliding-window key via
the bare `Redis` singleton kept alongside the `Ratelimit` wrapper.
Failure on the Upstash `DEL` falls open (logs + lets the login
proceed; the bucket will age out within 15 minutes anyway) — better
than 500ing a successful login on a Redis blip.

## Cookie / session settings

`src/auth.ts` configures NextAuth cookies:

| Env | Cookie name | `Secure` | `SameSite` | `HttpOnly` |
|---|---|---|---|---|
| Prod (`NODE_ENV=production && AUTH_TEST_MODE !== '1'`) | `__Secure-authjs.session-token` | yes | lax | yes |
| Dev / test (`NODE_ENV=development` or `AUTH_TEST_MODE=1`) | `authjs.session-token` | no | lax | yes |

`SameSite=lax` is the NextAuth default and the right choice for OAuth
callback flows — `strict` breaks the redirect-from-Google step. Since
every mutating action in the app goes through either NextAuth's CSRF
token or per-endpoint double-submit patterns, `lax` doesn't weaken CSRF
protection.

Session is **JWT-only** — no server-side session table. The JWT carries
`userId`, `tenantId`, `role`, and MFA state (`mfaPending`,
`mfaFailClosed`). Revocation is through `User.sessionVersion` — the JWT
callback revalidates every 5 minutes in non-hot paths.

## Environment variable reference

Every flag the credentials path honors:

| Var | Required | Default | Effect |
|---|---|---|---|
| `AUTH_SECRET` | **yes** | — | NextAuth JWT signing secret (≥16 chars) |
| `JWT_SECRET` | yes (legacy) | — | Legacy `signToken` cookie (still issued by `/api/auth/register`) |
| `AUTH_TEST_MODE` | no | unset | `1` disables the `__Secure-` cookie prefix + `Secure` flag + **both** rate-limit gates. E2E tests set this |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | no | unset | `1` rejects credentials login when `User.emailVerified` is null. Default OFF so existing deployments behave unchanged |
| `RATE_LIMIT_ENABLED` | no | unset (= enabled) | `0` disables both rate-limit gates. Operator kill switch |
| `RATE_LIMIT_MODE` | no | `upstash` | `memory` to use in-process fallback (dev/CI) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | if `RATE_LIMIT_MODE=upstash` | — | Rate-limit backing store |
| `APP_URL` | no but recommended | unset | Base URL used to construct verification links in outbound email. Unset → relative URL which most mail clients won't render as clickable |
| `SMTP_FROM` / `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | if real email is needed | none — `SMTP_FROM` must be an address on a domain your relay has verified, or it rejects every message `550 ... domain is not verified`. Unset, senders fall back to `UNCONFIGURED_SENDER` in `src/lib/email/sender-identity.ts`, which is a placeholder and delivers nowhere | `src/lib/mailer.ts` picks `NodemailerProvider` when `SMTP_HOST` is set; otherwise `ConsoleEmailProvider` logs the message to stdout |

## Operational caveats

- **`AUTH_REQUIRE_EMAIL_VERIFICATION=1` requires a working mailer.**
  Otherwise newly-registered users can't log in. Test SMTP before
  flipping this flag in prod.
- **`AUTH_TEST_MODE=1` bypasses all rate-limit and cookie-hardening.**
  Never set in prod except as a rollback measure. Prefer
  `AUTH_REQUIRE_EMAIL_VERIFICATION=0` + OAuth-only if that's the goal.
- **Mailer failure does not fail register.** The token row is written
  before `sendEmail` runs; SMTP errors are swallowed inside
  `issueEmailVerification`. Two operator-facing signals fire on
  every send attempt — alert on either when SMTP is unreliable:
  - **OTel counter** `auth.verification_email.failed{flow=register|resend}`
    (paired with `.sent`). Non-zero `.failed` ahead of flipping
    `AUTH_REQUIRE_EMAIL_VERIFICATION=1` locks real users out of
    verification.
  - **Structured pino warn** `event=verification_email_send_failed`
    with `flow`, `userId`, and `error` fields.
- **Rate-limit counters reset on success.** A user who typo'd their
  password four times and then gets it right is not locked out. The
  attacker-who-just-learned-the-correct-password case is already past
  the point where more attempts matter.
- **Upstash failure → rate limit fails open.** Structured log line on
  every failure; alert on `component=rate-limit level=error` in Grafana.
- **Session version is the revocation mechanism.** Bump
  `User.sessionVersion` to force a user's active JWTs to be rejected
  on next request (or within 5 minutes, whichever comes first).

## Pre-prod checklist

Before flipping `AUTH_REQUIRE_EMAIL_VERIFICATION=1` in a live deployment:

- [ ] `SMTP_HOST` + creds set and verified with a test send
- [ ] `APP_URL` set to the canonical public URL (not a VM IP) so
      verification links are clickable in email clients
- [ ] Existing users without `emailVerified` audited — either backfill
      `emailVerified` for known-good accounts or communicate the flow
- [ ] Rate-limit config (`RATE_LIMIT_MODE=upstash` + creds) validated
      against a live Upstash project
- [ ] Audit action grep (`AUTH_LOGIN_*`, `AUTH_EMAIL_*`) wired into
      whatever dashboards / alerting the compliance team relies on
- [ ] `/api/auth/verify-email` verified reachable from the public
      internet (email links 302 back to `APP_URL/login`)
