---
route: /no-tenant
---

# {{ui:noTenant.title}}

The **{{ui:noTenant.title}}** page appears when you are signed in but cannot open a workspace. It says why, as far as the product can tell, and where you can go instead.

## Where to find it

You do not open this page yourself. You land here after signing in when you have no active workspace, or when you open the address of a workspace you do not belong to.

## Who can use it

Anyone who is signed in. If you are not signed in, you are sent to sign in.

## What you see

The heading, the email address you are signed in with, and one explanation:

| What it says | What it means |
| --- | --- |
| {{ui:noTenant.otherWorkspaceText}} | You belong to other workspaces, but not the one in the address you opened |
| That Microsoft Entra ID did not admit this sign-in to a named workspace | The workspace lets in only some Entra groups or sign-in domains, and your account is not in them |
| {{ui:noTenant.organizationsOnly}} | You are in an organization but in none of its workspaces |
| That your access to a named workspace was deactivated | An admin deactivated your membership there |
| {{ui:noTenant.helpText}} | You belong to no workspace at all |

Below it, links to where you can go: **{{ui:noTenant.goToWorkspaces}}** when you have other workspaces, and one link per organization you belong to.

## What you can do

- Click **{{ui:noTenant.goToWorkspaces}}**, or an organization, to go somewhere you do have access.
- Click **{{ui:noTenant.signOut}}** to sign in with a different account, for example the address an invitation was sent to.

To get into a workspace, ask one of its admins to invite you, to reactivate your membership, or, for Entra, to check its group mappings and allowed domains.

## Related

- [Workspaces](workspaces.md), the workspaces you belong to.
- [Accept an invitation](accept-an-invite.md), how to join a workspace.
