---
route: /t/[tenantSlug]/admin/integrations/sharepoint-health
---

# {{ui:admin.sharepoint.healthTitle}}

The {{ui:admin.sharepoint.healthTitle}} page shows whether the workspace's SharePoint connection is still bringing documents in: the result of its last test, how many imported documents are in step with SharePoint, and its recent sync runs.

## Where to find it

On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.sharepoint.syncHealth}}** on the {{ui:admin.sharepoint.title}} card. The breadcrumb reads **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}** › **{{ui:admin.crumb.sharepointHealth}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. The page only reports; SharePoint is connected, tested and disconnected on the [{{ui:admin.integrations.title}}](integrations.md) page.

## What it is for

Evidence and policies imported from SharePoint keep a link to their file there. When a file changes or disappears in SharePoint, the copy in Inflect can fall behind. This page tells you whether that is happening before an auditor finds an evidence item whose source has gone.

## What you see

**The connection.** A card with the SharePoint connection's name, **{{ui:admin.sharepoint.ok}}** or **{{ui:admin.sharepoint.statusError}}** from its last test, and when that test ran.

**Four figures:**

| Figure | What it counts |
| --- | --- |
| {{ui:admin.sharepoint.evidenceSynced}} | Imported documents still in step with SharePoint |
| {{ui:admin.sharepoint.stale}} | Imported documents whose file was deleted in SharePoint since |
| {{ui:admin.sharepoint.failedKpi}} | Documents that could not be imported or refreshed |
| {{ui:admin.sharepoint.policyLinks}} | Policies linked to a SharePoint file |

**{{ui:admin.sharepoint.recentActivity}}.** The connection's recent sync runs, newest first: what ran, how it ended, what started it and when.

## What you can do

The page only reports. To act on what it shows:

- **The connection reads {{ui:admin.sharepoint.statusError}}.** On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.sharepoint.test}}** on the SharePoint card to see why. If the consent has lapsed, disconnect SharePoint and connect it again.
- **Documents are stale.** Their files were deleted in SharePoint. Open the evidence items and replace or retire them.
- **Documents failed.** Test the connection, check that Inflect may still read the sites they came from under **{{ui:admin.sharepoint.sites}}**, then import them again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.sharepoint.activityEmpty}}**, and all four figures at 0 | SharePoint is not connected, nothing has been imported yet, or the page could not load its figures | Check the {{ui:admin.sharepoint.title}} card on the [{{ui:admin.integrations.title}}](integrations.md) page, and reload this one |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.integrations.title}}](integrations.md), where SharePoint is connected and its sites are chosen.
