---
route: /t/[tenantSlug]/risks
---

# {{ui:risks.title}}

The {{ui:risks.title}} is the workspace's list of business risks. It shows each risk's score before and after controls, who owns it and how it is treated, and it flags the risks whose assessment has gone stale.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}** in the sidebar. The breadcrumb reads **{{ui:risks.breadcrumbDashboard}}** › **{{ui:risks.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the register, the matrix and the histogram | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create or import risks, or add them with {{ui:risks.aiAssist}} | Owner, Admin, Editor |
| Set status or assign an owner in bulk | Owner, Admin, Editor |
| Delete in bulk | Owner, Admin |

If your workspace uses custom roles, what you can do depends on the permissions your role was given. The page offers only what your role can do: **{{ui:risks.addRisk}}**, the import and **{{ui:risks.aiAssist}}** appear only for a role that can create risks. Every role can tick rows, but the selection bar offers only the bulk actions your role can apply. A role that can apply none of them sees no actions there.

## What it is for

Use the register to answer three questions: what could hurt the business, how badly, and what is being done about it. Each risk is scored on likelihood × impact. Linked controls lower its residual score, and a risk is flagged when its assessment has gone out of date.

## What you see

**Summary cards.** Four cards sit above the table, each with a trend line:

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:riskManager.totalRisks}} | Every risk on the register | Clears every filter |
| {{ui:riskManager.avgScore}} | The mean inherent score | Nothing; it is not a filter |
| {{ui:riskManager.openRisks}} | Risks that are {{ui:risks.bulkStatus.open}} or {{ui:risks.bulkStatus.mitigating}} | Filters to those two statuses |
| {{ui:risks.kpiStale}} | Risks whose assessment is stale, as defined under the column of the same name | Filters to stale risks |

**The toolbar.** From left to right:

- **{{ui:risks.addRisk}}** opens the new-risk dialog. Only roles that can create risks see it.
- The **{{ui:common.ui.filter}}** button holds the search and the filters. Its search box, **{{ui:risks.searchPlaceholder}}**, filters the table as you type. The filters are {{ui:risks.filters.status}}, {{ui:risks.filters.category}}, {{ui:risks.filters.owner}}, {{ui:risks.filters.score}}, {{ui:risks.filters.residualScore}}, {{ui:risks.filters.treatment}}, {{ui:risks.filters.quantified}}, {{ui:risks.filters.stale}} and {{ui:risks.filters.cell}}. Each active filter shows as a pill beside the button; remove a pill to drop that filter.
- **{{ui:risks.register}}** and **{{ui:risks.heatmap}}** switch between the table and the risk matrix. The page remembers your choice.
- **{{ui:risks.viewsMenu}}** holds the other views, in three groups:
    - **{{ui:risks.viewsAnalytics}}:** {{ui:risks.histogram}}, {{ui:risks.viewLinks.board}}, {{ui:risks.viewLinks.scenarios}}, {{ui:risks.viewLinks.hierarchy}}, {{ui:risks.viewLinks.kri}}, {{ui:risks.viewLinks.correlations}}, {{ui:risks.viewLinks.lossEvents}} and {{ui:risks.viewLinks.reports}}.
    - **{{ui:risks.viewsRegistry}}:** {{ui:risks.viewLinks.aiSystems}} and {{ui:risks.viewLinks.informationRegistry}}.
    - **{{ui:risks.viewsTools}}:** {{ui:risks.viewVulnerabilities}}, and {{ui:risks.importRisks}} for roles that can create risks.
- The dashboard button opens the **{{ui:risks.viewLinks.dashboard}}**.
- Two settings buttons close the row. The first chooses which table columns are shown, the second which summary cards.

Filters are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who has access to the workspace.

**The table.** Each row is one risk. Click its title to open it.

| Column | What it shows |
| --- | --- |
| {{ui:risks.colHeaders.code}} | The risk's short reference. Hidden until you turn it on |
| {{ui:risks.riskTitle}} | The risk's name, linked to the risk |
| {{ui:risks.asset}} | The asset the risk sits on |
| {{ui:risks.score}} | The inherent score, likelihood × impact before controls, coloured by its band in your workspace's risk matrix. Click it for a breakdown of how the score was reached. A quantified risk also shows its annualised loss expectancy beside the score |
| {{ui:risks.level}} | The name of the score's band in your workspace's risk matrix |
| {{ui:risks.colHeaders.residual}} | The score after controls. A dash, with the hint **{{ui:risks.residualNotAssessed}}**, means nobody has set one |
| {{ui:risks.colHeaders.staleness}} | A **{{ui:risks.stale}}** badge when the assessment is out of date. Hover it for the reason |
| {{ui:risks.colHeaders.ale}} | The annualised loss expectancy in the workspace's currency. Hidden until you turn it on |
| {{ui:risks.colHeaders.status}} | {{ui:risks.bulkStatus.open}}, {{ui:risks.bulkStatus.mitigating}}, {{ui:risks.bulkStatus.mitigated}}, {{ui:risks.bulkStatus.accepted}} or {{ui:risks.bulkStatus.closed}} |
| {{ui:risks.colHeaders.owner}} | The person accountable for treating the risk |
| {{ui:risks.treatment}} | The treatment decision |
| {{ui:risks.controlsCol}} | How many controls are linked to the risk |
| {{ui:risks.colHeaders.tasks}} | How many tasks are linked to the risk |

A risk is stale when any of these is true:

- Its next review date has passed.
- Its last assessment is more than 180 days old.
- A linked control completed a test run after the residual score was last set.
- A linked key risk indicator moved into its red band after the last assessment.

A risk with none of these signals, such as one with no review date, no linked controls and no indicators, is never flagged as stale. Missing data is a gap in coverage, which the register does not report as staleness.

**The matrix.** **{{ui:risks.heatmap}}** draws every risk on the workspace's likelihood × impact grid. Click a cell to return to the table filtered to exactly that cell. Two cells with the same score product, such as 3 × 4 and 4 × 3, stay separate.

**The histogram.** **{{ui:risks.histogram}}**, in the **{{ui:risks.viewsMenu}}** menu, places each quantified risk in a loss bucket on a logarithmic scale, stacked by its matrix band. When your workspace has a risk appetite, a line marks the per-risk appetite. Below the chart, **{{ui:risks.collisions.title}}** lists risks that share a matrix cell while their loss estimates differ by more than ten times. Click one to see those risks in the table.

**{{ui:risks.aiAssist}}.** Roles that can create risks get a collapsed side panel that opens the AI-assisted risk assessment. The suggestions you accept there are added to the register as new risks, so the panel is offered to the same roles as **{{ui:risks.addRisk}}**.

## What you can do

### Create a risk

Click **{{ui:risks.addRisk}}**. The **{{ui:risks.new.title}}** dialog asks for a **{{ui:risks.new.titleLabel}}**, which is required. Its other fields are optional: a **{{ui:risks.new.templateLabel}}**, **{{ui:risks.new.categoryLabel}}**, **{{ui:risks.new.ownerLabel}}**, **{{ui:risks.new.descriptionLabel}}**, likelihood and impact, **{{ui:risks.new.treatmentLabel}}**, **{{ui:risks.new.treatmentNotesLabel}}**, a **{{ui:risks.new.nextReviewLabel}}** date and **{{ui:risks.new.linkControls}}**. Click **{{ui:risks.new.submit}}**. The new risk appears in the table.

### Change many risks at once

Tick the rows you want, up to 100 at a time, and pick an action in the selection bar. It lists only the actions your role can apply:

- **{{ui:risks.bulk.setStatus}}** moves every selected risk to the status you choose.
- **{{ui:risks.bulk.assignOwner}}** gives them all one owner. Leave the owner empty to unassign them.
- **{{ui:risks.bulk.delete}}** removes them from the register. For five seconds a message offers **{{ui:risks.bulk.undo}}**. Nothing is deleted until that time runs out.

If an action is refused, the message gives the reason, for example an owner who is no longer a member of the workspace. A failed status or owner change leaves the rows selected, so you can try again without picking them again. A failed deletion puts the rows back in the table.

If more than 100 rows are selected, nothing is sent and a message asks you to select fewer.

### Import risks

Open **{{ui:risks.viewsMenu}}** › **{{ui:risks.importRisks}}** to load risks from a CSV file.

## What happens next

- Every status change, owner change and deletion writes one entry per risk to the workspace's audit log, naming who made it.
- A deleted risk leaves the register at once and is removed for good after 90 days. If one was deleted by mistake, an Owner or Admin can restore it within those 90 days; this page has no restore button, so they do it through the Inflect API.
- The workspace dashboard's risk figures update to match.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:panels.riskFirstRun.title}}** | The workspace has no risks yet | Click **{{ui:panels.riskFirstRun.cta}}**, or import risks. Roles that cannot create risks see no button |
| **{{ui:risks.emptyFilter.title}}** | Risks exist, but none match the search and filters | Click **{{ui:risks.emptyFilter.clearFilters}}** |
| **{{ui:risks.bulk.actionFailed}}** | A bulk action did not reach the server, or failed without giving a reason | Try again |
| **{{ui:risks.loadError}}** | The list did not load for the filters you set. The table, the matrix and the histogram show this message in place of risks, and the {{ui:riskManager.totalRisks}}, {{ui:riskManager.avgScore}} and {{ui:riskManager.openRisks}} cards show a dash | Check your connection, then reload the page |
| A banner saying the list is truncated | The register holds more than 5,000 risks, more than the page loads at once | Narrow the list with a filter or the search |
