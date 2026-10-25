# Enterprise SSO — Configuration & Operations Guide

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                    Login Page                          │
│  [Sign in with SSO] ──► resolves tenant + provider    │
└────────────┬─────────────────────┬────────────────────┘
             │ OIDC                │ SAML 2.0
             ▼                    ▼
┌─────────────────────┐  ┌─────────────────────────────┐
│ /api/auth/sso/oidc/ │  │ /api/auth/sso/saml/         │
│   start → callback  │  │   start → callback (ACS)    │
│   PKCE + nonce      │  │   AuthnRequest + XML-DSig   │
└──────────┬──────────┘  └──────────┬──────────────────┘
           │                        │
           ▼                        ▼
┌────────────────────────────────────────────────────────┐
│              linkExternalIdentity()                     │
│  Domain validation → Existing link check →              │
│  Email match → JIT provisioning (if enabled)            │
└────────────────────────┬───────────────────────────────┘
                         ▼
┌────────────────────────────────────────────────────────┐
│              JWT Session Creation                       │
│  Auth.js-compatible cookie → redirect to app            │
└────────────────────────────────────────────────────────┘
```

## Configuration

### Admin UI

Navigate to: `/t/<your-tenant>/admin` → click **SSO & Identity** pill button.

**Who may change what.** Creating a provider, or changing one of its trust
fields, is OWNER-tier (`admin.owner_management`; 403 `SSO_TRUST_IS_OWNER_TIER`).
The trust fields are the OIDC issuer, client ID and discovery URL, the SAML
entity ID, SSO URL and certificate, the protocol, the email domains and the
JIT settings (`src/lib/auth/sso-trust-fields.ts`). A trust change removes every
identity link to the provider in the same transaction; members re-link by
email on their next sign-in. An ADMIN keeps every other field, the enable and
enforce switches, and delete. A save that omits the JIT settings keeps the
stored ones.

### OIDC Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| **Issuer URL** | ✅ | OIDC Issuer URL (e.g. `https://login.example.com`) |
| **Client ID** | ✅ | OAuth client ID from your IdP |
| **Client Secret** | ✅ | OAuth client secret (encrypted at rest) |
| **Scopes** | Default: `openid email profile` | Space-separated OIDC scopes |
| **Email Domains** | Optional | Comma-separated (e.g. `acme.com, acme.io`) |

**Callback URL** (register in your IdP):
```
https://<your-domain>/api/auth/sso/oidc/callback
```

**The identity provider must answer over https, at a public address.** Inflect
fetches the discovery document, the token endpoint and the signing keys through
its SSRF guard (`safeFetch` in `src/app-layer/automation/webhook-safety.ts`):
https only, every address the host name resolves to must be public, and a
redirect is refused rather than followed, so configure the URL the IdP finally
answers at. The guard covers all three URLs because only the issuer is typed
here: the discovery document the issuer serves names the other two.

A self-hosted install whose IdP runs on its own network allows that range with
`EGRESS_PRIVATE_CIDR_ALLOWLIST` (see `docs/deployment.md`). Loopback and cloud
metadata stay refused inside it, so an IdP on the same machine as Inflect is
reached at a non-loopback address.

### SAML Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| **IdP Entity ID** | ✅ | Your IdP's entity identifier |
| **SSO URL** | ✅ | IdP's Single Sign-On endpoint |
| **X.509 Certificate** | ✅ | IdP's signing certificate (PEM format) |
| **NameID Format** | Default: `emailAddress` | SAML NameID format |
| **Email Domains** | Optional | Restricts which emails can authenticate |

**ACS URL** (register in your IdP):
```
https://<your-domain>/api/auth/sso/saml/callback
```

**SP Entity ID / Issuer**:
```
https://<your-domain>/saml/metadata/<tenant-slug>
```

## Enforcement Behavior

| Setting | Effect |
|---------|--------|
| **Enabled** | SSO login option appears on login page |
| **Enforced** | Users must use SSO — local login blocked |

### Break-Glass Access

When SSO is enforced, local login is still possible for users who meet **both** criteria:
1. Have **ADMIN** role in the tenant
2. Have a **local password** set (passwordHash exists)

This prevents tenant admin lockout while maintaining enforcement for all other users.

## JIT Provisioning

When enabled per provider (set through the API — the admin page has no JIT
control, and an OWNER-tier change):
- Users whose email domain matches are auto-created on first SSO login
- Default role: **READER** (configurable to EDITOR)
- **ADMIN role is never auto-provisioned** — this is enforced at schema level

## Microsoft Entra ID — group → role mapping (EI-2/EI-3)

When a tenant signs in via Entra ID, IC can drive each user's role from their
Entra **security-group** membership. Configure it at **Admin → Entra ID**.

### How role sync works (at every Entra sign-in)
1. The user's security-group object IDs are resolved from the ID token's
   `groups` claim — or, for users in **> ~200 groups**, from a Microsoft Graph
   `/me/memberOf/microsoft.graph.group` fetch (the "overage" path). A Graph
   outage fails open to "no groups" and never blocks sign-in.
2. Each group is matched against the tenant's `group → role` mappings.
3. The **winning** mapping sets the role, and the user's existing membership
   role is updated to match (audited as `MEMBER_ROLE_CHANGED`,
   `source: entra_group_sync`).

### Only your own directory's sign-ins count
The mappings apply only to a Microsoft sign-in from the directory the workspace
configured: the ID token's `tid` must equal the provider's **Directory (tenant)
ID** (`aadTenantId`), compared case-insensitively. The deployment's Microsoft
app can admit accounts from any directory, and a group object ID says nothing
on its own about whose directory it came from, so a sign-in from another
directory gets no mapped role (metric outcome `foreign_directory`). When the
group gate is on, that sign-in is refused, as a non-matching one would be. A
workspace that has mappings but no configured directory applies none at
sign-in. SCIM's Groups push is not a sign-in and is unaffected: it is
authenticated by the workspace's own SCIM token.

Because the directory and client ID decide whose sign-ins the mappings apply
to, **setting Entra up, and changing either of them, is Owner-only**
(`admin.owner_management`; refusal reason `SSO_TRUST_IS_OWNER_TIER`, naming the
fields), as the SSO page's trust fields are. An Admin keeps the other settings,
the gate and the mappings below their own role. The audit row of every save
names the trust fields it changed.

Role sync only ever **sets** the role to a matched mapping — it never demotes a
user who matches nothing (use the gate for that). It also never **creates** a
membership: a user with no membership still needs an invite / SSO-JIT / SCIM
grant first. **OWNER is exempt** — a mapping can never demote or gate-lock-out a
tenant owner; ownership stays manually managed.

### Resolution algorithm (multiple matching groups)
The winner is chosen by, in order:
1. **Highest `priority`** (the numeric field on the mapping — higher wins);
2. **Most senior role** (OWNER > ADMIN > EDITOR > READER > AUDITOR);
3. **Lowest group object ID** (lexicographic — only to guarantee determinism).

Example: a user in two priority-100 groups mapping to ADMIN and READER → ADMIN.

**AI_ADMIN is off the seniority ladder.** It is READER's access plus the agent
keys, so it beats READER on a priority tie. Against ADMIN, EDITOR or AUDITOR each
side holds something the other lacks, so an equal-priority tie at the top
decides nothing: the user's role is left as it is (metric outcome
`ambiguous_tie`). Give the AI_ADMIN mapping a higher or lower priority to settle
it. A higher priority still wins outright, in either direction.

OWNER is **not** a mappable target (only ADMIN / EDITOR / READER / AUDITOR /
AI_ADMIN) — ownership carries tenant-lifecycle + owner-management authority and
must be granted by hand; a stored OWNER row is dropped at resolution too.
A mapping to **AI_ADMIN** is created, changed and removed by an OWNER only, as
on the members page. The group sync never moves a member who carries a custom
role into AI_ADMIN (outcome `custom_role_held`) — remove the custom role first.

### Enforce group gate
When **on**, a user who matches **none** of your mappings is denied access to
the tenant for that session (they land on `/no-tenant`; any other tenants they
belong to are unaffected). Caveat: the gate only denies once **at least one
mapping exists** — with zero mappings configured it is a no-op (so turning the
gate on before adding mappings does not lock everyone out).

### Claim mode
Only **Security groups** is supported today. *Application Roles* (`roles` claim)
is reserved in the config schema for back-compat but is not implemented and is
no longer offered in the UI.

### Audit trail
Every mapping change (create / update / delete) and every sign-in role sync is
written to the tenant audit log (**Admin → Audit Log**) with the before/after
role and the actor. Operationally, the `auth.entra.role_sync` and
`auth.entra.group_resolution` OTel metrics surface sync outcomes and Graph
health; a `gate_denied` spike usually means a misconfigured mapping.

## Microsoft Entra ID — staging smoke verification

The Entra group-claim pipeline (EI-1) and its observability (EI-4) are
**unit-tested hermetically**: `resolveEntraGroupClaims` and
`fetchUserGroupsFromGraph` take an injectable `fetchImpl`, and the
`tests/helpers/entra.ts` fixtures mock the Graph `/me/memberOf` boundary. That
covers the *logic* (direct claim vs overage fetch vs fail-open, pagination,
dedup, metric labels) with zero network — but it cannot confirm that our
fixtures match Microsoft's **real** token / Graph shapes. Only a real tenant
can. Run this manual checklist against a **staging Entra tenant** after any
change to the Entra sign-in path, and whenever Microsoft changes the Graph API
version.

**Prerequisites**
- A staging Entra App Registration with a **groups** claim configured (Token
  configuration → add `groups` → *Security groups*) and the
  `GroupMember.Read.All` delegated scope granted (needed for the overage Graph
  fetch). Configure it in the IC admin UI at **Admin → Entra ID**.
- At least one test user who is a member of a few security groups, and — to
  exercise the overage path — one user in **> ~200** groups (Entra omits the
  `groups` claim and emits `_claim_names.groups` above that threshold).

**Checklist**
1. **Direct-claim path.** Sign in as the few-groups user via Microsoft. Confirm
   the JWT carries `aadGroups` (the user's security-group object IDs) and
   `aadGroupsOverage === false`. Metric: one `auth.entra.group_resolution`
   record with `source=token`.
2. **Overage path.** Sign in as the >200-groups user. Confirm `aadGroups` is
   populated from Graph and `aadGroupsOverage === true`. Metrics: a
   `source=graph_overage` record plus an `auth.entra.graph_fetch.duration`
   sample. **`outcome=empty` on this path is a Graph failure** (the helper
   fails open to `[]`) — investigate before trusting group-driven roles.
3. **Fail-open.** Temporarily revoke the `GroupMember.Read.All` consent and
   re-run the overage sign-in. Sign-in must still succeed with `aadGroups = []`
   (never blocked) and emit `source=graph_overage, outcome=empty`.
4. **EI-2/EI-3 (group → role mapping).** Add a group → role mapping at
   **Admin → Entra ID → Group → role mappings** for a group the test user is
   in, then re-sign-in and confirm the user's membership role syncs to the
   mapped role; toggle **enforce group gate** and confirm a user in no mapped
   group is denied.

**Anchor the fixtures to reality.** While doing (1)/(2), capture — with **all
GUIDs redacted and no tokens / emails** — (a) the decoded `_claim_names` /
`_claim_sources` block from an overage token and (b) one
`GET /me/memberOf/microsoft.graph.group?$select=id` JSON page (the typed cast IC
uses — returns groups only). Commit them under `tests/fixtures/entra/`
(replacing the documented-shape placeholders verbatim); the existing
`tests/unit/entra-recorded-fixtures.test.ts` already asserts they parse through
`fetchUserGroupsFromGraph` + `resolveEntraGroupClaims`, so a future Graph-shape
drift fails CI instead of silently breaking production.

## Test IdP Setup

### Okta Developer (OIDC)

1. Create a free [Okta Developer](https://developer.okta.com) account
2. Go to **Applications** → **Create App Integration** → **OIDC - OpenID Connect** → **Web Application**
3. Set:
   - **Sign-in redirect URI**: `http://localhost:3000/api/auth/sso/oidc/callback`
   - **Sign-out redirect URI**: `http://localhost:3000/login`
4. Copy the **Client ID**, **Client Secret**, and **Okta domain** (issuer = `https://<your-okta-domain>`)
5. In the app admin panel, go to SSO → OIDC tab and enter the values
6. Enable the provider and click **Test Login**

### Okta Developer (SAML)

1. In Okta, go to **Applications** → **Create App Integration** → **SAML 2.0**
2. Set:
   - **Single sign-on URL**: `http://localhost:3000/api/auth/sso/saml/callback`
   - **Audience URI (SP Entity ID)**: `http://localhost:3000/saml/metadata/<your-tenant-slug>`
   - **Name ID format**: `EmailAddress`
3. Download the IdP metadata or copy:
   - **IdP SSO URL**
   - **IdP Entity ID / Issuer**
   - **X.509 Certificate**
4. In the app admin panel, go to SSO → SAML tab and enter the values

### Environment Variables

```env
# Required for SSO
APP_URL=http://localhost:3000        # Your application URL
AUTH_SECRET=<your-auth-secret>       # NextAuth.js secret for JWT signing
```

## Troubleshooting

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "SSO provider not found" | Provider disabled or wrong tenant | Check admin panel — ensure provider is enabled |
| "Domain not allowed" | Email domain not in `emailDomains` | Add user's domain to provider config, or clear the field to allow any domain |
| "No matching account" | User doesn't exist or has no membership | Invite user first, or enable JIT provisioning |
| "Identity conflict" | User already linked to a different IdP subject | Contact admin to unlink the existing identity |
| "Cross-tenant login blocked" | Identity link exists for a different tenant | User must log into the correct tenant |
| "SAML response validation failed" | Certificate mismatch, an expired or replayed assertion, or a response that does not answer this sign-in's request | Verify the X.509 certificate matches the IdP, the IdP app's ACS URL is exactly the one the admin page shows (it must equal the assertion's `Recipient`), and the sign-in was started from Inflect and finished within 10 minutes |
| OIDC sign-in fails, and the `discovery`, `token_exchange` or `id_token_verification` (`keys_unavailable`) log line names `only https`, a `private address`, `cannot resolve` or a redirect | The SSRF guard refused the issuer, the discovery-URL override, or an endpoint the discovery document names | Use the https URL the IdP finally answers at. On a self-hosted install with an internal IdP, add its range to `EGRESS_PRIVATE_CIDR_ALLOWLIST` |

### Diagnostic Logs

SSO events are logged in structured JSON format:
```json
{
  "timestamp": "2026-03-22T09:12:34.567Z",
  "level": "warn",
  "component": "sso",
  "message": "Identity linking rejected",
  "tenantSlug": "acme-corp",
  "providerType": "OIDC",
  "stage": "identity_linking",
  "requestId": "sso-abc123-xyz789"
}
```

**Never logged**: tokens, assertions, secrets, certificates, client secrets.

### Security Checklist

- [ ] Secrets encrypted at rest (via Prisma field-level encryption or KMS)
- [ ] HTTPS enforced in production (`APP_URL` starts with `https://`)
- [ ] `AUTH_SECRET` is a strong random value (≥32 chars)
- [ ] IdP certificates are current and not expired
- [ ] `emailDomains` configured to restrict SSO to your organization
- [ ] JIT provisioning reviewed — consider leaving disabled unless needed
- [ ] Break-glass admin has local password set before enforcing SSO
