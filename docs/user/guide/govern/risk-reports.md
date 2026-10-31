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
| Generate a report | Owner, Admin, Editor, Auditor |
| Create a template or a schedule; change, pause or delete a schedule | Owner, Admin, Editor |
| Send a scheduled report to someone outside the workspace | Owner, Admin |

PDF and PowerPoint reports need a plan that includes PDF exports. CSV is available on every plan.

## What it is for

Hand management, the board or an auditor a current, consistent document without assembling it by hand, and keep it arriving on time.

## What you see

**{{ui:risks.reports.templates}}.** Each template with its description and three buttons: **{{ui:risks.reports.generatePdf}}**, PPTX and CSV. A deep-dive template also has a picker for the risk to cover, or **{{ui:risks.reports.deepDiveAll}}**. **{{ui:risks.reports.newTemplate}}** adds a template: give it a name and choose its type.

**{{ui:risks.reports.schedulesTitle}}.** A form to create a schedule: **{{ui:risks.reports.scheduleTemplate}}**, **{{ui:risks.reports.scheduleCadence}}**, **{{ui:risks.reports.scheduleFormat}}**, **{{ui:risks.reports.scheduleRecipients}}**, and **{{ui:risks.reports.scheduleSharePointLabel}}**. Below it, each schedule with its state, template, cadence, format, recipients and next run. A deep-dive schedule says whether it covers one risk or the whole portfolio, and a schedule that saves to SharePoint says **{{ui:risks.reports.scheduleToSharePoint}}**. Roles that can change schedules also see **{{ui:risks.reports.scheduleEdit}}**, **{{ui:risks.reports.schedulePause}}** (or **{{ui:risks.reports.scheduleResume}}**) and **{{ui:risks.reports.scheduleDelete}}**.

**{{ui:risks.reports.recent}}.** The reports already generated, newest first: when, which template, the format and the status. A finished report has **{{ui:risks.reports.download}}**. A failed one shows why, with **{{ui:risks.reports.retry}}**. The list refreshes on its own while a report is being generated. It holds the latest 50 reports, and says so when it is full.

## What you can do

### Generate a report

Click the format you want on a template. For a deep dive, choose the risk first. The report appears in **{{ui:risks.reports.recent}}**, and **{{ui:risks.reports.download}}** appears when it is ready.

### Schedule a report

Choose the template, how often and the format, then add email recipients, a SharePoint destination, or both. For SharePoint, click **{{ui:risks.reports.scheduleSharePointChoose}}** and pick the folder in your workspace's SharePoint; without a SharePoint connection the form says **{{ui:risks.reports.scheduleSharePointUnavailable}}** Click **{{ui:risks.reports.scheduleCreate}}**. Recipients must be members of the workspace or on its list of approved outside addresses. Only an Owner or Admin can schedule delivery to someone outside the workspace. If the schedule is refused, the message says why.

### Change, pause or delete a schedule

Click **{{ui:risks.reports.scheduleEdit}}** to change how often, the format, the recipients or a deep dive's risk. Choosing **{{ui:risks.reports.deepDiveAll}}** for a deep dive removes the risk it covered. A schedule that saves to SharePoint can have no email recipients; one that only sends email needs at least one. **{{ui:risks.reports.schedulePause}}** stops it until you resume it. **{{ui:risks.reports.scheduleDelete}}** removes it, with a few seconds to undo.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.reports.templatesEmpty}}** | The workspace has no templates | Click **{{ui:risks.reports.newTemplate}}** |
| **{{ui:risks.reports.empty}}** | No report has been generated | Generate one |
| **{{ui:risks.reports.schedulesEmpty}}** | No report is scheduled | Create a schedule |
| **{{ui:risks.reports.loadError}}** | The page could not load | Reload the page |
| **{{ui:risks.reports.generateFailed}}** | The report was not started because of an outage | Try again |
| **{{ui:risks.reports.scheduleCreateFailed}}** or **{{ui:risks.reports.scheduleUpdateFailed}}** | The schedule was not saved because of an outage | Try again |
| Any other message after a generate, a template or a schedule | The server refused it and says why, for example a recipient it will not send to | Fix what the message names, then try again |

## Related

- [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md), the figures the portfolio report summarises.
- [{{ui:risks.title}}](risks.md), the register the reports draw on.
