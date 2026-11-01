---
route: /org/[orgSlug]/tenants
---

# {{ui:org.tenants.title}}

The {{ui:org.tenants.title}} page lists every workspace in the organization, one row each, with its health, coverage, risks and overdue evidence from its latest snapshot. Owners also create and remove workspaces here.

## Where to find it

Open the organization (see [{{ui:org.dashboard.title}}](portfolio-overview.md)). In the sidebar, under {{ui:org.nav.portfolio}}, click **{{ui:org.nav.allTenants}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see every workspace | Owner, Admin, Reader |
| Open a workspace from its row | Anyone who belongs to that workspace. Owners and Admins of the organization are given Admin access to every workspace in it |
| Create a workspace | Owner |
| Remove a workspace | Owner |

## What you see

A table, one row per workspace:

| Column | What it shows |
| --- | --- |
| {{ui:org.tenants.colTenant}} | The workspace's name. Click it to open the workspace's dashboard |
| {{ui:org.tenants.colHealth}} | Green, amber or red, worked out from the latest snapshot (see [{{ui:org.dashboard.title}}](portfolio-overview.md)), or **{{ui:org.common.pending}}** before the first one |
| {{ui:org.tenants.colCoverage}} | The share of the workspace's applicable controls that are implemented |
| {{ui:org.tenants.colOpenRisks}} | Risks still open, not closed |
| {{ui:org.tenants.colCritical}} | Open risks scoring 15 or more |
| {{ui:org.tenants.colOverdueEvidence}} | Evidence past its review date |
| {{ui:org.tenants.colLatestSnapshot}} | The date of the snapshot these figures come from. Snapshots are taken once a day, at 05:00 UTC |

Click a column heading to sort by it. An Owner also sees a **{{ui:org.common.remove}}** button on each row, and **{{ui:org.tenants.newTenant}}** in the header.

## What you can do

### Create a workspace

Click **{{ui:org.tenants.newTenant}}**. See [{{ui:org.newTenant.title}}](new-workspace.md).

### Remove a workspace

1. Click **{{ui:org.common.remove}}** on its row. The **{{ui:org.tenants.removeTitle}}** dialog opens.
2. Type the workspace's address name (its slug), exactly as the dialog shows it.
3. Click **{{ui:org.tenants.deleteTenant}}**.

The workspace disappears from the organization at once. Everyone's access to it ends, including anyone signed in at that moment, and the removal is recorded in the organization's [{{ui:org.nav.auditLog}}](audit-log.md).

Nothing in the product brings a removed workspace back. Its data is kept for 90 days and then deleted, apart from the regulatory records Inflect keeps for good, such as its audit trail.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.tenants.emptyTitle}}** | The organization has no workspaces | An Owner creates one |
| **{{ui:org.common.pending}}** in the health column | The workspace has no snapshot yet | Wait for the next daily snapshot |
| A red message in the remove dialog | The workspace was not removed | Read the reason, and try again |

## Related

- [{{ui:org.newTenant.title}}](new-workspace.md), to create a workspace.
- [{{ui:org.dashboard.title}}](portfolio-overview.md), the same figures rolled up for the whole organization.
