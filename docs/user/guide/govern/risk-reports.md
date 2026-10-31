---
route: /t/[tenantSlug]/risks/reports
---

# Risk reports

The {{ui:risks.reports.title}} page produces documents about your risks: a portfolio summary, a deep dive into one risk, a business impact analysis. You can generate one when you need it, or schedule it to be sent by email or saved to SharePoint every week, month or quarter.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.reports}}**. The breadcrumb reads **{{ui:risks.breadcrumbRoot}}** › **{{ui:risks.reports.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See templates, schedules and past reports; download a report | Every role |
| Generate a report, create a template, create or change a schedule | Owner, Admin, Editor, Auditor |
| Send a scheduled report to someone outside the workspace | Owner, Admin |

PDF and PowerPoint reports need a plan that includes PDF exports. CSV is available on every plan.

## What it is for

Hand management, the board or an auditor a current, consistent document without assembling it by hand, and keep it arriving on time.

## What you see

**{{ui:risks.reports.templates}}.** Each template with its description and three buttons: **{{ui:risks.reports.generatePdf}}**, PPTX and CSV. A deep-dive template also has a picker for the risk to cover, or **{{ui:risks.reports.deepDiveAll}}**. **{{ui:risks.reports.newTemplate}}** adds a template: give it a name and choose its type.

**{{ui:risks.reports.schedulesTitle}}.** A form to create a schedule: **{{ui:risks.reports.scheduleTemplate}}**, **{{ui:risks.reports.scheduleCadence}}**, **{{ui:risks.reports.scheduleRecipients}}**, and optionally a SharePoint drive and folder. Below it, each schedule with its state, template, cadence, recipients and next run, and **{{ui:risks.reports.scheduleEdit}}**, **{{ui:risks.reports.schedulePause}}** (or **{{ui:risks.reports.scheduleResume}}**) and **{{ui:risks.reports.scheduleDelete}}**.

**{{ui:risks.reports.recent}}.** The reports already generated: when, which template, the format and the status. A finished report has **{{ui:risks.reports.download}}**. A failed one shows why, with **{{ui:risks.reports.retry}}**. The list refreshes on its own while a report is being generated.

## What you can do

### Generate a report

Click the format you want on a template. For a deep dive, choose the risk first. The report appears in **{{ui:risks.reports.recent}}**, and **{{ui:risks.reports.download}}** appears when it is ready.

### Schedule a report

Choose the template and how often, then add email recipients, a SharePoint destination, or both. Click **{{ui:risks.reports.scheduleCreate}}**. Recipients must be members of the workspace or on its list of approved outside addresses. Only an Owner or Admin can schedule delivery to someone outside the workspace.

### Change, pause or delete a schedule

Click **{{ui:risks.reports.scheduleEdit}}** to change how often, the format, the recipients or a deep dive's risk. **{{ui:risks.reports.schedulePause}}** stops it until you resume it. **{{ui:risks.reports.scheduleDelete}}** removes it, with a few seconds to undo.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.reports.templatesEmpty}}** | The workspace has no templates | Click **{{ui:risks.reports.newTemplate}}** |
| **{{ui:risks.reports.empty}}** | No report has been generated | Generate one |
| **{{ui:risks.reports.schedulesEmpty}}** | No report is scheduled | Create a schedule |
| **{{ui:risks.reports.loadError}}** | The page could not load | Reload the page |
| **{{ui:risks.reports.generateFailed}}** | The report was not started | Try again |
| **{{ui:risks.reports.scheduleCreateFailed}}** or **{{ui:risks.reports.scheduleUpdateFailed}}** | The schedule was not saved | Check the recipients, then try again |

## Related

- [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md), the figures the portfolio report summarises.
- [{{ui:risks.title}}](risks.md), the register the reports draw on.
