# 2026-10-24 — SSO sign-in opens a real session, scoped to its workspace

**Commit:** `fix(sso): SSO sign-in opens a NextAuth session, scoped to its workspace`

## Design

Before this change, no SSO sign-in produced a session. Both callbacks
(`/api/auth/sso/oidc/callback`, `/api/auth/sso/saml/callback`) signed their own
JWT with `jsonwebtoken` and set it as `authjs.session-token`, the Auth.js v5
name. The app runs NextAuth v4, which reads `next-auth.session-token` and
decrypts a JWE, so the edge gate never saw the cookie. Every SSO sign-in went
back to `/login`.

```
browser ──▶ /api/auth/sso/{oidc,saml}/start   (refused unless Sec-Fetch-Site is same-origin or none)
          flow (tenant, provider, returnTo, PKCE verifier, nonce) sealed into
          Set-Cookie: inflect_sso_flow; HttpOnly; HMAC-signed; Path=<that protocol's callback>
          IdP gets only the flow id, as OIDC `state` / SAML `RelayState`
IdP ──▶ /api/auth/sso/{oidc,saml}/callback
          the flow cookie must be present, ours, unexpired, and name the id the IdP sent back
          verify answer, link identity, membership must be ACTIVE
          issueSsoHandoff()  → VerificationToken (sha256, 60 s, single use)
          303 → /login/sso-complete?next=<sanitised>
                Set-Cookie: inflect_sso_handoff; HttpOnly; Path=/api/auth/callback/sso-handoff
      ──▶ /login/sso-complete   signIn('sso-handoff', { redirect: false })
      ──▶ POST /api/auth/callback/sso-handoff  (NextAuth)
          authorize(): redeem cookie, re-check membership → user + ssoTenantId
          signIn callback: no linking, no invite redemption
          jwt callback: token.ssoTenantId, then the usual claims / MFA / UserSession
          Set-Cookie: next-auth.session-token
      ──▶ next
```

The scope. A tenant's identity provider is configured by that tenant's admin,
so it can assert any email address. `linkExternalIdentity` links the asserted
address to an existing account when the account is a member of the tenant, and
an account can belong to several tenants. A full session would let tenant B's
admin sign a shared member in to tenant A. So an SSO session carries
`ssoTenantId`, and:

- `applyMembershipClaims` puts only that tenant's membership in the claims, and
  no org memberships, at sign-in and on every later refresh. The edge refuses
  everything else.
- `getTenantCtx`, `getLegacyCtx` and `getTenantServerContext` (the tenant
  layout) refuse any other tenant with a 403. `getOrgCtx` and
  `getOrgServerContext` refuse every organization with their usual 404.
- `/tenants` lists only the SSO tenant.

The binding. Before this change, the OIDC `state` and the SAML `RelayState`
carried the whole flow as unsigned base64 JSON, the PKCE verifier included,
and a callback accepted whatever came back. Once callbacks produced real
sessions, anyone who completed a sign-in could hand the callback URL (or an
auto-submitting SAML form) to someone else and sign that person's browser in
to the sender's account: login CSRF. And a verifier carried in the same URL
as the code it protects is no PKCE at all. Now `src/lib/auth/sso-flow.ts`
keeps the flow in an HttpOnly, HMAC-signed cookie, and the IdP sees only a
random id. `/start` refuses a sign-in another site initiated. Without that,
a hostile page could start the flow in the victim's own browser, against an
IdP the attacker controls, and the binding would hold.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/sso-session.ts` | Pure, client-safe names (provider id, cookie, paths) and `isOutsideSsoScope` |
| `src/lib/auth/sso-handoff.ts` | Issue / redeem the hand-off; the callbacks' shared 303 response |
| `src/lib/auth/sso-flow.ts` | Seal the flow into a signed cookie at `/start`; read it back at the callback; refuse a cross-site start |
| `src/app/api/auth/sso/{oidc,saml}/start/route.ts` | Bind the flow; send the IdP only its id; refuse a cross-site start |
| `src/auth.ts` | `sso-handoff` provider; signIn early return; `ssoTenantId` on token, session and claims |
| `src/lib/auth.ts` | `JwtPayload.ssoTenantId` |
| `src/app-layer/context.ts`, `src/lib/server/{tenant,org}-context.server.ts` | DB-backed gates honour the scope |
| `src/app/api/auth/sso/{oidc,saml}/callback/route.ts` | Hand off instead of hand-signing; require an ACTIVE membership |
| `src/app/login/sso-complete/` | Completion page that triggers the NextAuth sign-in |
| `src/app/login/login-error.ts`, `src/app/login/page.tsx` | `?error=` shown as a fixed message per code |

## Decisions

- **NextAuth mints the session, not the callback.** A hand-built cookie would
  have to copy everything the `jwt` callback does at sign-in: membership
  claims, the MFA policy, the `UserSession` row that revocation reads. Two
  copies of that would drift. A Credentials provider gets it all for free.
- **The hand-off travels in a cookie, not the URL.** Anything in the URL would
  let whoever opens the link sign in as someone else (login CSRF). The cookie
  binds the hand-off to the browser that went through the identity provider.
  The provider ignores the request body.
- **`VerificationToken`, not a new table.** That avoids a migration. The
  `sso-handoff:` identifier prefix keeps hand-offs apart from email-verification
  tokens. The hash covers the prefix, so neither kind can redeem as the other.
- **Scope rather than refusal.** Refusing SSO to accounts in several
  workspaces would also have closed the hole. But consultants and auditors
  legitimately hold several workspaces, and the claims are re-read every five
  minutes anyway, so the filter had to exist regardless.
- **The scope is any non-null string.** An empty `ssoTenantId` refuses every
  tenant rather than none. The `jwt` callback also throws when a hand-off names
  no tenant.
- **303 on the SAML callback.** It answers the identity provider's POST, and
  `NextResponse.redirect`'s default 307 would replay that POST to the next page.
- **`error_description` is never rendered.** Anyone can write a `/login` link
  with any text in it. Codes map to a fixed set of messages, and an unknown code
  gets the generic one.
- **The flow cookie is signed, not encrypted.** It is HttpOnly and sent only
  to its protocol's callback, so nothing else reads it. What has to hold is
  that it was written by us, so it carries an HMAC under a key derived from
  `AUTH_SECRET`.
- **SAML's flow cookie is `SameSite=None; Secure`.** The IdP POSTs the
  response from its own origin, and a Lax cookie is not sent on a cross-site
  POST. OIDC's callback is a top-level GET, so its cookie stays Lax.
- **Fetch metadata, not POST plus a CSRF token, guards `/start`.** A link on
  our own sign-in page sends `same-origin`; a typed URL sends `none`. A
  browser that sends no `Sec-Fetch-Site` at all is refused. One flow per
  protocol per browser: a second start replaces the first, and the first
  tab's callback is refused.
- **`returnTo` absent stays absent.** `/start` used to default it to `/`,
  which made the callbacks' dashboard fallback dead code. The end-to-end test
  found it once the test drove the real `/start`.
- **Out of scope, still open:** the login page has no way to start SSO yet,
  and the OIDC ID token's signature is not verified. Each is its own change.
