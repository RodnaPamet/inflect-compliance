# 2026-10-24 — "Continue with single sign-on" on the sign-in page

**Commit:** `feat(sso): continue with single sign-on from the sign-in page, by workspace`

## Design

The sign-in page had no way to start SSO. The only entry was a hand-built
`/api/auth/sso/<protocol>/start?tenant=…&provider=…` URL, and since the
browser binding (2026-10-24, `sso-handoff-scoped-session`) refuses a start
that another site initiated, a link like that pasted into an email no longer
works either.

```
/login ── "Continue with single sign-on" ── workspace name
        ── GET /api/auth/sso/discover?workspace=<slug>   → [{ id, protocol, name }]
        ── one provider: straight to /api/auth/sso/<protocol>/start (same-origin)
           several: a button each        none: "this workspace doesn't use SSO"
/login?sso=<slug>   opens the form on that workspace (shareable; where a refused start lands)
```

## Files

| File | Role |
| --- | --- |
| `src/app/api/auth/sso/discover/route.ts` | Public: a workspace's enabled providers by id, protocol and name |
| `src/app/login/SsoSignIn.tsx` | The sign-in page's SSO form |
| `src/app/login/page.tsx` | Renders it beside Google and Microsoft; `?sso=` prefill |
| `src/app/api/auth/sso/{oidc,saml}/start/route.ts` | A refused cross-site start lands on `/login?sso=<workspace>` |

## Decisions

- **By workspace, not by email domain.** `SsoConfigRepo.findByDomain` and
  `resolveSsoByDomain` exist, but a provider's `emailDomains` are typed in by
  that workspace's admin and nobody verifies them, so any workspace could
  claim `bigcorp.com` and route bigcorp's people to an identity provider it
  controls. Domain discovery needs domain verification first.
- **Discovery says nothing more than "no SSO here".** An unknown workspace, a
  workspace without SSO and a malformed name get the same empty answer. Only
  id, protocol and display name leave the route, and `/api/auth/sso/` is in
  the edge's strict sign-in rate tier.
- **`/login?sso=<workspace>` is the shareable SSO link.** The start is then
  followed from our own page, which is what `/start`'s fetch-metadata check
  needs.
