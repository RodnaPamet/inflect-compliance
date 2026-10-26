# 2026-10-25 — Entra group mappings apply only to the configured directory

## Design

The Entra provider (`TenantIdentityProvider`, type `ENTRA_ID`) stored a
`aadTenantId` and a `clientId` that nothing read. Microsoft sign-in runs through
the deployment's own app (`MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_ID`), which
may admit any directory, and `syncEntraMembershipRole` matched the token's group
object IDs against the workspace's mappings without asking which directory the
account came from. So a workspace's mappings applied to anyone whose Microsoft
account carried a group ID equal to a mapped one, and making the directory field
Owner-only on its own (#4118) would have protected a value with no effect.

Now:

```
sign-in (auth.ts jwt) ──tid──▶ syncEntraMembershipRole(signInDirectoryId)
                                  │ mappings? OWNER?  (unchanged order)
                                  │ tid == provider.aadTenantId ?
                                  │   no  → foreign_directory; gate on ⇒ denied
                                  │   yes → resolve mappings, gate, apply
SCIM Groups push ─────────────▶ syncEntraMembershipRole()   (no signInDirectoryId: unchanged)
```

Setting the provider up, and changing `aadTenantId` or `clientId`
(`ENTRA_TRUST_CONFIG_KEYS`), needs `admin.owner_management`, with the same
refusal reason as the OIDC/SAML trust fields (`SSO_TRUST_IS_OWNER_TIER`). The
page shows both fields read-only to an Admin and says why.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/entra-group-sync.ts` | directory check before mapping resolution |
| `src/auth.ts` | passes the Microsoft profile's `tid` |
| `src/lib/observability/metrics.ts` | `foreign_directory` outcome |
| `src/lib/auth/sso-trust-fields.ts` | `ENTRA_TRUST_CONFIG_KEYS` and the refusal message |
| `src/app-layer/usecases/entra-provider.ts` | Owner-tier check, `changedFields` in the audit row |
| `src/app/t/[tenantSlug]/(app)/admin/entra/page.tsx` | read-only fields and notice for an Admin |

## Decisions

- **Fail closed.** No `tid` on the token, or no configured directory, applies no
  mapping at sign-in. A workspace that set up mappings and never entered its
  directory loses sign-in role sync until an Owner enters it; that is the price
  of the mappings meaning anything.
- **The gate refuses a foreign directory** when it is on, as it refuses a
  sign-in that matches no mapping: the gate exists to keep out accounts the
  workspace did not vouch for, and another directory's account is one.
- **OWNER stays immune**, checked before the directory, as before.
- **SCIM is unaffected.** The Groups push is authenticated by the workspace's
  own SCIM token and has no sign-in to read a directory from; the sign-in path
  marks itself by passing `signInDirectoryId` (a string or `null`), the SCIM
  path omits it.
- **GUIDs compare case-insensitively**, in the sync and in the Owner-tier diff,
  so re-typing the same GUID in another case is neither a mismatch nor a trust
  change.
- **No link removal on a directory change**, unlike the OIDC/SAML trust change:
  Entra sign-in creates no `UserIdentityLink` rows; the mapping is re-evaluated
  at every sign-in.
