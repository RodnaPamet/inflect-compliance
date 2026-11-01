---
route: /t/[tenantSlug]/admin/integrations/sharepoint-health
---

# {{ui:admin.sharepoint.healthTitle}}

The {{ui:admin.sharepoint.healthTitle}} page shows whether the workspace's SharePoint connection is still bringing documents in: the result of its last test, how many imported documents are in step with SharePoint, and its recent sync runs.

## Where to find it

On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.sharepoint.syncHealth}}** on the {{ui:admin.sharepoint.title}} card. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}** › **{{ui:admin.crumb.sharepointHealth}}**, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. The page only reports; SharePoint is connected, tested and disconnected on the [{{ui:admin.integrations.title}}](integrations.md) page.

## What it is for

Evidence and policies imported from SharePoint keep a link to their file there. When a file changes or disappears in SharePoint, the copy in Inflect can fall behind. This page tells you whether that is happening before an auditor finds an evidence item whose source has gone.

## What you see

**The connection.** A card with the SharePoint connection's name, its state and when it was last tested:

- **{{ui:admin.sharepoint.connectionState.ok}}**: its last test passed;
- **{{ui:admin.sharepoint.connectionState.error}}**: its last test failed;
- **{{ui:admin.sharepoint.connectionState.never}}**: it has never been tested;
- **{{ui:admin.sharepoint.connectionState.disabled}}**: it is switched off, and runs nothing.

**Four figures**, each counting every imported document, however many there are:

| Figure | What it counts |
| --- | --- |
| {{ui:admin.sharepoint.evidenceSynced}} | Imported documents still in step with SharePoint |
| {{ui:admin.sharepoint.stale}} | {{ui:admin.sharepoint.staleHint}} |
| {{ui:admin.sharepoint.failedKpi}} | {{ui:admin.sharepoint.failedHint}} |
| {{ui:admin.sharepoint.policyLinks}} | Policies linked to a SharePoint file |

**{{ui:admin.sharepoint.problemsTitle}}.** When any document is stale or failed, a list names them: each one's evidence item, linked so you can open it, whether it is stale or failed, the error for a failure, and when it was last synced. A file with no evidence item reads **{{ui:admin.sharepoint.problemNoEvidence}}**. Failures come first, and when there are more than the list shows, it says how many it shows of how many.

**{{ui:admin.sharepoint.recentActivity}}.** The connection's recent sync runs, newest first: what ran, how it ended (**{{ui:admin.sharepoint.runStatus.PASSED}}**, **{{ui:admin.sharepoint.runStatus.FAILED}}**, **{{ui:admin.sharepoint.runStatus.PARTIAL}}** and so on), what started it (**{{ui:admin.sharepoint.trigger.manual}}**, **{{ui:admin.sharepoint.trigger.scheduled}}** or **{{ui:admin.sharepoint.trigger.webhook}}**) and when.

## What you can do

The page only reports. To act on what it shows:

- **The connection reads {{ui:admin.sharepoint.connectionState.error}} or {{ui:admin.sharepoint.connectionState.never}}.** On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.sharepoint.test}}** on the SharePoint card to see why. If the consent has lapsed, disconnect SharePoint and connect it again.
- **The connection reads {{ui:admin.sharepoint.connectionState.disabled}}.** Switch it back on from the [{{ui:admin.integrations.title}}](integrations.md) page if documents should keep syncing.
- **Documents are stale.** Their files were deleted or moved in SharePoint. Open each evidence item from the list and replace or retire it.
- **Documents failed.** Test the connection and check that Inflect may still read the sites they came from under **{{ui:admin.sharepoint.sites}}**. The next sync tries them again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.sharepoint.notConnected}}** | No SharePoint connection is set up | Connect it on the [{{ui:admin.integrations.title}}](integrations.md) page |
| **{{ui:admin.sharepoint.activityEmpty}}** | The connection has not run yet | Wait for the next sync, or run one from the [{{ui:admin.integrations.title}}](integrations.md) page |
| **{{ui:admin.sharepoint.healthLoadError}}**, or the server's reason | The page could not load its figures | Reload the page |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.integrations.title}}](integrations.md), where SharePoint is connected and its sites are chosen.
