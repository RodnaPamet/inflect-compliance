# API Rate Limiting

Inflect Compliance has **three distinct rate-limit tiers**, each scoped
to a different traffic class. None of them share a budget — a runaway
script that exhausts the read tier can still log in, and a credential
spray attack does not consume the read budget for legitimate users.

## Tiers

| Tier | Preset | Budget | Applied at | Key shape |
|------|--------|--------|------------|-----------|
| **Auth** | tiered (10/30/60 per min) | 10/min for sign-in callbacks; 30/min for session probes; 60/min for `/csrf` and `/providers` | Edge middleware | `(IP, ua-hash)` |
| **Mutation** | `API_MUTATION_LIMIT` | 60 per minute | Node route handlers via `withApiErrorHandling` | `(IP, userId)` |
| **Read** | `API_READ_LIMIT` | 120 per minute | Edge middleware | `(IP, userId, tenantSlug)` for a browser session; **`(IP, key-digest)` plus a shared `(IP)` bucket for an `iflk_` API-key request** — see *API-key callers* below |

All numbers are sized for normal interactive use — a real user filling
forms or paginating lists is well below every threshold. Scripts and
tests that need higher throughput should use a dedicated API key with
its own rate plan (future work) rather than share the interactive
budget.

## Where each tier lives

| Tier | Source of truth (preset) | Enforcement module | Storage |
|------|--------------------------|--------------------|---------|
| Auth | `src/lib/rate-limit/authRateLimit.ts` | same file | Upstash + memory fallback |
| Mutation | `src/lib/security/rate-limit.ts` (`API_MUTATION_LIMIT`) | `src/lib/security/rate-limit-middleware.ts::withRateLimit` | in-process Map (Node runtime) |
| Read | `src/lib/security/rate-limit.ts` (`API_READ_LIMIT`) | `src/lib/rate-limit/apiReadRateLimit.ts` | Upstash + memory fallback |

The **read** tier was added as part of GAP-17 closure. Pre-GAP-17 the
codebase had only auth + mutation tiers; tenant-scoped GETs were
unprotected. The new tier mirrors `authRateLimit.ts`'s edge-runtime
shape so it works inside the Next.js middleware (which runs on the
Edge runtime and can't import the Node-only `withApiErrorHandling`
wrapper).

## Read-tier scope

The read tier matches **only**:

- **GET method** — mutations have their own tier. POST/PUT/PATCH/DELETE
  on the same path go through `API_MUTATION_LIMIT` instead. **This is true
  of session-authenticated requests only**; an API-key request is metered
  here on every method — see *API-key callers* below.
- **Path starts with `/api/t/`** — i.e. tenant-scoped API routes. Auth
  routes (`/api/auth/*`) have their own Upstash limiter; admin / org
  routes are not currently throttled at this layer.

### Exclusions

The following paths are **never** read-throttled, even when they would
otherwise match (`GET /api/...`):

| Path | Reason |
|------|--------|
| `/api/health` | Legacy health probe — operators must keep monitoring access during attacks. |
| `/api/livez` | Modern Kubernetes liveness probe (sibling of `/api/health`). |
| `/api/readyz` | Modern Kubernetes readiness probe. |
| `/api/docs` | Per GAP-17 spec — not a current route, but listing it here means a future docs surface ships unthrottled. |

The exclusion check is **prefix-with-slash match** (`path === excluded ||
path.startsWith(excluded + '/')`), so `/api/health` matches but
`/api/healthcheck` does NOT (defensive against accidentally widening
the exclusion to similar-prefixed paths). There's an explicit test for
this in `tests/unit/api-read-rate-limit.test.ts`.

## Anonymous edge surfaces

A short list of paths is reachable with no session by design — the caller is
a browser beacon, an external respondent, a device agent or a deployment
operator, and it presents its credential (or none at all) to the handler
rather than to the edge. They sit on `MACHINE_CALLER_PREFIXES` or the
public-path list, so `src/middleware.ts` hands them straight through without
ever reaching the read-tier check above.

Each one therefore calls `checkApiReadRateLimit(req, null, '<scope>')`
itself, BEFORE the public-path early-return, borrowing the read tier's
budget and enforcement module under its own bucket namespace:

| Path | Scope key | Bucket |
|------|-----------|--------|
| `/trust/<slug>` | `trust:<slug>` | IP + slug |
| `/api/trust/**` | `apitrust:<slug>`, `apitrust:download` | IP + slug |
| `/api/t/<slug>/devices/report` | `devreport:<token prefix>` | IP + device token |
| `/vendor-assessment/**`, `/api/vendor-assessment/**` | `vendorassess:<id>` | IP + assessment id |
| `GET`/`HEAD` on `/api/security/csp-report`, `/api/csp-report` | `cspreport` | IP |

None of these are matched by `isApiReadRateLimited`, which stays scoped to
`/api/t/` GETs. The middleware calls the check directly so it can run ahead
of the allowlist, and so it can pick a bucket key the generic matcher has no
way to derive.

Two things in that table are easy to get wrong:

- **The CSP-report row is the one method-scoped entry.** `POST` on that path
  is a credential-less browser beacon, and a limiter it shares with an
  attacker loses real violation reports silently — so the POST is left to its
  own in-handler limiter (30 reports/IP/min, `checkReportRateLimit` in
  `src/lib/security/csp-violations.ts`) plus a 16 KB body cap, and the edge
  block skips it. The `GET` returns the process-wide violation buffer behind
  `PLATFORM_ADMIN_API_KEY`; 120/min bounds what an unauthenticated caller can
  spend of ours per IP, having previously been able to spend an unbounded
  amount.
- **Keying by the presented credential is a fairness decision, not a security
  one.** `devreport:` keys by the device bearer token because those tokens
  are issued, so many devices behind one NAT get independent buckets. The
  CSP-report GET keys by IP alone for the opposite reason: there the
  credential is the thing an attacker varies, so keying by it would hand
  every guess a fresh budget.

## API-key callers

An `iflk_` API-key request is metered here too, and by different keys, because
it reaches the edge without a session cookie.

`getToken` reads `Authorization: Bearer`, JWE-decodes it, throws on an `iflk_`
value and returns null — so before this was wired the middleware 401'd every
key request before `tryApiKeyAuth` could run, and the documented partner flow
in `docs/api-consumer-guide.md` could not work at all. The edge now recognises
the credential shape and falls through, leaving the handler as the sole
authority on whether the key is real.

Two buckets are charged, and the second is the load-bearing one:

| Bucket | Key | What it is for |
| --- | --- | --- |
| per-key | `apikey:<fnv1a32(token)>` | Fairness. Many partner keys behind one NAT get independent budgets, exactly as each device does on the posture-report path. |
| per-IP | `apikey-ip` | Containment. **The credential is the thing an attacker varies** — a random `iflk_` per request yields a fresh per-key bucket every time, so that meter alone bounds nothing for an unauthenticated flood. |

The containment bucket matters more since the edge stopped refusing these
outright: each request now reaches the App Router and costs one
`tenantApiKey.findUnique` before its 401, where previously it was a free edge
refusal.

Two differences from the session path, both deliberate:

- **Every method is metered**, not only GET. The method split exists because
  session mutations have their own tier keyed `(IP, userId)`; a key caller has
  no `userId` at the edge, so there is nothing to key that tier on.
- **The scope carries a digest, never the token.** `checkApiReadRateLimit` logs
  its scope at WARN on a 429, and a truncated key in a log line is a credential
  in a log line.

## Bucketing

The read tier keys by **`(IP, userId, tenantSlug)`** for a browser session.
Two consequences:

- **Per-tenant isolation**: the same user accessing tenant A and
  tenant B has two independent budgets. A runaway tab in tenant A
  cannot starve the user's quota in tenant B.
- **Per-user isolation within a tenant**: 10 users in one tenant each
  get their own 120/min budget. A single bad actor cannot deny
  service to coworkers.

The auth tier keys by `(IP, ua-hash)` because it runs pre-authentication
(no `userId` available yet); the mutation tier keys by `(IP, userId)`
because it runs in-handler after the wrapper has resolved the user.

## 429 response shape

When the read tier is exhausted, the middleware returns a 429 with:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 47
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1714328400000

{
  "error": {
    "code": "RATE_LIMITED",
    "scope": "api-read",
    "message": "Too many read requests. Retry after 47 seconds.",
    "retryAfterSeconds": 47
  }
}
```

The body **never** contains the IP, userId, or tenantSlug — those are
logged on the server side only. Clients get enough information to back
off intelligently and nothing extra. The `error.code` is stable across
all three tiers (`RATE_LIMITED`); `error.scope` distinguishes them
(`api-read` for this tier; `api-mutation` and `auth` for the others).

## Bypass gates (development & test)

Three env vars short-circuit rate limiting **for local dev and CI**:

| Env var | Effect |
|---------|--------|
| `RATE_LIMIT_ENABLED=0` | Operator override — disables ALL tiers. Never set in production. |
| `AUTH_TEST_MODE=1` | Set by Playwright + the e2e webserver. Skips auth + read tiers (mutation tier respects it via the wrapper). |
| `NEXT_TEST_MODE=1` | Belt-and-braces sibling of `AUTH_TEST_MODE` for the Next.js test build. |

Production cannot disable rate limiting without an explicit
`RATE_LIMIT_ENABLED=0`. Combined with [GAP-13](deployment.md) (Redis
required in production), this means a production deploy that boots at
all has rate limiting available.

## Tuning

If you need to adjust a budget:

1. **Find the preset** in `src/lib/security/rate-limit.ts` — this is
   the single source of truth for the auth-tier numbers (in the file)
   and the mutation/read tier numbers (`API_MUTATION_LIMIT`,
   `API_READ_LIMIT`).
2. **Change `maxAttempts` and/or `windowMs`** with a comment justifying
   the new values. Each preset already has a JSDoc threat-model note;
   keep that pattern.
3. **Re-run the tests**:
   - `tests/unit/api-read-rate-limit.test.ts` — read-tier behaviour
   - `tests/guardrails/api-read-rate-limit.test.ts` — structural shape
   - The mutation-tier tests in the same family

The `tests/guardrails/api-read-rate-limit.test.ts` ratchet specifically
asserts that `API_READ_LIMIT` has a 60-second window — anything longer
silently weakens the gate and would need an explicit ratchet update.

## Operational signals

Every blocked request emits a `warn`-level log line via the
edge-logger:

```
{ "level": "warn", "component": "rate-limit", "scope": "api-read",
  "tenantSlug": "acme-corp", "msg": "API read rate limit exceeded" }
```

The log line **does not include the IP or userId** (PII control). The
request-id stamped by middleware on every response ties the log entry
back to the offending caller for ops-side correlation.

For the auth tier, the same shape applies under
`component: 'rate-limit'` from `src/lib/observability/edge-logger.ts`.

For the mutation tier, the in-handler limiter logs at `debug` for
allowed and `warn` for blocked; same `component: 'rate-limit-middleware'`
namespace.

## Adding a new tier

1. Add the preset to `src/lib/security/rate-limit.ts` with a JSDoc
   threat-model note.
2. Re-export from `src/lib/security/rate-limit-middleware.ts` so the
   security barrel stays consistent.
3. **If applied at the Edge** (middleware): create a new module under
   `src/lib/rate-limit/` mirroring `apiReadRateLimit.ts` (Upstash +
   memory fallback). **If applied in route handlers**: use the
   existing `withRateLimit` wrapper.
4. Wire it into `src/middleware.ts` (Edge) or the relevant route
   handler (Node). Place edge checks AFTER auth gates — see the
   ratchet test for ordering rules.
5. Document the new tier here. Add a row to the table at the top.
6. Add a structural ratchet under `tests/guardrails/` mirroring
   `tests/guardrails/api-read-rate-limit.test.ts`.

## Cross-references

- **Production prerequisites**: [`docs/deployment.md`](deployment.md) — Redis is required (GAP-13).
- **Auth-tier details**: [`docs/auth.md`](auth.md) — login flow + brute-force protection.
- **Service-level objectives**: [`docs/slos.md`](slos.md) — production targets these limiters defend.
