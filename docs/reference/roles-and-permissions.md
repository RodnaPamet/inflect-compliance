# Roles and permissions

Every workspace member has a built-in role, and a member can be given a custom role in its place. The table below lists every permission and which built-in roles hold it. It is generated from `getPermissionsForRole` in `src/lib/permissions.ts` on every docs build, so it always matches the code.

- A custom role starts from one of these roles and switches individual permissions on or off. See [custom roles and API keys](../enterprise-identity-custom-roles-api-keys.md).
- An Owner or AI admin membership never carries a custom role.
- A ✓ means the role passes the permission check. Some actions add a rule of their own on top, such as a workspace always keeping at least one Owner; each page guide names those rules where they apply.

The organisation roles at the end apply to the organisation workspace, which groups several workspaces.

{{generated:roles-matrix}}
