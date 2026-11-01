---
route: /org/[orgSlug]/evidence
---

# {{ui:org.evidence.title}}

The {{ui:org.evidence.title}} page lists every evidence item, in every workspace of the organization, whose review date has passed without it being approved. It is the list behind the overdue-evidence figure on the [{{ui:org.dashboard.title}}](portfolio-overview.md).

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.portfolio}}, click **{{ui:org.nav.overdueEvidence}}**. You can also follow the evidence link on the dashboard's {{ui:org.widgets.drilldown}} card.

## Who can use it

| Action | Roles |
| --- | --- |
| See the item in the sidebar and open the page | Owner, Admin |
| Open an evidence item from its row | Anyone who belongs to its workspace; organization Owners and Admins have Admin access to every workspace |

## What you see

A table, one row per evidence item, the longest overdue first:

| Column | What it shows |
| --- | --- |
| {{ui:org.evidence.colTenant}} | The workspace the evidence belongs to |
| {{ui:org.evidence.colEvidence}} | The evidence item's title. Click it to open it in its workspace |
| {{ui:org.evidence.colOverdue}} | How many days past its review date it is |
| {{ui:org.evidence.colStatus}} | **{{ui:org.evidence.statusDraft}}**, **{{ui:org.evidence.statusSubmitted}}** or **{{ui:org.evidence.statusRejected}}** |
| {{ui:org.evidence.colReviewDue}} | The review date that has passed |

Approved evidence is not listed. The list is read live.

## What you can do

**Sort.** Click a column heading.

**Load more.** When there are more items than the first batch, the line under the title says **more available**; click **{{ui:org.evidence.loadMore}}** below the table.

**Open an evidence item.** Click its title to review or replace it in its workspace.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.evidence.emptyTitle}}** | No unapproved evidence in any workspace is past its review date | Nothing |
| **{{ui:org.evidence.failedLoadMore}}** | The next batch did not load | Click **{{ui:org.evidence.loadMore}}** again |

## Related

- [{{ui:org.nav.nonPerformingControls}}](non-performing-controls.md) and [{{ui:org.nav.criticalRisks}}](critical-risks.md), the other two cross-workspace lists.
