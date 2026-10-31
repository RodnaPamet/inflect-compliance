---
route: /tenants
---

# {{ui:tenants.chooseWorkspace}}

The {{ui:tenants.chooseWorkspace}} page lists the workspaces you belong to, so you can pick the one to open. It only appears when you belong to more than one.

## Where to find it

You arrive here after signing in, when you belong to several workspaces. **{{ui:account.backToWorkspaces}}** on your profile and account security pages also brings you here.

## Who can use it

Everyone who is signed in.

## What it is for

Choose which workspace to work in. Each workspace is a separate organisation's compliance programme, with its own members, records and settings, and your role can differ from one to the next.

## What you see

**{{ui:tenants.chooseWorkspace}}** and {{ui:tenants.multipleWorkspaces}} Then one row per workspace, oldest membership first, showing the workspace's short name, the one in its address, and your role in it. **{{ui:tenants.signOut}}** is at the bottom.

## What you can do

### Open a workspace

Click its row. Its dashboard opens.

To move to another workspace later, use the workspace switcher at the top of any page instead of coming back here.

### Sign out

Click **{{ui:tenants.signOut}}**. You go back to the sign-in page.

## What happens next

- With exactly one workspace, you never see this page: you go straight to that workspace's dashboard.
- With none, you see **{{ui:noTenant.title}}** instead.
- If you signed in with your organisation's single sign-on, you see only the workspace you signed in to, even if you belong to others. Sign in another way to reach those.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:noTenant.title}}** | You belong to no active workspace: you have not accepted an invitation yet, or your membership has been deactivated or removed | Ask a workspace administrator to invite you, then follow the link in the invitation email |
| A workspace you expected is missing | Your membership there is deactivated or removed, the workspace has been deleted, or you signed in with another workspace's single sign-on | Ask that workspace's administrator, or sign in another way |

## Related

- [{{ui:login.signIn}}](sign-in.md), how you get here.
- [{{ui:invite.invitedTitle}}](accept-an-invite.md), to join another workspace.
- [{{ui:account.profile.profileTitle}}](profile.md), your own name and photo, shared by every workspace.
