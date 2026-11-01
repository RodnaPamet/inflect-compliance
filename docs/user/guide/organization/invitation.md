---
route: /invite/org/[token]
---

# {{ui:invite.invitedTitle}}

The organization invitation page is what someone sees when they open the link in an invitation to join an organization. It names the organization and the role offered, and lets them accept.

## Where to find it

Open the link in the invitation email, or the link the person who invited you sent another way. An Owner or Admin creates it on the organization's [{{ui:org.nav.members}}](members.md) page.

## Who can use it

Anyone with the link can open the page. Only the person it was sent to can accept it: the email address they are signed in with must be the one the invitation was sent to.

## What you see

**The invitation.** The organization's name, the role offered ({{ui:orgRoles.ORG_OWNER}}, {{ui:orgRoles.ORG_ADMIN}} or {{ui:orgRoles.ORG_READER}}) and the date the link expires.

**One button**, which depends on whether you are signed in:

| You are | The button |
| --- | --- |
| Not signed in | **{{ui:invite.signInToAccept}}** takes you to sign in. Signing in with the invited email accepts the invitation |
| Signed in with the invited email | **{{ui:invite.acceptInvitation}}** |
| Signed in with a different email | **{{ui:invite.switchAccount}}**, with a note naming the account you are signed in with |

## What you can do

Click **{{ui:invite.acceptInvitation}}**. You join the organization with the role offered and go to its [{{ui:org.dashboard.title}}](portfolio-overview.md). As an Admin or Owner, you are also given Admin access to every workspace in it.

If you are signed in with the wrong account, click **{{ui:invite.switchAccount}}**. You are signed out and brought back to the invitation; sign in with the address it was sent to. Signing in again with any other address uses up the link, and you then need a new invitation.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:invite.notAvailableTitle}}** | The link has expired, been revoked or already been used | Ask for a new invitation |
| **{{ui:invite.orgRefused.INVITE_EXPIRED}}** | The link is more than 7 days old | Ask for a new invitation |
| **{{ui:invite.orgRefused.INVITE_REVOKED}}** | An Owner or Admin revoked it | Ask for a new invitation |
| **{{ui:invite.orgRefused.INVITE_ALREADY_REDEEMED}}** | Someone has already accepted it | If it was not you, ask for a new invitation |
| **{{ui:invite.orgRefused.INVITE_EMAIL_MISMATCH}}** | You signed in with a different address, and that used the link up | Ask for a new invitation to the address you sign in with |
| A red message above the button | Accepting did not work for another reason | Read the message; usually, ask for a new invitation |

## Related

- [{{ui:org.nav.members}}](members.md), where invitations are sent and revoked.
