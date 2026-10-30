---
route: /t/[tenantSlug]/admin/members
---

# {{ui:admin.members.title}}

The {{ui:admin.members.title}} page lists everyone who belongs to this workspace, with their role and status. Owners and Admins use it to invite people, change what each person can do, sign people out of their devices and end their access.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.members}}**. The gear appears only for roles that can use the admin pages.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see its members, invites and sessions | Owner, Admin |
| Invite someone as an Admin, Editor, Auditor or Reader, and revoke a pending invite | Owner, Admin |
| Change the role of an Admin, Editor, Auditor or Reader, and give or remove a custom role | Owner, Admin |
| Make a member an AI admin, or change an AI admin's role | Owner |
| Change an Owner's role | Owner |
| Deactivate or remove a member who is not an Owner or an AI admin | Owner, Admin |
| Deactivate or remove an Owner or an AI admin | Owner |
| See a member's sessions and sign them out of a device | Owner, Admin |
| Sign an Owner or an AI admin out of a device | Owner |
| Set a member's line of defence | Owner, on every row except their own |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An Admin whose membership carries a custom role can do only what that custom role allows, which may not include this page.

A few rules hold whatever your role:

- A workspace always keeps at least one active Owner. The last one cannot be moved to another role, deactivated or removed.
- You cannot change your own role, with one exception: an Owner can move to Admin while another active Owner remains. You cannot deactivate or remove yourself.
- The workspace's only Admin cannot be moved to another role, deactivated or removed.
- This page never makes anyone an Owner. Owner is not offered in either list of roles.
- An Owner or an AI admin never carries a custom role.
- You can give a member a custom role only if you hold every permission it grants.
- Only an Admin member can carry a custom role built on Admin, or one that grants one of the admin permissions kept for Admins. See [{{ui:admin.roles.title}}](roles.md). A member who carries one cannot be moved from Admin to another role until the custom role is changed or taken away.

## What it is for

Use the page to decide who can reach this workspace and what each person can do in it: bring a colleague in, change their role when their job changes, and end their access when they leave. Owners also record each member's line of defence here, which Inflect's auditor-agent features rely on.

## What you see

**The header.** The page title, a count of active members and pending invites, and the **{{ui:admin.members.inviteMember}}** button.

**Messages.** A green message confirms each change. A red message says why a change did not go through. Close either with its cross.

**The members table.** One row per member, active or deactivated. Removed members are not listed, and the page has no search box.

| Column | What it shows |
| --- | --- |
| {{ui:admin.members.colMember}} | The member's picture or initials, and their name. A dash means their account has no name |
| {{ui:admin.members.colEmail}} | The address they sign in with |
| {{ui:admin.members.colRole}} | Their built-in role. A role you can change shows a small arrow, and its hint reads {{ui:admin.members.clickToChangeRole}}. A role you cannot change has no arrow, and its hint says only an Owner can change it. A custom role shows as a tag beside the role |
| {{ui:admin.members.colLineOfDefence}} | {{ui:admin.members.lineOfDefence.UNDECLARED}}, {{ui:admin.members.lineOfDefence.FIRST}}, {{ui:admin.members.lineOfDefence.SECOND}} or {{ui:admin.members.lineOfDefence.THIRD}}. For an Owner it is a list on every row except their own |
| {{ui:admin.members.colStatus}} | **ACTIVE** or **DEACTIVATED** |
| {{ui:admin.members.colSessions}} | How many live sessions the member has: devices where they are signed in and the session has neither expired nor been revoked. Click the number to see them |
| {{ui:admin.members.colJoined}} | The date their membership began |

The three-dot menu at the end of a row lists only the actions you can apply to that member:

- **{{ui:admin.members.changeRole}}** opens the role editor in the row, the same as clicking the role. Active members only.
- **{{ui:admin.members.viewSessions}}** opens the member's sessions. Active members only.
- **{{ui:admin.members.deactivate}}** ends the member's access and keeps their row. Active members only.
- **{{ui:admin.members.remove}}** takes the member out of the workspace. Active and deactivated members.

Your own row never offers {{ui:admin.members.deactivate}} or {{ui:admin.members.remove}}. A row with nothing you can apply to it has no three-dot menu, such as a deactivated Owner's row when you are an Admin.

Tick rows to act on several members at once. The selection bar offers **{{ui:admin.members.deactivate}}** and **{{ui:admin.members.remove}}**.

**{{ui:admin.members.pendingInvitationsTitle}}.** This table appears below the members table while any invite is waiting to be accepted. It shows each invite's {{ui:admin.members.colEmail}}, {{ui:admin.members.colRole}}, {{ui:admin.members.colInvitedBy}} and {{ui:admin.members.colExpires}} date. An invite leaves the list once it is accepted, revoked or expired.

**The sessions dialog.** It lists one entry per signed-in device: the browser and system the device reported, or {{ui:admin.members.unknownDevice}}, then its IP address, the date it was last active and a **{{ui:admin.members.revoke}}** button.

## What you can do

### Invite a colleague

Click **{{ui:admin.members.inviteMember}}**. The {{ui:admin.members.inviteFormTitle}} form asks for an {{ui:admin.members.emailLabel}} and a {{ui:admin.members.roleLabel}}: {{ui:roles.ADMIN}}, {{ui:roles.EDITOR}}, {{ui:roles.AUDITOR}} or {{ui:roles.READER}}, starting on {{ui:roles.READER}}. Click **{{ui:admin.members.sendInvite}}**.

The confirmation names the role and says when your colleague gets access: the next time they sign in with Google or Microsoft using the invited address, or, if they sign in any other way, once they open the invite link and accept the invite. It also says whether Inflect emailed the invite, and shows the invite link either way. Click the link to copy it. The page does not show the link again after you close the message. Inviting the same address again replaces the earlier invite, and the old link stops working.

The form does not offer Owner or AI admin. An Owner can make a member an AI admin once they have joined.

### Revoke an invite

Under {{ui:admin.members.pendingInvitationsTitle}}, tick the invites. Choose **{{ui:admin.members.revokeInviteAction}}** from **{{ui:common.table.chooseAction}}**, click **{{ui:common.table.apply}}** beside it, then confirm. The link stops working at once.

### Change a member's role

Click the member's role, or **{{ui:admin.members.changeRole}}** in the row's menu. Choose the new role. An Admin is offered {{ui:roles.ADMIN}}, {{ui:roles.EDITOR}}, {{ui:roles.AUDITOR}} and {{ui:roles.READER}}; an Owner is also offered {{ui:roles.AI_ADMIN}}. Click **{{ui:admin.members.save}}**, or the cross beside it to close without saving. Only active members' roles can be changed.

If your workspace has custom roles, a second list appears below the first. A custom role gives the member its own permissions in place of the built-in role's. To take one away, click the selected custom role again; the list then reads {{ui:admin.members.customRolePlaceholder}}. The second list does not appear when the role is Owner or AI admin.

When you change both the role and the custom role, they are saved together. If either is refused, neither changes: the red message gives the reason, and the row shows what the member holds.

If the member carries a custom role and you choose {{ui:roles.AI_ADMIN}}, a note says that role cannot carry a custom role and **{{ui:admin.members.save}}** is greyed out. Remove the custom role and save first, then change the role. An Owner or AI admin who was given a custom role before that rule applied shows a note and a **{{ui:admin.members.removeCustomRole}}** button. Click it to restore the full built-in role.

### Set a member's line of defence

Owners only. In the {{ui:admin.members.colLineOfDefence}} column, choose the line the member works in. Broadly, the first line runs the business and its controls, the second line oversees risk and compliance, and the third line is internal audit. The change saves at once, and a message confirms it. Choose {{ui:admin.members.lineOfDefence.UNDECLARED}} to clear it.

Inflect's auditor-agent features read this value. The person who owns an auditor agent must be on the second line, and the auditor's workpapers are reviewed by third-line members. {{ui:admin.members.lineOfDefence.UNDECLARED}} counts as no line at all.

You cannot set your own line; another Owner sets it. If the member owns an auditor agent and the change leaves that agent without an independent owner, the change still goes through, and the confirmation says how many findings were raised.

### Sign a member out of a device

Click the number in the member's {{ui:admin.members.colSessions}} column, or **{{ui:admin.members.viewSessions}}** in the row's menu. Click **{{ui:admin.members.revoke}}** beside the device, then confirm. The device is signed out on its next request, and the entry leaves the list.

Only an Owner can revoke an Owner's or an AI admin's sessions. Anyone else sees their sessions without a **{{ui:admin.members.revoke}}** button, and the dialog reads {{ui:admin.members.sessionsOwnerOnly}}

Revoking a session does not stop the member signing in again. To end their access, deactivate them.

### Deactivate or remove members

Choose **{{ui:admin.members.deactivate}}** or **{{ui:admin.members.remove}}** in the row's menu, then confirm. For several members, tick their rows, choose the action from **{{ui:common.table.chooseAction}}**, click **{{ui:common.table.apply}}**, then confirm. Members that cannot be changed are listed in the red message with the reason, and the others go ahead.

Deactivating keeps the member's row, marked **DEACTIVATED**. Removing takes the row off the page. An Admin is not offered either action on an Owner's or an AI admin's row, and nobody is offered them on their own row. When you deactivate several members at once, the confirmation says they lose access and keep their records.

## What happens next

- Every invite, revoked invite, role change, custom-role change, line-of-defence change, deactivation, removal and revoked session is recorded in the workspace's audit log, naming who made it. Open it from **{{ui:admin.auditLog}}** on the {{ui:admin.title}} page.
- An invite lasts 7 days and works once. When your colleague accepts it, they appear in the members table as **ACTIVE** with the invite's role.
- A deactivated member loses access the next time they open a page or take an action. To let them back in, invite them again. They return with the role you choose in the invite, and with any custom role they carried before. That custom role, not the invite's role, then decides what they can do. If they were an Admin carrying a custom role only an Admin member can carry, invite them as an Admin, or the invite is refused.
- A removed member's Inflect account is not deleted, only their place in this workspace. To bring them back, invite them again.
- Deactivating or removing a member does not revoke the API keys they created. A key of theirs that is bound to an agent stops working. Their other keys keep working until someone revokes them on the {{ui:admin.nav.apiKeys}} page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.members.failedLoadMembers}}** in place of the members table, with the reason below it | The member list did not load | Click **{{ui:common.error.tryAgain}}**, or reload the page |
| **Cannot demote the last OWNER. Promote another OWNER first.**, **Cannot deactivate the last OWNER.** or **Cannot remove the last OWNER. Promote another OWNER first.** | This member is the workspace's only active Owner | Keep them as an active Owner |
| **Cannot remove the last admin. Promote another member first.** or **Cannot deactivate the last admin.** | This member is the workspace's only Admin | Make another member an Admin first |
| **Cannot demote yourself. Ask another admin to change your role.**, **Cannot deactivate your own membership. Ask another admin.** or **Cannot remove your own membership. Ask another admin.** | You changed your own role, or ticked your own row among several members | Ask another Owner or Admin |
| **Only OWNERs can deactivate an OWNER membership.**, **Only OWNERs can remove an OWNER membership.**, **Only an OWNER can deactivate an AI_ADMIN membership.** or **Only an OWNER can remove an AI_ADMIN membership.** | You ticked an Owner or an AI admin among several members | Ask an Owner |
| A message that starts **Cannot grant permissions you do not hold** | The custom role grants permissions you do not have | Ask someone who holds those permissions to assign it |
| A message that the custom role can only be carried by an Admin membership | The custom role is built on Admin, or grants a permission only an Admin member can use, and the member is not, or would no longer be, an Admin | Choose another custom role, or keep the member an Admin. To move them off Admin, change or remove the custom role first |
| **User is already a member of this tenant** | That address belongs to an active member | Change their role in the members table instead |
| A message starting **Too many requests** after an invite | You tried to send more than 20 invites for this workspace from your network within an hour | Wait for the time the message gives |
| **{{ui:admin.members.roleChangeFailed}}**, **{{ui:admin.members.deactivationFailed}}**, **{{ui:admin.members.removalFailed}}** or **{{ui:admin.members.inviteFailed}}** | The change did not go through | Reload the page and try again |
| **{{ui:admin.members.lineOfDefenceFailed}}** | The line of defence was not saved | Reload the page and try again |
| **{{ui:admin.members.noActiveSessionsTitle}}** in the sessions dialog | The member is not signed in on any device | Nothing to revoke |
| **{{ui:admin.members.failedLoadSessions}}** | The sessions dialog could not load | Close it and open it again |

The how-to [Change a member's role](../../how-to/set-up/change-a-members-role.md) lists more of the messages the role editor can show.

## Related

- [Invite a colleague](../../how-to/set-up/invite-a-colleague.md), step by step, including what your colleague sees.
- [Change a member's role](../../how-to/set-up/change-a-members-role.md), which also covers deactivating and removing members.
- [{{ui:admin.apiKeys.pageTitle}}](api-keys.md), for the keys members have created.
- Custom roles are created on the **{{ui:admin.nav.roles}}** page, under {{ui:admin.section.people}} on the {{ui:admin.title}} page.
