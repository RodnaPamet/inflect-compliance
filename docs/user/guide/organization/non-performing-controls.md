---
route: /org/[orgSlug]/controls
---

# {{ui:org.controls.title}}

The {{ui:org.controls.title}} page lists every applicable control, in every workspace of the organization, that is still short of implemented. It is the list behind the controls figure on the [{{ui:org.dashboard.title}}](portfolio-overview.md), so you can see which controls hold coverage down and where.

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.portfolio}}, click **{{ui:org.nav.nonPerformingControls}}**. You can also follow the controls link on the dashboard's {{ui:org.widgets.drilldown}} card.

## Who can use it

| Action | Roles |
| --- | --- |
| See the item in the sidebar and open the page | Owner, Admin |
| Open a control from its row | Anyone who belongs to the control's workspace; organization Owners and Admins have Admin access to every workspace |

## What you see

A table, one row per control, sorted by workspace:

| Column | What it shows |
| --- | --- |
| {{ui:org.controls.colTenant}} | The workspace the control belongs to |
| {{ui:org.controls.colControl}} | The control's name. Click it to open the control in its workspace |
| {{ui:org.controls.colCode}} | The control's code, such as A.5.1, or — |
| {{ui:org.controls.colStatus}} | **{{ui:org.controls.statusNeedsReview}}**, **{{ui:org.controls.statusNotStarted}}**, **{{ui:org.controls.statusPlanned}}**, **{{ui:org.controls.statusInProgress}}** or **{{ui:org.controls.statusImplementing}}** |
| {{ui:org.controls.colUpdated}} | When the control last changed |

Controls marked implemented or not applicable are not listed. The figures here are read live, so they can be ahead of the dashboard, which uses each workspace's daily snapshot.

## What you can do

**Sort.** Click a column heading.

**Load more.** The page loads the first batch of controls, and the line under the title counts them. When there are more, it adds **more to load below** and a **{{ui:org.controls.loadMore}}** button appears below the table; click it to add the next batch.

**Open a control.** Click its name to work on it in its workspace.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.controls.emptyTitle}}** | Every applicable control in every workspace is implemented | Nothing |
| **{{ui:org.controls.failedLoadMore}}** | The next batch did not load | Click **{{ui:org.controls.loadMore}}** again |

## Related

- [{{ui:org.nav.criticalRisks}}](critical-risks.md) and [{{ui:org.nav.overdueEvidence}}](overdue-evidence.md), the other two cross-workspace lists.
