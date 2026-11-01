# 2026-11-01 — Microsoft Entra ID sign-in rules in every workspace, held for the session

**Issue:** #4869 (found while writing the Entra page's help guide, round 14)

## Design

Before this change, a Microsoft sign-in ran the Entra group sync for one workspace, the
session's primary (oldest) membership. A member whose oldest membership was elsewhere got no
role from this workspace's mappings, and this workspace's gate was never asked. The page's
"Allowed sign-in domains" were stored as the provider's `emailDomains` and read only by the
SAML/OIDC path, so they kept nobody out.

```
microsoft-entra-id sign-in (jwt callback)
  token.entraGateDeniedTenantIds = []            ← a sign-in decides afresh
  applyMembershipClaims(token)                   ← reads it: refused workspaces left out
  syncEntraMembershipRolesAtSignIn               ← every ACTIVE membership whose
     └─ for each workspace with an ENTRA_ID         workspace has an ENTRA_ID provider
          syncEntraMembershipRole(…, signInDirectoryId, signInEmail)
             OWNER immune → directory → allowed domains → ceiling → gate → mapping
  applyEntraSyncToToken(token, tenantId, result) ← per workspace
     gateDenied → drop from memberships, add to entraGateDeniedTenantIds,
                  re-point the primary only if it was the primary
     role       → that workspace's memberships[] entry; token.role only if primary

every later request
  edge: memberships[] (the five-minute re-read keeps refused workspaces out)
  getTenantCtx / getLegacyCtx / getTenantServerContext:
        isRefusedByEntraGate(session.entraGateDeniedTenantIds, tenantId) → 403
  /tenants, /no-tenant: a refused workspace is not a destination; /no-tenant names it
```

The refusal was also never durable. `applyMembershipClaims` re-reads memberships from the
database on the jwt callback's five-minute cadence, and a gate refusal lived only in
`memberships[]`, so the refused workspace came back within minutes. The owner chose to hold
the refusal for the session (2026-11-01). It is now its own claim, the same shape as the SSO
scope (`ssoTenantId`), and the same gates read it.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/entra-group-sync.ts` | Domain rule in `syncEntraMembershipRole`; `syncEntraMembershipRolesAtSignIn` fans out; `applyEntraSyncToToken` records refusals and leaves the primary alone for another workspace |
| `src/lib/auth/entra-gate-scope.ts` | Pure: `emailDomainAllowed`, `isRefusedByEntraGate`, `ENTRA_GATE_REFUSAL` |
| `src/auth.ts` | Claim types; reset at sign-in; the fan-out; `applyMembershipClaims` filter; session field |
| `src/lib/auth.ts`, `src/app-layer/context.ts`, `src/lib/server/tenant-context.server.ts`, `src/app/t/[tenantSlug]/layout.tsx` | The DB-backed gates refuse a refused workspace |
| `src/lib/auth/sign-in-destinations.ts`, `src/app/tenants/page.tsx`, `src/app/no-tenant/page.tsx` | A refused workspace is not offered; `/no-tenant` says why |
| `src/app/api/t/[tenantSlug]/sso/entra/route.ts` | GET also returns the deployment's sign-in app (client ID, redirect URI) |
| `src/app/t/[tenantSlug]/(app)/admin/entra/*` | Step 1 in words for the shared deployment, client ID scoped to self-hosted, load failures, refusals worded from the server, breadcrumb |

## Decisions

- **The domain rule runs after the directory check and only narrows.** A sign-in from the
  wrong directory is already foreign; the domain list can only take a sign-in out, never let
  one in. So it stays an ADMIN setting, unlike the directory and client ID, which are
  Owner-tier. An ADMIN can already turn the gate on, which refuses more than a domain list does.
- **Whole-domain match, as the SSO check does.** `contoso.com` does not admit
  `mail.contoso.com`. A list entry is trimmed, lower-cased and stripped of a leading `@`. A
  sign-in with no email is refused by a non-empty list.
- **Every workspace with a provider, not only those naming the sign-in's directory.** The owner's
  decision names the matching workspaces for the mappings. A workspace with a different
  directory and the gate on still refuses the sign-in (`foreign_directory`), which is what
  it already did for the primary workspace. Asking only matching workspaces would have
  dropped that refusal for every other workspace.
- **A failing workspace fails open, as the primary did.** One workspace's error is logged and
  skipped; it does not block the others or the sign-in. That matches the existing
  best-effort behaviour, and is noted as such.
- **The claim resets at each sign-in.** The refusal holds for the session; the next Microsoft
  sign-in decides again. A non-Microsoft sign-in carries no refusal: the gate is about
  Microsoft sign-ins.
- **The client ID stays, scoped to self-hosted.** Sign-in uses the deployment's
  `MICROSOFT_CLIENT_ID`. The page shows that app's ID and says when the stored one differs.
  On the shared deployment the groups claim is configured on Inflect's app, not by the
  customer, so step 1 asks for consent and explains the groups permission. The groups-claim
  instruction is kept under "If you run Inflect yourself", where the app is the customer's.
