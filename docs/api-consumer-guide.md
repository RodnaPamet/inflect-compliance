# API Consumer Guide

For external consumers of the Inflect Compliance API — partner SDK
authors and customers building integrations.

This guide is the companion to the machine-readable spec. It explains
**what's published where**, **how to authenticate**, **what rate limits
and errors you'll observe**, and **how versioning works**. It does NOT
cover product features — see the in-app help for that.

> **Not in this guide / not shipped yet:** a public Developer Portal
> with tutorials and quickstarts (this is the reference, not a portal),
> per-tenant usage dashboards, an API status/uptime page, and
> first-party SDKs. Once you have `openapi.json` (below) you can
> generate a typed client yourself with `openapi-typescript` or
> `openapi-generator-cli`.

---

## 1. `/api/docs` vs `/openapi.json` — what's where

| Artefact | What it is | Where it's available |
|---|---|---|
| **`/openapi.json`** | The machine-readable OpenAPI 3.1 spec — the source of truth for paths, methods, schemas, and security. Generated from the server's Zod schemas. | **All environments, including production.** This is the public-facing artefact. |
| **`/api/docs`** | Interactive Swagger UI rendered over `/openapi.json`, with an **Authorize** button and "Try it out". | **Dev / staging only.** Returns **404 in production** by design (see below). |

### Why `/api/docs` is dev/staging-only (and that's fine)

The interactive HTML reveals every endpoint's shape at a single GET.
That's a convenience for partners on staging, but extra fingerprinting
surface in production. So production exposes only the **static
`/openapi.json`** — you get the complete contract, machine-readable,
with zero interactive attack surface. Render it yourself anywhere:

```bash
# Fetch the spec
curl -fsS https://app.example.com/openapi.json -o inflect-openapi.json

# Render it locally in Swagger UI
npx @redocly/cli preview-docs inflect-openapi.json
# …or import inflect-openapi.json into Postman / Insomnia
# …or generate a client:
npx openapi-typescript inflect-openapi.json -o inflect-client.d.ts
```

### Coverage: critical endpoints vs. stubs

Every route in the product appears in `openapi.json`. Operations are one
of two kinds:

- **Fully documented** — the "critical endpoint set" (tenant CRUD for
  risks/controls/tasks/assets/policies/vendors, auth, admin, audit)
  carries complete request bodies, response schemas, the required
  permission (`x-required-permission`), and the rate-limit preset
  (`x-rate-limit`).
- **Stubs** (`x-stub: true`) — the route exists and is callable, and
  its path, method, and path parameters are accurate, but its request/
  response body is not published in the contract. Treat a stub as
  "this endpoint is real; confirm its payload empirically or ask us".

---

## 2. Authentication

Two transports. Both resolve to the same per-request tenant context and
permission set on the server.

### API key — `Authorization: Bearer iflk_…` (use this for integrations)

This is the **canonical partner flow**. Mint a key in the app under
**Admin → API Keys**; it is shown once. Keys are prefixed `iflk_`,
stored only as a hash, and scoped (the scopes map to the same
permission model as a user role).

```bash
curl -fsS https://app.example.com/api/t/<tenantSlug>/risks \
  -H "Authorization: Bearer iflk_live_xxx"
```

In Swagger UI (dev/staging), click **Authorize → BearerAuth** and paste
the key (no `Bearer ` prefix — Swagger adds it).

### Session cookie — `next-auth.session-token` (browser / dev only)

When you're signed in to the app in a browser, requests carry a NextAuth
JWT **cookie** automatically (same-origin). This is what powers
Swagger UI's "Try it out" on dev/staging after you sign in. It is **not**
a partner integration mechanism — there's no supported way to extract
and replay the cookie from outside the browser, and it's tied to the
session lifetime. Prefer an API key for anything programmatic.

### Which to use

| You are… | Use |
|---|---|
| A partner / customer integration, a script, a CI job, an SDK | **API key** (`Authorization: Bearer iflk_…`) |
| A developer clicking "Try it out" in Swagger UI on dev/staging | **Session cookie** (just sign in first) |

### Tenant scoping

Almost every data endpoint is tenant-scoped: `/api/t/{tenantSlug}/…`.
The `{tenantSlug}` in the URL must match the tenant your credential
belongs to — a mismatch is a `403`. The credential carries the tenant;
the slug in the path selects it.

---

## 3. Rate limiting

Three tiers, each scoped to a traffic class. All limits are per-minute,
keyed per IP + identity (and per tenant for reads).

| Tier | Applies to | Default limit |
|---|---|---|
| **Read** (`API_READ_LIMIT`) | Tenant-scoped `GET /api/t/<slug>/…` | 120 / min |
| **Mutation** (`API_MUTATION_LIMIT`) | `POST` / `PUT` / `PATCH` / `DELETE` | 60 / min |
| **Auth** | Sign-in / session / csrf endpoints | 10–60 / min (per endpoint) |

Stricter presets apply to a few sensitive routes (login, API-key
creation, email dispatch). The `x-rate-limit` extension on each
documented operation in `openapi.json` names the preset that applies.

### API-key callers: one extra edge meter

A request authenticated with `Authorization: Bearer iflk_…` is metered at
the edge under the **read** budget (120 / min) on **every** method, not
just `GET`, and the bucket is keyed per **key** rather than per tenant —
so two keys in the same tenant, or one key called from two IPs, never
starve each other. This is the only pre-handler cost bound on a
credential the edge cannot verify (there is no database at the edge), so
it applies before the key is known to be real.

Mutations then also pass the 60 / min mutation tier inside the handler,
which is the tighter of the two — so the effective write budget for a key
is unchanged at 60 / min, and the effective read budget is 120 / min.
Both surface as the same 429 contract below.

### What you observe

Every rate-limited response is **HTTP 429** with this header contract:

| Header | Meaning |
|---|---|
| `Retry-After` | Seconds to wait before retrying. **Honour this** — it's the canonical backoff signal. |
| `X-RateLimit-Limit` | The ceiling for this window. |
| `X-RateLimit-Remaining` | Requests left in the current window. |
| `X-RateLimit-Reset` | When the window resets (epoch seconds). |
| `x-request-id` | Correlation id (present on every response, not just 429s). |

The 429 body is the standard error envelope (below) with
`code: "RATE_LIMITED"`. The body never echoes your IP, user id, or
tenant slug. **Recommended client behaviour:** on a 429, sleep
`Retry-After` seconds (with jitter) and retry; back off exponentially if
you keep hitting it.

Health probes (`/api/health`, `/api/livez`, `/api/readyz`) and
`/api/docs` are excluded from the read limiter so monitoring survives
an attack.

---

## 4. Versioning

`openapi.json`'s `info.version` carries the **release version** of the
deployed API (semver, sourced from `package.json`). The contract — the
schema shapes, paths, and security — is what's versioned, not the
package number per se.

- **PATCH / MINOR bumps** are backward-compatible: added endpoints,
  added optional fields, new enum values in responses, relaxed
  constraints. Your integration keeps working. Don't hard-fail on an
  unknown field — tolerate additive change.
- **MAJOR bumps** signal a breaking change (a removed/renamed field, a
  tightened constraint, a removed endpoint, a changed auth requirement).
  Breaking changes are announced ahead of the bump.

Pin the spec you generated your client from, diff `openapi.json` between
releases (it's byte-stable, so a `git`/`jq` diff is meaningful), and
regenerate your client on a MAJOR bump. The per-schema contract is
regression-gated in our CI, so an accidental breaking change can't ship
silently.

---

## 5. Error contract

Every error response — from any endpoint, via the `withApiErrorHandling`
wrapper — has the **same envelope**:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Risk not found",
    "requestId": "req_01HG7…",
    "details": []
  }
}
```

| Field | Always present? | Use |
|---|---|---|
| `error.code` | Yes | **Stable, machine-readable.** Branch on this, not on `message`. |
| `error.message` | Yes | Human-readable. May change wording between releases — don't parse it. |
| `error.requestId` | Yes | Quote this when contacting support — it correlates to our server logs. Also returned as the `x-request-id` response header. |
| `error.details` | Sometimes | Structured context: validation issues (array of `{path, code, message}`), conflicting unique fields, etc. |

### Codes you'll see

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Request body/query failed schema validation. `details` lists the offending fields. |
| 400 | `BAD_REQUEST` | A domain-level bad request (semantically invalid, but well-formed). |
| 401 | `UNAUTHORIZED` | Missing/invalid credential. |
| 403 | `FORBIDDEN` | Authenticated, but lacking the required permission, or the tenant slug doesn't match your credential. |
| 404 | `NOT_FOUND` | No such resource in this tenant. |
| 409 | `CONFLICT` | Collides with current state (uniqueness constraint, a guard). |
| 410 | `GONE` | The resource was permanently removed. |
| 429 | `RATE_LIMITED` | See §3 — honour `Retry-After`. |
| 4xx | `TENANT_ISOLATION_VIOLATION`, `STALE_DATA`, `PAYLOAD_TOO_LARGE`, … | Domain-specific codes for cases that need discrimination beyond HTTP status. |
| 500 | `INTERNAL` | Unexpected server error. `message` is generic by design; quote `requestId` to support. |

500s never leak stack traces or internal messages. Everything you need
to report one is the `requestId`.

---

## Quick reference

```bash
# 1. Get the spec (works in production)
curl -fsS https://app.example.com/openapi.json -o openapi.json

# 2. Call an endpoint with an API key
curl -fsS https://app.example.com/api/t/<tenantSlug>/risks \
  -H "Authorization: Bearer iflk_live_xxx"

# 3. Handle a 429
#    → read Retry-After, sleep, retry with jitter + exponential backoff

# 4. Branch on errors by error.code (never by error.message)
```

Interactive reference (dev/staging): `GET /api/docs`.
