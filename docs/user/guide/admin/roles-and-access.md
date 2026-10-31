---
route: /t/[tenantSlug]/admin/rbac
---

# {{ui:admin.rbac.title}}

The {{ui:admin.rbac.title}} page shows who is in this workspace with which role, and a matrix of what each built-in role can do. It is read-only: roles are changed on [{{ui:admin.members.title}}](members.md), and custom roles are built on [{{ui:admin.nav.roles}}](roles.md).

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.rbac}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.rbac.crumbSelf}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can open the page only if that role can manage members.

## What it is for

Use it to answer "who can do what here?" in one view, for an access review or an auditor's question, and to check what a role allows before you give it to someone.

## What you see

Under the title, a sentence names the workspace and shows your own role.

**{{ui:admin.rbac.teamMembers}}.** Everyone who has a membership in the workspace, in the order they joined:

| Column | What it shows |
| --- | --- |
| {{ui:admin.rbac.colName}} | Their name, or — |
| {{ui:admin.rbac.colEmail}} | Their email address |
| {{ui:admin.rbac.colRole}} | Their built-in role: OWNER, ADMIN, EDITOR, READER, AUDITOR or AI_ADMIN |
| {{ui:admin.rbac.colJoined}} | When their membership was created |

The list includes memberships that have been deactivated, removed, or invited and waiting to be accepted, and does not say which. A member's custom role, if they have one, is not shown here; [{{ui:admin.members.title}}](members.md) shows both.

**{{ui:admin.rbac.permissionMatrix}}.** One row per permission, one column per built-in role, and a tick where the role has the permission. Each row names an area of the product in the {{ui:admin.rbac.resource}} column, such as risks, evidence or admin, and what can be done there in the {{ui:admin.rbac.action}} column, such as view, create, edit or approve. The matrix shows the built-in roles only; a custom role grants whatever it was built with.

## What you can do

Read the page. Nothing on it changes a role or a permission.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.members.title}}](members.md), to change a member's role.
- [{{ui:admin.nav.roles}}](roles.md), to build a role of your own.
