# 2026-11-11 — Web Bot Auth: the deployment key and the signed directory

**Commit:** `feat(web-bot-auth): deployment Ed25519 key and signed key directory (Phase 1)`

Phase 1 of `docs/ai-architecture/web-bot-auth.md`, first slice. Nothing signs
an outbound request yet; that is Phase 2.

## Design

```
WEB_BOT_AUTH_SIGNING_KEY ─┐   src/env.ts refuses a bad seed at startup
WEB_BOT_AUTH_PREVIOUS_…  ─┤   (seed.ts: malformed, = DATA_ENCRYPTION_KEY,
APP_URL (bare https)     ─┘    previous = current, published test seed in prod)
          │
          ▼
config.ts  webBotAuthDirectoryConfig()  ── null ⇒ route answers 404, charges nothing
          │  same refusals again, fail closed
          ▼
key.ts     seed → Ed25519 KeyObject, OKP JWK, keyid = RFC 7638 thumbprint
          │
          ▼
directory.ts  {"keys":[current, previous?]} + one signature per key:
              binding<i>=("@authority";req);created;expires;keyid;alg="ed25519";
                         tag="http-message-signatures-directory"
          │  via message-signature.ts (RFC 9421 base + Ed25519 members)
          ▼
GET /.well-known/http-message-signatures-directory
    application/http-message-signatures-directory+json
    Cache-Control: public, max-age=300   (signature lives 3600 s)
```

One key per DEPLOYMENT (D-L1-5). Nothing in the path takes a context, a
tenant or a request property except the per-IP rate-limit key.

## Wire format, and where it came from

The primary texts (the IETF datatracker and Cloudflare's developer docs) were
again unreachable from this session's network, so Phase 0.1's reading has not
happened here. What was used:

- **Path and media type**: `/.well-known/http-message-signatures-directory`,
  `application/http-message-signatures-directory+json` — the roadmap's text,
  and the search listing of `draft-meunier-http-message-signatures-directory`
  (-01 to -05) and `draft-meunier-webbotauth-httpsig-directory-00` (June 2026),
  which registers that well-known suffix and requires that media type.
- **Response signing**: one signature per key; the directory SHOULD cover
  `@authority` with the `req` flag; `tag` MUST be
  `http-message-signatures-directory`; clients ignore keys without a valid
  signature — the same search listing, and the roadmap's "Cloudflare requires
  the directory response itself to be signed, one signature per key, and
  accepts Ed25519 only". The `binding<i>` labels and the parameter order are
  this implementation's choice; a verifier reads them from `Signature-Input`.
- **keyid**: the RFC 7638 SHA-256 thumbprint of the OKP JWK, base64url.
- **Not settled here**: the request-signing details 0.1 owns (the
  `Signature-Agent` form, covered components, window, nonce). They affect
  `signRequest`, which this slice does not build.

The search listing shows the directory draft as a separate webbotauth
document (-00, June 2026), where the roadmap says the protocol draft
absorbed it. Phase 0.1 should settle which is current.

## Files

| File | Role |
| --- | --- |
| `src/lib/web-bot-auth/seed.ts` | strict seed decoding (no Buffer: env.ts loads it at the edge) and the four refusals |
| `src/lib/web-bot-auth/key.ts` | seed → Ed25519 key, public JWK, RFC 7638 keyid |
| `src/lib/web-bot-auth/message-signature.ts` | RFC 9421 signature base, `@signature-params`, Ed25519 dictionary members |
| `src/lib/web-bot-auth/directory.ts` | JWKS body, per-key response signatures, authority from `APP_URL`, cache/TTL constants |
| `src/lib/web-bot-auth/config.ts` | env → configuration or `null`; re-applies the refusals, logs reasons never values |
| `src/app/.well-known/http-message-signatures-directory/route.ts` | the public GET |
| `src/lib/auth/guard.ts` | the exact path in `PUBLIC_PATH_EXACT` |
| `src/env.ts`, `.env.production.example` | the two optional variables |
| `evals/web-bot-auth/vectors.json` | the conformance vector set |
| `tests/helpers/web-bot-auth-verifier.ts` | an independent directory verifier sharing no code with the signer |

## Decisions

- **The authority signed is `APP_URL`'s, never the request's `Host`.**
  Reflecting `Host` would hand anyone who reaches the app under another name
  a signature binding our keys to that name. No bare https `APP_URL`, no
  directory.
- **Fail closed twice.** The env schema refuses at startup; tests and
  `SKIP_ENV_VALIDATION` builds skip it, so the loader asks again and publishes
  nothing on a refused seed. A refused PREVIOUS key drops only itself: the
  grace ends early, the current key stays published.
- **Equality is on decoded bytes**, so the same 32 bytes in hex and base64 are
  one key; and base64 is decoded strictly (no skipped characters, no
  non-canonical trailing bits), because a seed read two ways is two keys.
- **Published test seeds are refused in production.** The vector set commits
  RFC keys; a deployment configured with one would have no identity.
- **Rate limit in the handler, after the configuration check.** The route is
  public and cheap; charging `API_READ_LIMIT` per IP in the handler keeps
  `src/middleware.ts` unchanged, and an unconfigured deployment charges no
  bucket. Moving it to the edge with the other public limits is open if the
  operator wants the Upstash-backed limiter there.
- **Signature lifetime 3600 s, cache 300 s**, so a cached copy never carries
  an expired signature (a test pins the inequality).
- **No new dependency.** `node:crypto` signs, as A2A does. The reference
  library stays the 0.3 decision.

## Significance, rollback and risk

SIGNIFICANT: it changes the edge's public-path allowlist (`guard.ts`) and adds
startup refusals to `src/env.ts`. No migration.

- **Risk — the allowlist.** One exact path is opened; a test proves siblings
  (`…/extra`, `…directoryx`, `/.well-known/other`) stay gated. The handler
  reads no tenant data and publishes public keys only.
- **Risk — startup.** The new refinements fire only when a variable is SET, so
  an existing deployment boots unchanged. Setting a bad seed refuses boot,
  which is the intent.
- **Rollback.** Unset `WEB_BOT_AUTH_SIGNING_KEY` (the route answers 404 at
  once, no redeploy of code). To remove the code, revert the commit; nothing
  persisted depends on it.

## Open

- `signRequest` and the request-side tenant-free test (after 0.1).
- The G11 record: the reference verifier and Cloudflare's
  `http-signature-directory` validator against a CI-built instance, under
  `evals/web-bot-auth/records/`.
- A bounded previous-key grace (today the operator ends it by unsetting the
  variable), and the "previous key verifies only inside the grace" test, which
  needs a verifier (Phase 3) or Phase 2's signer.
