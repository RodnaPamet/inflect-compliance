---
route: /tenants
---

# {{ui:tenants.chooseWorkspace}}

The {{ui:tenants.chooseWorkspace}} page lists the workspaces and organizations you belong to, so you can pick the one to open. It only appears when there is more than one to choose from.

## Where to find it

You arrive here after signing in, when you belong to several workspaces, or to no workspace and several organizations. **{{ui:account.backToWorkspaces}}** on your profile and account security pages also brings you here.

## Who can use it

Everyone who is signed in.

## What it is for

Choose which workspace to work in. Each workspace is a separate organisation's compliance programme, with its own members, records and settings, and your role can differ from one to the next.

## What you see

**{{ui:tenants.chooseWorkspace}}** and {{ui:tenants.multipleWorkspaces}} Then one row per workspace, oldest membership first, showing the workspace's name and your role in it.

If you also belong to an organization, the workspaces are listed under **{{ui:tenants.workspacesHeading}}**, and your organizations follow under **{{ui:tenants.organizationsHeading}}**. If you belong to no workspace, only the organizations are listed, under **{{ui:tenants.chooseOrganization}}**.

**{{ui:tenants.signOut}}** is at the bottom.

## What you can do

### Open a workspace

Click its row. Its dashboard opens. Clicking an organization's row opens that organization's pages.

To move to another workspace later, use the workspace switcher at the top of any page instead of coming back here.

### Sign out

Click **{{ui:tenants.signOut}}**. You go back to the sign-in page.

## What happens next

- With exactly one workspace, you never see this page: you go straight to that workspace's dashboard.
- With no workspace and one organization, you go straight to that organization.
- With neither, you see **{{ui:noTenant.title}}** instead.
- If you signed in with your organisation's single sign-on, you see only the workspace you signed in to, and no organization, even if you belong to others. Sign in another way to reach those.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:noTenant.title}}** with {{ui:noTenant.helpText}} | You belong to no workspace yet | Ask a workspace administrator to invite you, then follow the link in the invitation email |
| **{{ui:noTenant.title}}**, naming a workspace where your access was deactivated | Your membership there is deactivated | Ask an administrator of that workspace to reactivate you |
| **{{ui:noTenant.title}}** with {{ui:noTenant.organizationsOnly}} | You belong to an organization but to none of its workspaces | Open the organization from the link below the message |
| **{{ui:noTenant.title}}** with {{ui:noTenant.otherWorkspaceText}} | You opened a link to a workspace you do not belong to | Click **{{ui:noTenant.goToWorkspaces}}** |
| A workspace you expected is missing | Your membership there is deactivated or removed, the workspace has been deleted, or you signed in with another workspace's single sign-on | Ask that workspace's administrator, or sign in another way |

## Related

- [{{ui:login.signIn}}](sign-in.md), how you get here.
- [{{ui:invite.invitedTitle}}](accept-an-invite.md), to join another workspace.
- [{{ui:account.profile.profileTitle}}](profile.md), your own name and photo, shared by every workspace.
