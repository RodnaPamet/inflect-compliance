---
route: /org/[orgSlug]/tenants/new
---

# {{ui:org.newTenant.title}}

The {{ui:org.newTenant.title}} page creates a workspace inside the organization. A workspace is where one company or team keeps its own controls, risks, evidence and policies, separate from every other workspace.

## Where to find it

On [{{ui:org.nav.allTenants}}](workspaces.md), click **{{ui:org.tenants.newTenant}}**. The button appears only for organization Owners.

## Who can use it

| Action | Roles |
| --- | --- |
| Create a workspace | Owner |

An Admin or Reader of the organization who opens the page's address gets an error page instead.

## What you see

A form with three fields:

| Field | What it is |
| --- | --- |
| {{ui:org.newTenant.nameLabel}} | The workspace's name, shown across the workspace and in its reports. Up to 120 characters. Required |
| {{ui:org.newTenant.slugLabel}} | The short name used in the workspace's web address. It fills in from the name as you type; edit it if you want something else. Lowercase letters, numbers and dashes only, not starting or ending with a dash. Required |
| {{ui:org.newTenant.startingFramework}} | The framework you want to start with: **{{ui:org.newTenant.fwChooseLater}}**, ISO/IEC 27001 or NIS2 |

## What you can do

Fill in the form and click **{{ui:org.newTenant.createTenant}}**. When the workspace is created:

- you become its Owner;
- every other Owner and Admin of the organization is given Admin access to it;
- you are taken into it: to its dashboard, or, if you chose a framework, to its frameworks page, where you install it.

Click **{{ui:org.common.cancel}}** or **{{ui:org.newTenant.backToTenants}}** to leave without creating anything.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.newTenant.nameRequired}}** or **{{ui:org.newTenant.nameTooLong}}** | The name is missing or too long | Fix the name |
| **{{ui:org.newTenant.slugRequired}}** or **{{ui:org.newTenant.slugInvalid}}** | The address name is missing or has characters it cannot have | Fix it |
| A message under the form that the slug already exists | Another workspace already uses that address name | Choose a different one |

## Related

- [{{ui:org.nav.allTenants}}](workspaces.md), where the new workspace is listed.
