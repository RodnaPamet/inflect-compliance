---
route: /t/[tenantSlug]/framework-updates
---

# {{ui:frameworkUpdates.title}}

The {{ui:frameworkUpdates.title}} page tells you when a framework you use publishes a new version, and what the change means for your workspace. {{ui:frameworkUpdates.description}}

## Where to find it

Click the notification that announces the update, in the bell at the top of any page. Every active member of a workspace that uses the framework gets one. The breadcrumb reads **{{ui:frameworkUpdates.crumbDashboard}}** › **{{ui:frameworkUpdates.crumbTitle}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the updates | Every role |
| Dismiss an update, mark it reviewed, or create findings from it | Owner, Admin, Editor |

## What it is for

Keep up with a standard as it changes. When a new version adds requirements, you have gaps you did not have before; when it rewords requirements, the controls mapped to them may need another look.

## What you see

One card per update, newest first, with:

- its status, **NEW**, **REVIEWED** or **DISMISSED**;
- the framework and the two versions, and when the update arrived;
- **{{ui:frameworkUpdates.impactLabel}}** how many requirements are new for you, and how many of your controls were flagged for re-review;
- the codes of the requirements added, changed and removed.

## What you can do

### Create findings for the new requirements

Click **{{ui:frameworkUpdates.createFindings}}** on an update with new requirements. One finding is created for each new requirement, saying it has no mapped control. Running it again creates no duplicates.

### Close the update

Click **{{ui:frameworkUpdates.markReviewed}}** once you have dealt with it, or **{{ui:frameworkUpdates.dismiss}}** if it does not concern you. The buttons are offered only while the update is new.

## What happens next

- When the update arrived, each control mapped to a changed requirement that was implemented or being implemented was set to need review. Filter the [{{ui:controls.list.pageTitle}}](controls.md) page to **{{ui:controls.statusLabels.NEEDS_REVIEW}}** to find them.
- Map a control to each new requirement on the framework's page to close the gap. See [A framework](framework-detail.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworkUpdates.emptyTitle}}** | {{ui:frameworkUpdates.emptyDescription}} | Nothing to do |
| A message in red above the updates | The action was refused or failed | Follow what it says, then try again |

## Related

- [A framework](framework-detail.md), where you map the new requirements.
- [{{ui:frameworks.list.heading}}](frameworks.md).
- [Findings](../comply/findings.md), where the new findings appear.
