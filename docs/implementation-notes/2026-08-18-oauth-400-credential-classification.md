# 2026-08-18 — OAuth 400 credential classification

**Commit:** `<pending>` feat(integrations): classify OAuth2 400 credential failures

## Design

`resilientFetch` classifies by STATUS. 401/403 throw `IntegrationAuthError`,
404 throws `IntegrationTerminalError`, 429/5xx retry, and everything else —
including 400 — returns the `Response`.

RFC 6749 §5.2 puts a token endpoint's failure code in a **400** body, which is
where the dominant real credential failures live: a revoked Google
domain-wide-delegation grant answers `400 invalid_grant`, an expired Entra
client secret `400 invalid_client`. Those reached the caller's own `!res.ok`
line, became a plain `Error`, and `markAuthFailure` — which marks only for
`IntegrationAuthError` — silently returned `false` and no caller checks its
return value. The connection kept rendering as healthy while every sync failed.

`fetchOAuthToken` wraps `resilientFetch` and inspects only a 400:

```
token exchange -> fetchOAuthToken -> resilientFetch -> boundedFetch -> fetch
                       |                  |
                  400 + allowlisted   401/403 -> IntegrationAuthError
                  code -> IntegrationAuthError   (unchanged, untouched)
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/oauth-token-fetch.ts` | The wrapper and the code allowlist. |
| `src/app-layer/integrations/http-resilience.ts` | `IntegrationAuthError` gains an optional `reason`. |
| `providers/google-workspace/index.ts`, `providers/entra-id/index.ts` | Wired — the two token exchanges whose failures reach `markAuthFailure`. |

## Decisions

- **A wrapper, not a change to `resilientFetch`'s status sets.** A 400 from an
  ordinary REST endpoint is a malformed query, not a dead credential. Widening
  the global sets would start accusing working connections the first time any
  provider sent a bad request. Opt-in per call site keeps the blast radius at
  the four token endpoints.

- **Additive, never narrowing — this is the decision worth remembering.** An
  earlier draft routed 401 through the same allowlist, which reads as a
  tightening and is actually the opposite: every 401/403 already marks today
  without body inspection, so a provider reporting a disabled key as 401 with a
  vendor-specific code would have *stopped* marking. The change would have
  removed a working signal while looking like an improvement. Adversarial review
  caught it; the ordinary reading of the diff did not.

- **Three RFC codes, not six.** `invalid_grant` / `invalid_client` /
  `unauthorized_client` mean the credential is bad. `invalid_request` /
  `unsupported_grant_type` / `invalid_scope` mean OUR request is malformed or
  the configuration is wrong — marking on those turns a bug of ours into an
  accusation about the customer's credentials.

- **Nothing from the body reaches the error message.** Only the matched code,
  which comes from the allowlist rather than the response. `IntegrationAuthError`'s
  message is persisted verbatim into `IntegrationConnection.authFailureReason`,
  exempt from field encryption on the recorded grounds that it is
  system-generated and URL-scrubbed by `safeUrl`. `safeUrl` scrubs URLs, not
  bodies, and `error_description` is exactly where a provider puts a client id,
  a service-account email or an assertion fragment.

- **"Cannot tell" is not a verdict.** A non-JSON body (Microsoft and Workday
  gateways answer with HTML), an unparseable one, or an unrecognised code all
  pass the `Response` through untouched. Promoting uncertainty to terminal would
  cost the job its retries for a failure that might be transient.

- **`clone()` before reading.** A `Response` body can be read once, and the
  caller still needs it on every non-credential path.

## Not covered

`sharepoint/token.ts`'s authorization_code exchange is not wired: it runs during
the admin consent callback, before the `IntegrationConnection` row exists, so
there is no `connectionId` to mark. `workday/token.ts` is not wired either —
it was untouched to avoid colliding with concurrent Workday work, and inherits
the same gap until it is.
