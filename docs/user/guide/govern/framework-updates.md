---
route: /t/[tenantSlug]/framework-updates
---

# {{ui:frameworkUpdates.title}}

The {{ui:frameworkUpdates.title}} page tells you when a framework you use publishes a new version, and what the change means for your workspace. {{ui:frameworkUpdates.description}}

## Where to find it

Click the notification that announces the update, in the bell at the top of any page. Every active member of a workspace that uses the framework gets one. While an update waits for review, the [{{ui:frameworks.list.heading}}](frameworks.md) page also links here, above the frameworks. The breadcrumb reads **{{ui:frameworkUpdates.crumbDashboard}}** › **{{ui:frameworkUpdates.crumbTitle}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the updates | Every role |
| Dismiss an update, mark it reviewed, or create findings from it | Owner, Admin, Editor |

Every other role sees, on a new update: {{ui:frameworkUpdates.restricted}}

## What it is for

Keep up with a standard as it changes. When a new version adds requirements, you have gaps you did not have before; when it rewords requirements, the controls mapped to them may need another look.

## What you see

One card per update, newest first, with:

- its status, **{{ui:frameworkUpdates.status.NEW}}**, **{{ui:frameworkUpdates.status.REVIEWED}}** or **{{ui:frameworkUpdates.status.DISMISSED}}**;
- the framework's name and the two versions, and when the update arrived;
- the publisher's note on what changed, when there is one;
- **{{ui:frameworkUpdates.impactLabel}}** how many requirements are new for you, and how many of your controls were flagged for re-review;
- **{{ui:frameworkUpdates.flaggedControls}}** each of those controls by code and name, linking to it;
- the requirements added, changed and removed, each by code and title, linking to the framework.

## What you can do

### Create findings for the new requirements

Click **{{ui:frameworkUpdates.createFindings}}** on an update with new requirements. One finding is created for each new requirement, saying it has no mapped control. Running it again creates no duplicates.

### Close the update

Click **{{ui:frameworkUpdates.markReviewed}}** once you have dealt with it, or **{{ui:frameworkUpdates.dismiss}}** if it does not concern you. The buttons are offered only while the update is new.

## What happens next

- When the update arrived, each control mapped to a changed requirement that was implemented or being implemented was set to need review. They are listed on the update; a control you have since deleted is left out.
- Map a control to each new requirement on the framework's page to close the gap. See [A framework](framework-detail.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworkUpdates.emptyTitle}}** | {{ui:frameworkUpdates.emptyDescription}} | Nothing to do |
| **{{ui:frameworkUpdates.notFound}}** | Someone removed the update | Reload the page |
| A message in red naming the action, such as **{{ui:frameworkUpdates.failed.materialize}}** | The action failed | Try again |

## Related

- [A framework](framework-detail.md), where you map the new requirements.
- [{{ui:frameworks.list.heading}}](frameworks.md).
- [Findings](../comply/findings.md), where the new findings appear.
