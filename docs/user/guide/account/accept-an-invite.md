---
route: /invite/[token]
---

# {{ui:invite.invitedTitle}}

The invitation page is where you accept an invitation to join a workspace. It opens from the link in an invitation email and shows which workspace you are invited to and the role you will have there.

## Where to find it

Click the link in your invitation email. The page works whether or not you are signed in.

## Who can use it

The person the invitation was sent to. An invitation is tied to one email address: you can only accept it while signed in with that address.

## What it is for

Join a workspace a colleague has invited you to. An invitation lasts seven days and can be used once.

## What you see

**{{ui:invite.invitedTitle}}**, the name of the workspace, the role you are invited with, and the date the invitation expires. Below that, one button:

- **{{ui:invite.acceptInvitation}}**, when you are signed in with the invited email address.
- **{{ui:invite.signInToAccept}}**, otherwise.

If you are signed in with a different address, a line under the button names the address you are signed in with and asks you to sign in with the right one.

## What you can do

### Accept while signed in

Click **{{ui:invite.acceptInvitation}}**. You are taken straight into the workspace's dashboard.

### Sign in to accept

1. Click **{{ui:invite.signInToAccept}}**. You go to the sign-in page.
2. Within ten minutes, sign in with the email address the invitation was sent to: with Google, Microsoft, or your email and password.

The invitation is accepted as you sign in. You are then taken to one of three places:

- **The workspace's dashboard**, when the invitation was accepted.
- **This invitation page again**, when the invitation is still waiting. Click **{{ui:invite.acceptInvitation}}** there.
- **{{ui:invite.result.title}}**, when it could not be accepted. The page says why, names the address you signed in with, and offers **{{ui:invite.result.toWorkspaces}}**.

See [{{ui:login.signIn}}](sign-in.md).

If you sign in with Google or Microsoft using the invited email address, any invitation waiting for that address is accepted as you sign in, even without clicking the link.

## What happens next

- The workspace appears in your list of workspaces, with the role the invitation named. If it is your only workspace, signing in takes you straight to its dashboard.
- The invitation is used up. If you need it again, ask the person who invited you to send a new one.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:invite.notAvailableTitle}}** | {{ui:invite.notAvailableBody}} | Ask the workspace's administrator to send a new invitation |
| A line naming the address you are signed in with | You are signed in with a different email address from the one invited | Sign out, then sign in with the invited address |
| {{ui:invite.refused.INVITE_EXPIRED}} | The invitation is more than seven days old | Ask the workspace's administrator to send a new invitation |
| {{ui:invite.refused.INVITE_REVOKED}} | An administrator withdrew it | Ask for a new invitation |
| {{ui:invite.refused.INVITE_ALREADY_REDEEMED}} | Somebody already used this link | Ask for a new invitation if it was not you |
| {{ui:invite.refused.INVITE_EMAIL_MISMATCH}} | You signed in with a different address from the one invited, so the invitation can no longer be used | Ask for a new invitation to the address you sign in with |
| **{{ui:invite.acceptFailed}}** | The invitation was not accepted, and the server gave no reason | Try again |
| **{{ui:invite.result.title}}** after signing in | The invitation could not be accepted as you signed in. The page gives the reason | Follow the reason given |

## Related

- [{{ui:login.signIn}}](sign-in.md), to sign in or create an account.
- [Choose a workspace](workspaces.md), where you go after signing in if you belong to several workspaces.
- [Invite a colleague](../../how-to/set-up/invite-a-colleague.md), how invitations are sent.
