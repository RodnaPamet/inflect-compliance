# 2026-10-24 — OIDC sign-in requests go through the SSRF guard

**Commit:** `fix(sso): send the OIDC client's requests through the SSRF guard`

## Design

Enterprise OIDC sign-in makes three outbound requests, and none of them went
through `safeFetch`:

```
issuer (typed by a workspace admin)
  └─ GET  {issuer}/.well-known/openid-configuration   discoverOidc        global fetch
        └─ document names token_endpoint, jwks_uri
             ├─ POST token_endpoint (code, verifier, client secret)   exchangeCodeForTokens   global fetch
             └─ GET  jwks_uri                                         jose createRemoteJWKSet  jose's default fetch
```

A workspace administrator sets the issuer, so the first URL is the usual SSRF
input. The other two are worse: a public issuer can serve a discovery document
that names an internal address as its token endpoint, and the server would then
POST the authorization code, PKCE verifier and client secret there.

All three now call `safeFetch` (`src/app-layer/automation/webhook-safety.ts`):
https only, every resolved address public, the connection pinned to the
addresses that were checked, and redirects refused. `jose` takes the guard
through its `[customFetch]` option. A refused key-set fetch reaches `refusalOf`
as an error that is not one of jose's, so it reads as `keys_unavailable`, which
the callback already logs and shows as a generic `id_token_invalid`.

A self-hosted install whose IdP is on its own network uses the existing
deployment allowlist, `EGRESS_PRIVATE_CIDR_ALLOWLIST`. That allowlist is not
tenant-configurable, applies on self-hosted installs only, and keeps refusing
metadata and loopback even when it lists a range.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/oidc-client.ts` | Discovery and the token exchange call `safeFetch`; `createRemoteJWKSet` gets `[customFetch]: safeFetch` |
| `tests/unit/security/oidc-client-egress.test.ts` | The real guard in front of the real client. Only DNS and the `undici` transport are stubbed, and a call to the global `fetch` fails the test |
| `tests/unit/security/oidc-client-refusals.test.ts`, `oidc-id-token-verification.test.ts` | Their IdP double answers on the global `fetch`, so `safeFetch` is replaced with a pass-through to that double |
| `tests/guards/ssrf-egress-coverage.test.ts` | The client is added to `SINKS`. Two new checks: the file makes no fetch call other than `safeFetch`, and `jose` is handed `safeFetch` |
| `docs/enterprise-sso.md` | The issuer must be https at a public address; the allowlist for self-hosted; a troubleshooting row |

## Decisions

- **All three URLs, not only the typed one.** Guarding only the issuer leaves
  the token endpoint open, and that endpoint receives the client secret.
- **No save-time check on the issuer.** A guarded URL must be checked again when
  it is used, because DNS can change in between, and only `safeFetch` does that.
  A check when the issuer is saved would give an earlier error, but it would
  also touch the SSO save path, which another open PR is changing. It is left
  for later.
- **Redirects are refused, not followed.** This is `safeFetch`'s rule for every
  sink. IdPs serve discovery and keys from fixed URLs, and an issuer that
  redirects should be configured at its final URL.
- **Loopback stays refused, even self-hosted.** An IdP on the same machine
  answering on `localhost` is no longer reachable. It must use an address the
  allowlist can name. Allowing loopback would let a tenant's issuer point at
  this process's own admin surfaces.
