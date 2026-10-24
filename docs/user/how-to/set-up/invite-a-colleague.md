# Invite a colleague

Invite a colleague when they need their own access to this workspace. You choose their role, and they join by signing in with the email address you invited.

## Before you start

- You need the Owner or Admin role. With a custom role, what you can do depends on the permissions your role was given.
- Have your colleague's email address ready, the one they sign in to Inflect with. The invite works only for that address.
- Decide which role they need. You can invite someone as an Admin, Editor, Auditor or Reader.
- You cannot invite someone straight in as an Owner or an AI admin. An Owner can make a member an AI admin once they have joined.
- You can invite someone whose membership was deactivated. Accepting the invite makes them an active member again.

## Steps

1. Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens.
2. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.members}}**.
3. Click **{{ui:admin.members.inviteMember}}**. The {{ui:admin.members.inviteFormTitle}} form appears at the top of the page.
4. In {{ui:admin.members.emailLabel}}, type your colleague's email address.
5. In {{ui:admin.members.roleLabel}}, choose **{{ui:roles.ADMIN}}**, **{{ui:roles.EDITOR}}**, **{{ui:roles.AUDITOR}}** or **{{ui:roles.READER}}**. The form starts on {{ui:roles.READER}}.
6. Click **{{ui:admin.members.sendInvite}}**.
7. A message confirms the invite and shows the invite link. Click the link to copy it.
8. Send the link to your colleague, for example by chat or email. Copy it before you close the message, because the page does not show it again.

## What happens next

- The invite appears under {{ui:admin.members.pendingInvitationsTitle}}, with its role, who sent it and its {{ui:admin.members.colExpires}} date.
- Your colleague opens the link. The page reads {{ui:invite.invitedTitle}} and names the workspace, the role and the expiry date.
- They click **{{ui:invite.signInToAccept}}** and sign in with the address you invited. If they are already signed in with it, they click **{{ui:invite.acceptInvitation}}** instead.
- If they sign in with **{{ui:login.continueWithGoogle}}** or **{{ui:login.continueWithMicrosoft}}** using the invited address, they join even without the link. Signing in with an email address and password needs the link.
- Once they have signed in, they are a member with the role you chose. They appear in the members list as **ACTIVE**, and the invite leaves {{ui:admin.members.pendingInvitationsTitle}}.
- An invite lasts 7 days and works once. When it expires, it leaves the list.
- Inviting the same address again replaces the earlier invite. The old link stops working, and the 7 days start again.
- To cancel an invite, tick it under {{ui:admin.members.pendingInvitationsTitle}}. Choose **{{ui:admin.members.revokeInviteAction}}** from **{{ui:common.table.chooseAction}}**, click **{{ui:common.table.apply}}** beside it, then confirm. The link stops working at once.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **User is already a member of this tenant** | That address belongs to an active member of this workspace | There is nothing to invite. To change their access, change their role in the members list |
| **Invalid request payload** | The email address is not valid | Correct the address and click **{{ui:admin.members.sendInvite}}** again |
| Your colleague sees {{ui:invite.notAvailableTitle}} when they open the link | The invite expired, was revoked or was already used, or a newer invite to the same address replaced it | Send a new invite and share the new link |
| Your colleague signs in but cannot reach the workspace, and the invite has gone from {{ui:admin.members.pendingInvitationsTitle}} | They used the link but signed in with a different address. That uses up the invite | Ask which address they sign in with, and invite that address |
| Your colleague signs in but cannot reach the workspace, and the invite is still listed | They signed in with a different address. Or they used an email address and password, either without the link or over 10 minutes after clicking **{{ui:invite.signInToAccept}}** | Ask them to open the link again and accept the invite, signed in with the invited address |
