# 2026-10-24 — A SAML response must answer this flow's request

**Commit:** `fix(sso): a SAML response must answer this sign-in's request, once`

## Design

The SAML callback accepted any validly signed response for the provider. The
problems:

- `validateInResponseTo` was never set, and node-saml defaults it to `never`.
- The flow cookie (#4066) bound only `RelayState` to the browser, and clearing
  it asked the browser to forget it without stopping the value being sent
  again.

So someone holding a captured SAMLResponse could start a flow of their own with
`curl` and post the response with it. A response can leak through a HAR attached
to a support ticket, a TLS-inspecting proxy log or a browser extension, and a
HAR also carries the cookie.

```
/start     newSamlRequestBinding() → { id, issuedAt }
           AuthnRequest ID = id (generateUniqueId)
           sealed into the flow beside tenant / provider / returnTo

callback   readBoundSsoFlow → relay state, request included
           spendSsoFlowOnce(flowId)       server-side single use (VerificationToken, P2002 = replay)
           buildSamlInstance(…, request)   validateInResponseTo 'always', one-entry cache,
                                          requestIdExpirationPeriodMs = flow TTL,
                                          maxAssertionAgeMs = 5 min
           validateSamlResponse(…, { callbackUrl, requestId })
                                          + a bearer SubjectConfirmation whose Recipient is
                                            this callback, InResponseTo is the request, and
                                            NotOnOrAfter is present and ahead
```

## Files

| File | Role |
| --- | --- |
| `src/lib/security/saml-client.ts` | `SamlRequestBinding`, the one-entry cache, the new instance options, and the bearer-confirmation check |
| `src/lib/auth/sso-flow-spend.ts` | Spends a SAML flow once on the server |
| `src/app/api/auth/sso/saml/{start,callback}/route.ts` | Create the binding and seal it; spend the flow, then validate against it |
| `tests/unit/security/saml-request-binding.test.ts` | Real node-saml against responses signed with the fixture key in `tests/fixtures/secrets/saml-test-idp/` |

## Decisions

- **The cache reads the sealed flow; it is not node-saml's in-memory map.** The
  default cache lives in one process, so a second container, or a restart
  between `/start` and the callback, would refuse every sign-in. The flow
  already carries the request, signed.
- **Our own bearer check runs beside node-saml's.** node-saml 5.1 never checks
  `Recipient`. It checks a confirmation's time window only for the one it picks,
  and under `always` it still accepts an assertion that has no confirmation.
- **A flow is spent before its response is read**, so a failed attempt burns it
  too, as the cookie-clearing already intended. A store that cannot be reached
  refuses (`sso_error`) rather than letting the response through.
- **OIDC is not changed.** Its authorization code is single-use at the identity
  provider, and the nonce is already bound to the browser's flow.
- **A flow sealed before this change has no request**, and is refused. The cost
  is one retry for anyone mid-sign-in during the deploy.
