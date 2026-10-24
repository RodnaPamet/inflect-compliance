# 2026-10-24 — OIDC ID tokens are verified, not decoded

**Commit:** see the pull request for `claude/sso-id-token-validation`.

## Design

The OIDC callback read the ID token's claims by base64-decoding its payload,
and its only check was the nonce. It never checked the signature, the issuer,
the audience or the expiry. The comment beside the decoder argued that TLS to
the token endpoint was enough, and OIDC Core §3.1.3.7 does allow TLS in place
of a signature check for a token-endpoint response. It does not allow skipping
the claim checks, and the code skipped both.

`verifyIdToken(idToken, { discovery, clientId, nonce })` replaces the two
unverified helpers (`extractIdTokenClaims`, `validateIdTokenNonce`), which are
deleted:

```
token endpoint ──id_token──▶ jwtVerify(token, remoteJWKSet(discovery.jwks_uri), {
                                algorithms: ID_TOKEN_SIGNING_ALGORITHMS,   // asymmetric only
                                issuer:     discovery.issuer,              // exact
                                audience:   clientId,
                                requiredClaims: [exp, iat, sub],
                                clockTolerance: 60s })
                             ─▶ azp == clientId (required when aud has several values)
                             ─▶ nonce == this flow's nonce
                             ─▶ zod: only the claims this app reads
```

Any failure throws `IdTokenRefusedError` with a `reason`. The callback logs the
reason and redirects with `nonce_mismatch` (nonce) or `id_token_invalid`
(everything else). The sign-in page shows its generic "single sign-on didn't
complete" message for both.

Discovery now requires `jwks_uri`, so a provider whose keys cannot be found is
refused at `/start`, before the person has been to the IdP and back.

## Files

| File | Role |
|---|---|
| `src/lib/security/oidc-client.ts` | `verifyIdToken`, `IdTokenRefusedError`, the algorithm allowlist, the per-`jwks_uri` key-set cache; discovery requires `jwks_uri` |
| `src/app/api/auth/sso/oidc/callback/route.ts` | Calls `verifyIdToken` in place of the nonce compare and claim decode |
| `src/lib/security/sso-logging.ts` | `id_token_verification` stage replaces the two it subsumes |
| `src/app/login/login-error.ts` | `id_token_invalid` reads as the SSO-incomplete message |
| `package.json`, `package-lock.json` | `jose` declared; it was already resolved at 6.2.12 |
| `docs/dependency-risk-review.md`, `tests/guards/dependency-risk-review.test.ts` | The review entry for `jose`, floor major 6 |
| `jest.config.js`, `tests/setup/jose-transform.js` | jose's own Jest transformer at ES2022 (see below) |

## Decisions

- **A library, not `crypto.verify`.** Node can verify an RS256 signature in a
  few lines. The ways that goes wrong are the reason JOSE libraries exist:
  `alg: none`, an HMAC "verified" with the public key as its secret, a key
  whose type does not match the header. `jose` was already in the image, as a
  dependency of `@modelcontextprotocol/client`.
- **Asymmetric algorithms only.** OIDC allows HS256 keyed with the client
  secret. That secret is shared between the IdP and this app, so a MAC made
  with it does not prove the IdP signed the token, and none of the supported
  IdPs need it.
- **The token's `iss` is compared with the discovery document's issuer, not
  the configured one.** OIDC Discovery §4.3 also requires the document's issuer
  to equal the configured issuer URL. That check was left out on purpose:
  Entra's v1 endpoint publishes `https://sts.windows.net/<tenant>/` from a
  `login.microsoftonline.com` URL, and enforcing §4.3 would break that setup
  for no gain, because the administrator writes both values. The token check is
  the one that keeps a provider to one directory. Microsoft's multi-tenant
  endpoints publish the literal issuer `…/{tenantid}/v2.0`, which no real
  token's `iss` equals, so a provider configured with `common` now refuses
  every sign-in rather than accepting any Microsoft tenant's users.
- **No `maxTokenAge`.** `iat` must be present, but its age is not bounded
  beyond what `exp` bounds. Every IdP we know of mints the ID token at the
  token endpoint, but a bound would refuse one that reuses a token minted at
  the authorization step, and `exp` already limits it.
- **`azp` follows §3.1.3.7 items 4–5.** When present it must be the client id,
  and it must be present when `aud` lists more than one audience.
- **Key-set caching is jose's.** It caches for 10 minutes and re-fetches for an
  unknown `kid` at most every 30 seconds, so a rotation is picked up without a
  stream of made-up key ids turning into a stream of requests to the IdP. The
  test drives both halves.
- **jose has its own Jest transformer.** jose's build is minified, and its
  error constructors are comma expressions (`super(m, o), this.x = …`). At the
  repo's ES2017 target, TypeScript lowers class fields into the constructor
  and, finding no `super()` statement, places them before the call. Every jose
  error then throws "Must call super constructor" when constructed: refusals
  arrived as `ReferenceError`, and the key set's re-fetch, which catches
  `JWKSNoMatchingKey` by class, never ran. A `['ts-jest', { tsconfig }]` entry
  did not fix it, because ts-jest caches one configuration per Jest project.
  So `tests/setup/jose-transform.js` calls `ts.transpileModule` at ES2022.
  This is test harness only: Node and Next run the class fields natively.
- **Not in this change: the SSRF guard.** Discovery, the token exchange and
  now the key-set fetch all go to URLs a workspace administrator configures,
  without `safeFetch`. Routing them through it is its own decision. It refuses
  private addresses and plain http, which would cut off an IdP on a
  self-hosted install's internal network unless the deployment allowlist
  covers it. The key-set fetch adds no new class of destination: it goes
  wherever the discovery document, already fetched without the guard, sends it.
