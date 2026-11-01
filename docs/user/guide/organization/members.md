---
route: /org/[orgSlug]/members
---

# {{ui:org.members.title}}

The {{ui:org.members.title}} page lists the people who belong to the organization itself, with their organization role. Owners and Admins use it to invite people, add them directly, change their role and remove them.

Belonging to the organization is separate from belonging to a workspace inside it. Each workspace keeps its own members on its own [{{ui:admin.members.title}}](../admin/members.md) page.

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.manage}}, click **{{ui:org.nav.members}}**. The item appears only for Owners and Admins.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see the members and pending invitations | Owner, Admin |
| Invite someone, or add them directly, as an Admin or a Reader | Owner, Admin |
| Change the role of an Admin or a Reader | Owner, Admin |
| Make someone an Owner, or change or remove an Owner | Owner |
| Remove an Admin or a Reader | Owner, Admin |
| Revoke a pending invitation | Owner, Admin |

Nobody can change their own role or remove themselves. An organization always keeps at least one Owner and at least one Owner or Admin. A Reader who opens the page's address gets an error page instead.

## What it is for

The organization role decides what someone sees above the workspaces, and it reaches into them:

- **{{ui:orgRoles.ORG_OWNER}}s and {{ui:orgRoles.ORG_ADMIN}}s** are given Admin access to every workspace in the organization, now and when new workspaces are created. That access is taken away again when they are demoted to Reader or removed. Access someone was given inside a workspace by other means is left alone.
- **{{ui:orgRoles.ORG_READER}}s** see the portfolio summary only, and get no access to any workspace from their organization role.

## What you see

**The members table.**

| Column | What it shows |
| --- | --- |
| {{ui:org.members.colMember}} | Their name and email |
| {{ui:org.members.colRole}} | **{{ui:org.members.roleOrgOwner}}**, **{{ui:org.members.roleOrgAdmin}}** or **{{ui:org.members.roleOrgReader}}** |
| {{ui:org.members.colJoined}} | When they joined the organization |

Each row has **{{ui:org.members.changeRole}}** and **{{ui:org.common.remove}}** buttons. They are greyed out on your own row, and on an Owner's row unless you are an Owner; hovering says why.

**{{ui:org.members.pendingInvitations}}.** Invitations nobody has accepted: the email, the role offered, who sent it and when it expires, with a **{{ui:org.members.revoke}}** button.

## What you can do

### Invite someone by email

1. Click **{{ui:org.members.inviteByEmail}}**.
2. Enter their email and choose **{{ui:org.members.roleOrgReader}}** or **{{ui:org.members.roleOrgAdmin}}**.
3. Click **{{ui:org.members.sendInvite}}**.

Inflect emails them a link that works once and expires in 7 days. The dialog also shows the link, so you can copy it and send it another way; it is shown only this once. If the email could not be sent, the dialog says so and the link is the only way to reach them. They join when they open the link and accept (see [the invitation page](invitation.md)).

### Add someone directly

Click **{{ui:org.members.addMember}}**, enter their email, choose a role and confirm. They join straight away, without accepting anything. If they have never signed in to Inflect, an account is set up for that email, ready for when they do.

### Change someone's role

Click **{{ui:org.members.changeRole}}** on their row, choose the new role and click **{{ui:org.members.saveRole}}**. The dialog warns you when the change gives or takes away Admin access to every workspace.

### Remove someone

Click **{{ui:org.common.remove}}** on their row and confirm. They leave the organization, and the Admin access their organization role gave them in each workspace is removed.

### Revoke an invitation

Click **{{ui:org.members.revoke}}** on the invitation. Its link stops working at once.

Every addition, removal, role change and invitation is recorded in the organization's [{{ui:org.nav.auditLog}}](audit-log.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.members.emptyTitle}}** | Nobody belongs to the organization yet | Invite or add someone |
| **{{ui:org.members.invalidEmail}}** | The email address is not valid | Correct it |
| A red message in a dialog | The change was refused, for example because the person is already a member, or because it would leave the organization without an Owner | Read the reason; for the last Owner, make someone else an Owner first |
| **{{ui:org.members.ownerNeedsOwner}}** | You are an Admin and the row is an Owner's | Ask an Owner |

## Related

- [{{ui:org.nav.auditLog}}](audit-log.md), the record of every membership change.
- [The invitation page](invitation.md), what the person you invite sees.
