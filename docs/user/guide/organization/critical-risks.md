---
route: /org/[orgSlug]/risks
---

# {{ui:org.risks.title}}

The {{ui:org.risks.title}} page lists every critical risk that is still open, in every workspace of the organization. It is the list behind the critical-risks figure on the [{{ui:org.dashboard.title}}](portfolio-overview.md).

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.portfolio}}, click **{{ui:org.nav.criticalRisks}}**. You can also follow the risks link on the dashboard's {{ui:org.widgets.drilldown}} card.

## Who can use it

| Action | Roles |
| --- | --- |
| See the item in the sidebar and open the page | Owner, Admin |
| Open a risk from its row | Anyone who belongs to the risk's workspace; organization Owners and Admins have Admin access to every workspace |

## What you see

A table, one row per risk, highest score first:

| Column | What it shows |
| --- | --- |
| {{ui:org.risks.colTenant}} | The workspace the risk belongs to |
| {{ui:org.risks.colRisk}} | The risk's title. Click it to open the risk in its workspace |
| {{ui:org.risks.colScore}} | Its inherent score, likelihood × impact |
| {{ui:org.risks.colStatus}} | **{{ui:org.risks.statusOpen}}**, **{{ui:org.risks.statusMitigating}}** or **{{ui:org.risks.statusAccepted}}** |
| {{ui:org.risks.colUpdated}} | When the risk last changed |

Here, a risk is critical when its inherent score is 15 or more, the top band of the standard 5 × 5 grid. The same threshold is used for every workspace, whatever risk matrix the workspace has set up. The list is read live.

## What you can do

**Sort.** Click a column heading.

**Load more.** When there are more risks than the first batch, the line under the title says **more available**; click **{{ui:org.risks.loadMore}}** below the table.

**Open a risk.** Click its title to work on it in its workspace.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.risks.emptyTitle}}** | No open risk in any workspace scores 15 or more | Nothing |
| **{{ui:org.risks.failedLoadMore}}** | The next batch did not load | Click **{{ui:org.risks.loadMore}}** again |

## Related

- [{{ui:org.nav.nonPerformingControls}}](non-performing-controls.md) and [{{ui:org.nav.overdueEvidence}}](overdue-evidence.md), the other two cross-workspace lists.
