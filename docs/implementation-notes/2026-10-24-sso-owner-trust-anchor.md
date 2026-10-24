# 2026-10-24 — SSO: who decides whom single sign-on trusts

**Commit:** `fix(sso): only an Owner sets up single sign-on or changes whom it trusts`

## Design

A workspace's OIDC or SAML provider is a trust anchor. A sign-in through it
becomes a session for whichever member the identity provider names. On first
sign-in the member is matched by email (`linkExternalIdentity`), and that
includes Owners. The provider was saved under `admin.manage`, which every
ADMIN holds. So an ADMIN could point the workspace at an identity provider
they run, have it assert an Owner's email address, and sign in as that Owner,
gaining `admin.tenant_lifecycle`, `admin.owner_management` and every other
OWNER-only power. Two hops, no Owner involved.

The fix splits the provider's fields by what they decide:

- **Trust fields: Owner-tier.** These are the identity provider itself (OIDC
  issuer, client ID, discovery document; SAML entity ID, sign-in URL, signing
  certificate), the protocol, the email domains it may speak for, and whether
  it creates accounts. Creating a provider, or changing any of these, needs
  `admin.owner_management`.
- **Everything else: unchanged.** That covers the name, scopes, NameID format,
  the client secret, the enable and enforce switches, and delete. An ADMIN
  still runs single sign-on day to day. Deleting only takes trust away, and
  recreating it is a create.

A trust change also removes every identity link to the provider, in the same
transaction as the update. A link records that the old identity provider
vouched for a subject, and a new one's subjects are not the old one's. Each
member's next sign-in links them again by email, which an Owner has just
chosen to trust.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/sso-trust-fields.ts` | The trust-field list and the pure diff, `changedSsoTrustFields` |
| `src/app-layer/usecases/sso.ts` | The Owner-tier check, link removal, JIT kept when absent, and audit entries for create, update, delete and both switches |
| `src/app-layer/repositories/SsoConfigRepository.ts` | `updateAndRemoveLinks`: one transaction |
| `src/app-layer/schemas/sso-config.schemas.ts` | JIT settings optional (no default) |
| `src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx` | Trust fields read-only below Owner, with a note; Save disabled for a non-Owner with nothing set up |
| `messages/{en,bg}.json` | The three notes |

## Decisions

- **`admin.owner_management`, not a new key.** It is the key the other
  "an ADMIN must not do this to an OWNER" rules read: clearing an OWNER's
  custom role, and closing an access review that changes an OWNER. A custom
  role cannot grant it beyond what its base allows, and that is re-checked at
  runtime.
- **Compared after secrets are resolved.** The browser sends the mask for a
  certificate it did not touch. The diff runs on the config as it would be
  stored, so a kept certificate is not a change. A certificate is compared by
  its base64 body, so PEM armour and line breaks do not count either.
- **JIT absent means kept.** The admin page never sends the JIT settings. The
  schema defaulted them to off, so every save turned JIT off (#4116). Under
  this rule it would also have read as a trust change, refusing every ADMIN
  save of a JIT-enabled provider. Optional fields fix both.
- **`discoveryUrl` is a trust field, though no screen shows it.** It names
  the document the JWKS URI comes from, and so the keys an ID token is
  verified with. Re-pointing it re-points the provider.
- **NameID format is not.** It changes which identifier the same identity
  provider sends, not which identity provider is believed. A change orphans
  links, but takes over nothing.
- **Delete stays with ADMIN.** It only removes trust, and the cascade already
  removes the links. Getting a provider back is a create, which is
  Owner-tier.
- **Entra is out of scope.** The `ENTRA_ID` provider has its own writer
  (`usecases/entra-provider.ts`) and pins a Microsoft directory with
  `aadTenantId`. Whether re-pointing that is Owner-tier too is a separate
  decision, raised on the PR rather than folded in.
