---
route: /invite/result
---

# {{ui:invite.result.title}}

After you sign in to accept an invitation, this page tells you what became of it. You only see it when the invitation could not be used. When it worked, you go straight into the workspace; when it is still waiting for you, you go back to the invitation page to accept it.

## Where to find it

You do not open this page yourself. It is where **Sign in to accept** on an [invitation](accept-an-invite.md) brings you once you have signed in.

## Who can use it

Anyone who has just signed in from an invitation. If you are not signed in, you are sent to sign in first. If you reach the address without coming from an invitation, you are sent to your workspaces.

## What you see

The heading **{{ui:invite.result.title}}**, the reason, and the email address you are signed in with, so you can see whether it is the one the invitation was sent to.

| Reason | What it means |
| --- | --- |
| {{ui:invite.refused.INVITE_NOT_FOUND}} | The link does not match any invitation |
| {{ui:invite.refused.INVITE_REVOKED}} | An admin withdrew it |
| {{ui:invite.refused.INVITE_EXPIRED}} | Invitations last seven days |
| {{ui:invite.refused.INVITE_ALREADY_REDEEMED}} | Someone has already used it |
| {{ui:invite.refused.INVITE_EMAIL_MISMATCH}} | You signed in with a different address, and the invitation can no longer be used |
| {{ui:invite.refused.INVITE_NOT_COMPLETED}} | Joining the workspace did not finish |

## What you can do

Click **{{ui:invite.result.toWorkspaces}}** to see the workspaces you already belong to. To join the workspace you were invited to, ask its admin for a new invitation, sent to the address you sign in with.

## Related

- [Accept an invitation](accept-an-invite.md), the page the invitation link opens.
- [Workspaces](workspaces.md), the workspaces you belong to.
