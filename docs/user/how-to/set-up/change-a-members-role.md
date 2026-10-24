# Change a member's role

A member's role decides what they can see and do in this workspace. Change it when someone's job changes, or when they need more or less access. The same page also deactivates and removes members.

## Before you start

- You need the Owner or Admin role. With a custom role, what you can do depends on the permissions your role was given.
- You can change the role of an **ACTIVE** member only. Someone new needs an invite first.
- The roles you can give depend on your own role:

| Your role | Roles you can give | Whose role you can change |
| --- | --- | --- |
| Owner | {{ui:roles.ADMIN}}, {{ui:roles.EDITOR}}, {{ui:roles.AUDITOR}}, {{ui:roles.READER}} and {{ui:roles.AI_ADMIN}} | Every active member, Owners and AI admins included |
| Admin | {{ui:roles.ADMIN}}, {{ui:roles.EDITOR}}, {{ui:roles.AUDITOR}} and {{ui:roles.READER}} | Every active member except Owners and AI admins |

- Nobody can make a member an Owner on this page. Owner is never in the list of roles.
- A workspace always keeps at least one active Owner. You cannot move the last one to another role.
- You cannot change your own role. The one exception: an Owner can move to Admin while another active Owner remains.
- If a member is the workspace's only Admin, you cannot move them to another role. Make another member an Admin first.
- Owners and AI admins never have a custom role. Remove a member's custom role before you make them an AI admin.

## Steps

1. Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens.
2. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.members}}**.
3. Find the member in the table. In the {{ui:admin.members.colRole}} column, click their role. A role you can change shows a small arrow, and its hint reads {{ui:admin.members.clickToChangeRole}}.
4. Choose the new role from the list that opens.
5. If your workspace has custom roles, a second list appears below it. Choose a custom role to give the member its permissions instead of the built-in role's. To take one away, open the list and click the selected custom role again. The list then reads {{ui:admin.members.customRolePlaceholder}}. This list does not appear for an Owner or an AI admin.
6. Click **{{ui:admin.members.save}}**. To close without saving, click the cross beside it.

## What happens next

- A message reads {{ui:admin.members.roleUpdated}}, and the row shows the new role. A custom role shows as a tag beside it.
- The member's new permissions apply the next time they open a page or take an action.
- The change is recorded in the workspace's audit log. Open it from **{{ui:admin.auditLog}}** on the {{ui:admin.title}} page.
- Your workspace may map Microsoft Entra ID groups to roles, on the {{ui:admin.nav.entra}} page. If so, a member in a mapped group can have their role set to that group's role when they sign in with Microsoft. This never changes an Owner.

## Deactivate a member

Deactivating ends a member's access but keeps their record on the page.

1. Click the three-dot menu at the end of the member's row.
2. Click **{{ui:admin.members.deactivate}}**, then confirm.

Their status changes to **DEACTIVATED**. They lose access the next time they open a page or take an action. To let them back in, invite them again. They return with the role you choose in the invite.

## Remove a member

Removing takes the member out of this workspace completely, and their row leaves the list. Use deactivation instead if you want to keep the record.

1. Click the three-dot menu at the end of the member's row.
2. Click **{{ui:admin.members.remove}}**, then confirm.

You can remove both active and deactivated members. Their account is not deleted, only their place in this workspace. To bring them back, invite them again.

**Several members at once.** Tick their rows. Choose **{{ui:admin.members.deactivate}}** or **{{ui:admin.members.remove}}** from **{{ui:common.table.chooseAction}}**, click **{{ui:common.table.apply}}** beside it, then confirm. Members that cannot be changed are listed in an error message with the reason. The others go ahead.

You cannot deactivate or remove yourself, or the last active Owner. You also cannot deactivate the workspace's only Admin.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **Cannot demote the last OWNER. Promote another OWNER first.**, **Cannot deactivate the last OWNER.** or **Cannot remove the last OWNER. Promote another OWNER first.** | This member is the workspace's only active Owner | Keep them as an active Owner. A workspace cannot be left without one |
| **Cannot remove the last admin. Promote another member first.** or **Cannot deactivate the last admin.** | This member is the workspace's only Admin | Make another member an Admin first, then try again |
| **Cannot demote yourself. Ask another admin to change your role.** | You tried to change your own role | Ask someone else who can change your role. As an Owner, you can still move yourself to Admin while another Owner remains |
| **Cannot deactivate your own membership. Ask another admin.** or **Cannot remove your own membership. Ask another admin.** | You chose your own row | Ask someone else who manages members |
| An Owner's or AI admin's role shows no arrow. Or a message says **Only OWNERs can modify an OWNER membership.** or **Only an OWNER can assign or remove the AI_ADMIN role.** | Only an Owner can change an Owner's or an AI admin's role | Ask an Owner |
| A note under the role says it cannot carry a custom role, and **{{ui:admin.members.save}}** is greyed out | The member has a custom role, and AI admin cannot have one | Choose their current role again and click the selected custom role to clear it. Click **{{ui:admin.members.save}}**, then change the role |
| On an Owner or AI admin, a note says the role cannot carry a custom role, with a **{{ui:admin.members.removeCustomRole}}** button | The member was given a custom role before that rule applied | Click **{{ui:admin.members.removeCustomRole}}** to restore the full built-in role |
| A message that starts **Cannot grant permissions you do not hold** | The custom role includes permissions you do not have yourself | Ask someone who holds those permissions to assign it |
| A member you raised to Admin or AI admin finds their admin pages empty or failing | Their current sign-in still carries their old role | Ask them to sign out and sign in again |
| Their role changes back after they sign in with Microsoft | A group mapping on the {{ui:admin.nav.entra}} page set it again | Change the mapping, or the member's groups in Microsoft Entra ID |
| {{ui:admin.members.roleChangeFailed}}, {{ui:admin.members.deactivationFailed}} or {{ui:admin.members.removalFailed}} | The change did not go through | Reload the page and try again |
