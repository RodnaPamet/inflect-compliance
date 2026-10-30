---
route: /t/[tenantSlug]/admin/roles
---

# {{ui:admin.roles.title}}

The {{ui:admin.roles.title}} page holds the roles your workspace defines for itself. A custom role is a set of permissions chosen one by one, for people whose work does not fit a built-in role. Owners and Admins create, change and delete custom roles here, and give them to members on the {{ui:admin.nav.members}} page.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.roles}}**.

The pill beside it, **{{ui:admin.nav.rbac}}**, is a different page: it shows what each built-in role allows, and changes nothing.

## Who can use it

| Action | Roles |
| --- | --- |
| See the workspace's custom roles | Owner, Admin |
| Create, change and delete a custom role | Owner, Admin |
| Put a permission only an Owner holds into a custom role: deleting the workspace and rotating its encryption keys, managing Owners, and owning agents | Owner |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

You can put into a custom role only the permissions you hold yourself. In the permission grid, a permission you do not hold is greyed out and cannot be switched on; for an Admin, these are the Owner-only ones. A custom role that already holds one, because an Owner built it, cannot be saved by an Admin while it keeps it, even with only a new name: the form names those permissions and keeps **{{ui:admin.roles.editSubmit}}** greyed out until they are switched off.

An Admin whose membership carries a custom role can do only what that custom role allows. If it cannot manage the workspace's settings, the page still opens, but shows **{{ui:admin.roles.loadFailed}}** with the reason, **Permission denied**, in place of the list.

## What it is for

The built-in roles cover most people: Owner, Admin, Editor, Auditor, Reader and AI admin. A custom role covers the rest, such as an Editor who may also approve policies, or a Reader who may also upload evidence.

**A custom role replaces a member's permissions.** When a member carries one, its permission grid decides what they can do, in place of their built-in role's permissions. Their built-in role stays on their membership, and applies again if the custom role is taken away or deleted.

A few rules hold whatever your role:

- An Owner or an AI admin never carries a custom role, and no custom role is built on either of them. Their permissions are always the built-in set.
- Each custom role is built on a base role: Admin, Editor, Auditor or Reader. Wherever Inflect checks a level of role rather than a single permission, a member carrying the custom role counts as its base role. A custom role that grants an action its base role lacks may therefore be refused when that action is used, so choose the base role closest to what the role grants.
- Five permissions can be part only of a custom role based on Admin: **{{ui:admin.resourceLabels.admin}}** / **{{ui:admin.roles.actions.manage}}**, **{{ui:admin.roles.actions.members}}**, **{{ui:admin.roles.actions.owner_management}}** and **{{ui:admin.roles.actions.tenant_lifecycle}}**, and **{{ui:admin.resourceLabels.personnel}}** / **{{ui:admin.roles.actions.manage}}**. Each needs the Admin level wherever it is used, so on another base it would let a member start an action and then refuse it. On any other base their cells are greyed out, a preset does not switch them on, and moving a role off Admin switches them off. A role saved with one of them on another base before this rule existed has had it switched off; such a role cannot be saved again while it keeps one.
- Only Owner and Admin members can use the admin pages' controls, whatever custom role they carry. So two kinds of custom role can be carried only by an Admin member, and are refused for an Editor, Auditor or Reader:
  - a role built on Admin, because members carrying it would count as Admins everywhere except the admin pages;
  - a role that grants any of these ten admin permissions:
    - {{ui:admin.roles.actions.sso}}, {{ui:admin.roles.actions.agent_tool_exposure}}, {{ui:admin.roles.actions.agent_policy_card}}, {{ui:admin.roles.actions.agent_ownership}}, {{ui:admin.roles.actions.agent_skill_review}} and {{ui:admin.roles.actions.agent_skill_author}}. Each is used only on the admin pages, so on anyone but an Admin it would grant nothing.
    - {{ui:admin.roles.actions.scim}}, {{ui:admin.roles.actions.compliance_dsar_manage}}, {{ui:admin.roles.actions.agent_harness_ingest}} and {{ui:admin.roles.actions.agent_external_tools}}. These do work outside the admin pages: through an API key acting for the member, or an agent run the member starts. That is a way around the admin pages' own rule, so they too are kept for Admins.

  An admin permission in neither list can be given to anyone in a custom role, because it also works outside the admin pages: reading the agent register, for example. A custom role that Editors, Auditors or Readers already carry cannot be changed into one of the two kinds while they carry it, so it cannot hold any of the five permissions above that need a role based on Admin either.
- When these rules came in, the ten permissions above were switched off in every custom role that only Editors, Auditors or Readers carried. Members carrying such a role lost any of the ten they had, including the four that worked outside the admin pages; an API key acting for them, or an agent run they start, is now refused what needs one. A role that an Admin also carried kept them, and so did a role nobody carried. No role's base role was changed.
- Otherwise a custom role given to an Editor, Auditor or Reader before these rules applied keeps working as it did. You can still rename it, switch permissions off, choose a lower base role, or take it away; you cannot add one of the ten permissions to it, or build it on Admin. To give one back, first make its members Admins or give them another custom role on the {{ui:admin.nav.members}} page.

## What you see

**The header.** The page title, a line counting the custom roles, and **{{ui:admin.roles.addRole}}**, the button with a plus sign, which opens the form. The button is hidden while a form is open.

**Messages.** A green message confirms each change. A red message says why a change did not go through. Close either with its cross.

**The table.** One row per custom role. Deleted roles are not listed, and the role you are editing is hidden while its form is open.

| Column | What it shows |
| --- | --- |
| {{ui:admin.roles.colName}} | The role's name |
| {{ui:admin.roles.colBaseRole}} | The base role: {{ui:roles.ADMIN}}, {{ui:roles.EDITOR}}, {{ui:roles.AUDITOR}} or {{ui:roles.READER}} |
| {{ui:admin.roles.colDescription}} | What the role is for, or a dash |
| {{ui:admin.roles.colMembers}} | How many memberships carry the role, deactivated ones included |
| {{ui:admin.roles.colPermissions}} | How many of the grid's permissions the role grants, out of the total |

The pencil at the end of a row is **{{ui:admin.roles.editRole}}**, and the bin is **{{ui:admin.roles.deleteRole}}**.

**The form.** It opens above the table, titled **{{ui:admin.roles.createTitle}}** for a new role, or with the role's name for an existing one.

| Field | What it sets |
| --- | --- |
| {{ui:admin.roles.nameLabel}} | The role's name, up to 100 characters. Required, and unique among the workspace's custom roles. A deleted role's name can be used again |
| {{ui:admin.roles.baseRoleLabel}} | Admin, Editor, Auditor or Reader, starting on Reader. The base role decides how members carrying the role count where a level of role is checked, as described above |
| {{ui:admin.roles.descriptionLabel}} | An optional note, up to 500 characters |

**{{ui:admin.roles.showGrid}}** opens the permission grid; **{{ui:admin.roles.hideGrid}}** closes it. The grid is open from the start when you edit a role. Each row is an area of the product, under **{{ui:admin.roles.gridResource}}**, and each column an action, such as {{ui:admin.roles.actions.view}}, {{ui:admin.roles.actions.create}}, {{ui:admin.roles.actions.edit}} or {{ui:admin.roles.actions.approve}}. A dash means the area has no such action. A green tick means the role grants it; click a cell to switch it. Point at a cell, or move to it with the keyboard, to see which permission it is and whether the role grants it.

A permission you do not hold yourself is greyed out, and a note above the grid says so: you cannot switch it on. If the role already grants it, you can switch it off, but not back on.

Beside **{{ui:admin.roles.presetFrom}}**, click a built-in role to fill the whole grid with that role's permissions, leaving out any you do not hold yourself.

## What you can do

### Create a custom role

1. Click **{{ui:admin.roles.addRole}}**.
2. Enter a name. Choose the base role. The grid then holds that role's permissions, as a starting point, less any you do not hold yourself.
3. Click **{{ui:admin.roles.showGrid}}** and switch the permissions you want to add or take away.
4. Click **{{ui:admin.roles.createSubmit}}**. It stays greyed out until the role has a name. **{{ui:admin.roles.cancel}}** closes the form without saving.

The role appears in the table, and the {{ui:admin.nav.members}} page offers it from then on.

### Change a custom role

Click **{{ui:admin.roles.editRole}}**. The form opens above the table with the role's name, base role, description and grid. Change what you need and click **{{ui:admin.roles.editSubmit}}**.

While you edit, changing the base role does not change the grid. To start the grid again from a built-in role, use **{{ui:admin.roles.presetFrom}}**.

A change applies at once to every member who carries the role. Their pages show it the next time they load.

### Delete a custom role

Click **{{ui:admin.roles.deleteRole}}**, the bin at the end of the role's row. A dialog asks you to confirm and, if members carry the role, says how many. In the dialog, click **{{ui:admin.roles.deleteConfirmLabel}}** to delete it, or **{{ui:common.cancel}}** to keep it.

The role leaves the table, and every member who carried it goes back to their own built-in role: the one in the role column on the {{ui:admin.nav.members}} page, not the custom role's base role. That role may allow more than the custom role did, or less. The message says how many members changed. Deleting cannot be undone, but the role's name is free again: a new role can take it.

### Give a member a custom role

On the {{ui:admin.nav.members}} page, open the member's role editor and choose the custom role from the second list. You can give a role only if you hold every permission it grants, and a role built on Admin, or granting a permission only an Admin member can use, only to an Admin. See [{{ui:admin.members.title}}](members.md).

## What happens next

- Creating, changing and deleting a custom role each add an entry to the workspace's audit log, naming who did it. So does giving a member a custom role, or taking one away. Open the log from **{{ui:admin.auditLog}}** on the {{ui:admin.title}} page.
- A deleted role's name is free again. A new role, or a renamed one, can use it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| A message that no custom roles are defined yet, in place of the table | The workspace has no custom roles | Click **{{ui:admin.roles.addRole}}** |
| **{{ui:admin.roles.loadFailed}}**, in place of the table, with the reason below it | The list did not load. **Permission denied** means your custom role cannot manage the workspace's settings | Click **{{ui:common.error.tryAgain}}**. If the reason is **Permission denied**, ask an Owner or Admin |
| A message that a custom role with that name already exists | Another custom role in the workspace has the name. A deleted role's name does not count | Choose another name |
| A note in the form that the role grants permissions you do not hold yourself, and **{{ui:admin.roles.editSubmit}}** greyed out | The role was built by someone who holds more than you, such as an Owner | Switch those permissions off in the grid, or ask an Owner to make the change |
| A message that you cannot give a role permissions you do not hold yourself, naming them | Your own permissions, or the role, changed since the page loaded | Reload the page and try again, or ask an Owner to make the change |
| A message that the role can only be carried by an Admin membership, saying how many members carrying it hold another role | You built the role on Admin, or switched on one of the permissions only an Admin member can use, while Editors, Auditors or Readers carry it | Switch the permission off or choose another base role. Or, on the {{ui:admin.nav.members}} page, make those members Admins or give them another custom role first |
| **Custom role not found.** | Someone deleted the role since the page loaded | Reload the page |
| **{{ui:admin.roles.createFailed}}**, **{{ui:admin.roles.updateFailed}}** or **{{ui:admin.roles.deleteFailed}}** | The change did not go through | Reload the page and try again |

## Related

- [{{ui:admin.members.title}}](members.md), where members are given a custom role or have one taken away.
- [Change a member's role](../../how-to/set-up/change-a-members-role.md), step by step, including custom roles.
- **{{ui:admin.nav.rbac}}**, under {{ui:admin.section.people}} on the {{ui:admin.title}} page, for what each built-in role allows.
