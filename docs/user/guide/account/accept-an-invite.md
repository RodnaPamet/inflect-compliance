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

The invitation is accepted as you sign in, and the workspace is added to your workspaces. See [{{ui:login.signIn}}](sign-in.md).

If you sign in with Google or Microsoft using the invited email address, any invitation waiting for that address is accepted as you sign in, even without clicking the link.

## What happens next

- The workspace appears in your list of workspaces, with the role the invitation named. If it is your only workspace, signing in takes you straight to its dashboard.
- The invitation is used up. If you need it again, ask the person who invited you to send a new one.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:invite.notAvailableTitle}}** | {{ui:invite.notAvailableBody}} | Ask the workspace's administrator to send a new invitation |
| A line naming the address you are signed in with | You are signed in with a different email address from the one invited | Sign out, then sign in with the invited address |
| A reason the invitation could not be accepted, such as an invitation that has expired or was sent to another address | The invitation was not accepted | Follow the reason given, or ask for a new invitation. The reason is in English, whatever language you use the app in |
| **{{ui:invite.acceptFailed}}** | The invitation was not accepted, and the server gave no reason | Try again |
| You signed in, but the workspace is not in your list | The invitation could not be accepted as you signed in, for example because you signed in with a different email address | Open the invitation link again and follow what it shows |

## Related

- [{{ui:login.signIn}}](sign-in.md), to sign in or create an account.
- [Choose a workspace](workspaces.md), where you go after signing in if you belong to several workspaces.
- [Invite a colleague](../../how-to/set-up/invite-a-colleague.md), how invitations are sent.
