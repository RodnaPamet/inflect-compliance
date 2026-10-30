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
- **{{ui:admin.resourceLabels.personnel}}** / **{{ui:admin.roles.actions.manage}}** can be part only of a custom role based on Admin. On any other base its cell is greyed out, a preset does not switch it on, and moving a role off Admin switches it off. A role saved with it on another base before this rule existed has had it switched off; such a role cannot be saved again while it keeps it.
- Only Owner and Admin members reach the admin pages. A custom role that gives admin permissions to an Editor, Auditor or Reader can show them the admin pages, but most of those pages cannot load or save anything for them. Make them an Admin instead.

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

On the {{ui:admin.nav.members}} page, open the member's role editor and choose the custom role from the second list. You can give a role only if you hold every permission it grants. See [{{ui:admin.members.title}}](members.md).

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
| **Custom role not found.** | Someone deleted the role since the page loaded | Reload the page |
| **{{ui:admin.roles.createFailed}}**, **{{ui:admin.roles.updateFailed}}** or **{{ui:admin.roles.deleteFailed}}** | The change did not go through | Reload the page and try again |

## Related

- [{{ui:admin.members.title}}](members.md), where members are given a custom role or have one taken away.
- [Change a member's role](../../how-to/set-up/change-a-members-role.md), step by step, including custom roles.
- **{{ui:admin.nav.rbac}}**, under {{ui:admin.section.people}} on the {{ui:admin.title}} page, for what each built-in role allows.
