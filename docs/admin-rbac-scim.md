# Admin, RBAC & SCIM — Operational Guide

## Admin Information Architecture

```
/t/[tenantSlug]/admin
├── Audit Log (default tab)
├── Policy Templates
├── Members & Roles    → /admin/members
├── Roles & Access     → /admin/rbac
├── Billing            → /admin/billing
├── SSO & Identity     → /admin/sso
├── SCIM Provisioning  → /admin/scim
└── Security & MFA     → /admin/security
```

All admin pages require `canAdmin` permission (ADMIN role on `TenantMembership`).

## Member Management

### Invite a Member
1. Navigate to **Members & Roles**
2. Enter email address and select role
3. Click **Send Invite**

### Change a Member's Role
1. Open **Members & Roles**
2. Click the role dropdown next to the member
3. Select the new role

**Safety**: The last ADMIN cannot demote themselves.

### Remove/Deactivate a Member
1. Open **Members & Roles**
2. Click the action menu → **Deactivate**
3. Member's status changes to DEACTIVATED

Deactivated members lose access. Their historical records (audit entries, task assignments, evidence reviews) remain intact.

## Roles

| Role | Permissions |
|------|------------|
| **ADMIN** | Full access: member management, settings, billing, SSO, SCIM |
| **EDITOR** | Create/edit resources (controls, risks, evidence, policies) |
| **AUDITOR** | Read-only + audit cycle management |
| **READER** | Read-only access to tenant resources |

## SSO Configuration

Navigate to **SSO & Identity** (`/admin/sso`).

### Supported Protocols
- **OIDC** — Okta, Azure AD, Google Workspace, Auth0
- **SAML 2.0** — Any SAML-compliant IdP

### Enforcement
- **Disabled**: SSO available but not required
- **Enabled**: SSO available for configured email domains
- **Enforced**: All non-admin users must use SSO (break-glass: admins with local password can bypass)

## SCIM 2.0 Provisioning

### Endpoints

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/scim/v2/ServiceProviderConfig` | GET | SCIM capabilities (public) |
| `/api/scim/v2/Users` | GET, POST | List/create users |
| `/api/scim/v2/Users/:id` | GET, PATCH, PUT, DELETE | User CRUD |
| `/api/scim/v2/Groups` | GET, POST | List/create groups |
| `/api/scim/v2/Groups/:id` | GET, PATCH, PUT, DELETE | Group CRUD + membership |

`POST /Groups` requires an `externalId` and it must be an opaque identifier —
no whitespace, 6-255 chars of `[A-Za-z0-9._:@|-]`. It is NOT required to be a
UUID: Okta group ids look like `00g1a2b3c4D5E6f7g8h9`, and requiring a UUID
would 400 every non-Entra IdP this page advertises. Format is not the control
either way — a single-token display name is indistinguishable from an opaque
id by shape. What protects this value is that it is what the group → role
mappings (`TenantEntraGroupMapping.aadGroupId`) are joined on, that the role
ceiling clamps whatever a mapping resolves to, and that there is no fall-back to
`displayName`.

A Group resource's `members` are projected from the members IC actually
resolved (via `UserIdentityLink`), reported as this service provider's own User
ids. Pushed member values that matched no identity link do not appear.

### Setup
1. Navigate to **SCIM Provisioning** (`/admin/scim`)
2. Click **Generate Token** and copy the token (shown once only)
3. Configure your IdP's SCIM connector:
   - **Base URL**: The SCIM endpoint shown on the page
   - **Auth**: Bearer token (HTTP header)
   - **Operations**: Create, Update, Deactivate

### Token Rotation
1. Generate a new token
2. Update your IdP with the new token
3. Revoke the old token

### Role Mapping

| SCIM Role Value | Local Role | Status |
|----------------|------------|--------|
| `reader` | READER | ✅ Default |
| `editor` | EDITOR | ✅ Allowed |
| `auditor` | AUDITOR | ✅ Allowed |
| `admin` | — | ⛔ Blocked |
| `owner` | — | ⛔ Blocked |

**ADMIN and OWNER cannot be assigned via SCIM.** They must be set by an existing
admin in the product.

The allow-list above is `SCIM_ASSIGNABLE_ROLES` in `src/lib/scim/roles.ts`, and
it is the ONLY copy. It also bounds the **Groups** path, which resolves roles
through the Entra group → role mappings (`/admin/entra`), where ADMIN *is* a
legal mapping target for the sign-in path. A pushed SCIM group whose
`externalId` matches an ADMIN mapping therefore assigns nothing; if the same
user also matches an EDITOR mapping, EDITOR is applied — the ceiling clamps the
resolution rather than voiding it.

### Protected memberships

SCIM does not modify a membership whose role it could not itself have assigned
— ADMIN and OWNER. That covers the status writes as well as the role writes:

| SCIM operation against an ADMIN/OWNER membership | Result |
|---|---|
| `DELETE /Users/:id` | `403` (`scimType: mutability`), nothing written |
| `PATCH active=false` (a real transition) | `403`, nothing written |
| `PUT` with a status change | `403`, nothing written |
| `PUT` or `PATCH` of a profile field (display name) | Succeeds; the profile write is **silently skipped**, like the role write. `User.name` is on the GLOBAL user row, so performing it would let one tenant's SCIM token rename another tenant's administrator. Skipped rather than `403` so a routine IdP sync cycle does not fail for every admin |
| `POST /Users` re-creating a deactivated one | Reactivation skipped; the response reports the membership's real status |
| Any role change (Users or Groups path) | Silently skipped |

Deactivating an administrator is a privileged act, so it belongs to a session in
`/admin/members`, not to a bearer token. A `PATCH active=true` that changes
nothing is *not* refused — a full IdP sync re-pushes it every cycle.

### Deactivation Behavior
- SCIM `DELETE` or `PATCH active=false` → membership `DEACTIVATED`
- User loses tenant access immediately
- Historical records preserved (audit trail, task ownership, evidence)
- Re-provisioning the same user reactivates their membership — unless it is a
  protected membership (see above)

### Audit Events

**Users-path** operations emit structured audit events. **The Groups path emits
none** — `src/app-layer/usecases/scim-groups.ts` contains zero
`appendAuditEntry` / `emitScimAudit` calls, so a group create, member add or
member removal leaves no audit row, even though a member change can alter a
user's role through the mapping engine. That is a known gap, not a description
of current behaviour, and it is tracked with the wider point that SCIM
*refusals* are audit-invisible too (`assertScimMayWrite` emits a `logger.warn`
where `requirePermission` writes a hash-chained `AUTHZ_DENIED` row).

The Users-path events are:
- `SCIM_USER_CREATED`
- `SCIM_USER_UPDATED`
- `SCIM_USER_DEACTIVATED`
- `SCIM_USER_REACTIVATED`
