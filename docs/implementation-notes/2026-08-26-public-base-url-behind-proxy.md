# 2026-08-26 — externally-published URLs come from APP_URL, not the request

**Commit:** `fix(http): build public URLs from APP_URL, not the proxied request host`

## Design

Route handlers built base URLs from the incoming request:

```ts
const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
```

Behind a reverse proxy that is the app's own bind address. With Caddy in front
of Next, the admin Integrations page rendered its webhook endpoint as
`https://0.0.0.0:3000/api/integrations/webhooks/{provider}` while `APP_URL` was
set correctly to the real host. An operator copying that into a provider's
webhook configuration gets an address that resolves to nothing — and the
integration fails **silently**, because the provider has nobody to report to.

`publicBaseUrl(req)` in `src/lib/http/public-base-url.ts` is now the single
source: `APP_URL` when set, the request origin as a development fallback, and a
`logger.warn` when it has to fall back in production.

### Why `APP_URL` and not `X-Forwarded-Host`

The forwarded header would work behind a correctly configured proxy, but it is
attacker-controlled on any request reaching the app directly. These strings are
handed to operators to paste into third-party systems, and returned to identity
providers as canonical resource locations — a spoofed host there is a
redirect/phishing primitive with a long tail. The configured value has no such
failure mode, and an operator who sets `APP_URL` has already stated the answer.

### The reported bug was one of ten sites

The screenshot named the webhook URL. The same construction had spread to:

| site | consumed by |
|---|---|
| `admin/integrations` | operator, pasted into a provider's webhook config |
| `admin/scim` (`scimEndpoint`) | admin, pasted into an IdP |
| `scim/v2/ServiceProviderConfig` | IdP discovery |
| `scim/v2/Users` ×2, `scim/v2/Users/[id]` ×3 | SCIM `location` — **IdPs store these and call back** |
| `sso/{oidc,saml}/callback` ×2 | `Location` header on an SSO error redirect |

The SCIM ones are the worst of these: a provider persists the resource URL, so a
wrong value keeps breaking provisioning long after the deploy that caused it.

The last two were found by the ESLint rule, not by the search that found the
other eight — they are `new URL('/login', req.nextUrl.origin)`, which shares
none of the original's text.

## Files

| file | role |
|---|---|
| `src/lib/http/public-base-url.ts` | the helper; `APP_URL` first, request origin as a dev fallback |
| `eslint-rules/rules/no-request-derived-public-url.js` | bans `nextUrl.{host,origin,hostname}` under `src/app/api/**` |
| 10 route files | migrated, including 4 that were already correct but duplicated the logic |
| `tests/unit/http/public-base-url.test.ts` | behavioural, including the exact reported string |

## Decisions

- **An ESLint rule, not a `tests/guards/` regex.** CLAUDE.md asks for an AST
  rule when the invariant is structural, and this is the case that shows why: a
  regex for the original template literal would never have matched
  `new URL('/login', req.nextUrl.origin)`. The rule found those two sites
  immediately.

- **The first version of the rule had the hole it claimed to close.** Its
  docblock said a regex "is defeated by `const { host } = req.nextUrl`" — and
  the rule missed that form too, because it only walked `MemberExpression` and a
  destructuring pattern is not one. Caught by mutation-testing the rule against
  the exact shape its own comment described. It now handles `ObjectPattern`.

- **Four already-correct sites were migrated too.** The SSO routes did
  `env.APP_URL || req.nextUrl.origin`, which is what the helper does. Migrating
  them means the rule needs no allowlist — an allowlist would have been a
  standing invitation to add the eleventh site to it.

- **Falling back in production warns rather than throws.** Refusing to serve the
  page would be a worse failure than showing a host an operator can recognise as
  wrong. But it is never correct in production, so it belongs in the logs rather
  than only in a support ticket about a webhook that never fired.

- **Billing routes were left alone.** They use
  `env.APP_URL || \`https://${req.headers.get('host')}\``, a different fallback
  with different semantics. Folding them in would change behaviour, which is a
  separate decision from fixing a bug.
