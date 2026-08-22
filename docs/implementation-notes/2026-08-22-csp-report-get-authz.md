# 2026-08-22 — gate `GET /api/security/csp-report` on the platform key

**Issue:** #2103 — `GET /api/security/csp-report` is unauthenticated and leaks
tenant slugs + the CSP.

## Design

One path, two methods, opposite requirements.

```
POST /api/security/csp-report   browser, no cookie by spec  → must stay OPEN
GET  /api/security/csp-report   whole CspViolation records   → must be CLOSED
```

The POST is on the edge allowlist for a real reason: a browser will not attach
credentials to a CSP report, so a gate at the edge means zero reports forever,
and silently. But `isPublicPath` matches a **path**, not a method —

```ts
// src/middleware.ts
if (isPublicPath(pathname)) { return NextResponse.next(); }   // any method
```

— so the GET was public for exactly as long as the allowlist entry existed. It
returned `getViolationSummary(50)`: `documentUri` (`/t/<slug>/…`, so tenant
slugs are enumerable), `originalPolicy` (the enforced CSP — allowed hosts,
CDNs, third parties), `sourceFile`, `blockedUri`, plus counters usable as a
liveness oracle.

The fix is a gate **inside the handler**, because the edge cannot express the
distinction. The middleware allowlist is untouched.

## The gate is the platform key, not a tenant role

The store is a single module-scope ring buffer per process
(`src/lib/security/csp-violations.ts`), shared by every tenant served by that
container. Reading it is a cross-tenant read *by construction*. A tenant-ADMIN
check would have narrowed the audience from "the internet" to "any admin of
any tenant" and left it cross-tenant — a smaller hole of the same kind, and
one that reads as fixed.

`/api/admin/diagnostics` already reached this conclusion for the same shape of
data (server-wide, no tenant dimension) and moved off `ctx.permissions.canAdmin`
onto `verifyPlatformApiKey`. This follows it. The `PlatformAdminError` status is
preserved rather than flattened: 503 = no key configured on this deployment,
401 = key missing or wrong. They are different operator actions.

### The gap, stated plainly

There is **no deployment-wide admin *user*** in this codebase — no
`isPlatformAdmin`, no global role, nothing on `User` or `TenantMembership` that
spans tenants. `requirePermission`, the canonical authorization primitive,
resolves a tenant role through `getTenantCtx` and its handler type requires
`params: { tenantSlug: string }`; it does not apply to a path with no slug in
it. So the honest options were the platform key or a tenant role, and a tenant
role is the wrong axis for this payload.

The cost: an operator cannot read this from a browser session. That matches how
the surface is actually used — nothing in the product calls the GET — but it is
a real constraint, not an oversight. With `PLATFORM_ADMIN_API_KEY` unset the
endpoint is 503, i.e. off by default.

## Files

| File | Role |
|---|---|
| `src/app/api/security/csp-report/route.ts` | The gate. The false "protected by the middleware auth guard" comment is deleted; the replacement states that the path is on the allowlist *for the POST* and that the GET therefore gates itself. |
| `src/lib/auth/guard.ts` | Comment only. Records that `MACHINE_CALLER_PREFIXES` matching is path-scoped and cannot say "POST only" — the root cause, written where the next person adds an entry. |
| `src/lib/security/csp-violations.ts` | Module header said "Admin → GET". Now says "Operator", with why a tenant role is the wrong axis. |
| `src/lib/errors/route-exemptions.ts` | The bare-route exemption is per FILE; its reason now covers both methods and says why the GET cannot take `withApiErrorHandling` without dragging the wrapper (and its 60/min mutation limit) onto the report sink. |
| `docs/security-hardening.md` | The CSP rollout runbook's "Step 2: monitor violations" now shows the header. |
| `tests/unit/security/csp-report-authz.test.ts` | Behavioural: four states, each negative paired with the positive that proves the code reached the decision. |
| `tests/guards/machine-caller-paths-self-authenticate.test.ts` | Its `credentialLess` list claimed this path had "no gate to assert". True of the POST, false of the GET. Now asserts the GET's own body calls the gate and the POST's does not. |
| `tests/guardrails/api-permission-coverage.test.ts` | `src/app/api/security` added as a privileged root, the one route excluded with its actual gate named. |

## Decisions

- **Gate in the handler, not the middleware.** Removing the path from
  `MACHINE_CALLER_PREFIXES` would close the GET and take every CSP report with
  it. Adding method-awareness to the allowlist is a bigger change than this
  issue justifies, and would put the security decision three files from the
  code it protects — which is the arrangement that produced #2103.

- **No `withApiErrorHandling`.** The exemption in `route-exemptions.ts` is keyed
  by FILE and `isWrapped()` is a substring test over the whole file, so wrapping
  the GET marks the exemption dead and fails
  `api-error-wrapper-coverage.test.ts`. Dropping the exemption instead would
  wrap the POST too: the mutation rate limiter and the `ApiErrorResponse` shape
  would both land on a sink whose contract is "always 204". The GET converts
  `PlatformAdminError` to a response inline.

- **The tests do not mock `verifyPlatformApiKey`.** A mocked gate is satisfied
  whether or not the handler consults it. These load the route with
  `jest.isolateModules` after setting `PLATFORM_ADMIN_API_KEY` — `@/env`
  snapshots `process.env` at first evaluation — so a real header meets a real
  constant-time compare. The isolation also gives each test its own ring buffer.

- **Every refusal is paired with a service.** `expect(401)` passes just as well
  against a handler that refuses everyone, and `not.toContain('acme-holdings')`
  passes against an empty store. Each refusal test reports a violation first and
  then re-reads it *with* the key on the same module instance, so the buffer is
  demonstrably non-empty at the moment of the refusal.

- **The POST test asserts storage, not status.** The handler returns 204 on an
  unparseable body, on an unrecognised format, and from its catch-all — so a
  204 is not evidence the report landed. The test reads the summary back.
