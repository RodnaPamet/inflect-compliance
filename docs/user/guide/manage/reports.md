---
route: /t/[tenantSlug]/reports
---

# {{ui:reports.title}}

The {{ui:reports.title}} page brings the workspace's reports together for one framework at a time: how well its requirements are covered and implemented, which ones have nothing mapped, and the exports you hand to an auditor. It also links to the risk reports and, for ISO 27001, the Statement of Applicability.

## Where to find it

Open **{{ui:nav.reports}}** under **{{ui:nav.manage}}** in the sidebar. The breadcrumb reads **{{ui:reports.crumbDashboard}}** › **{{ui:reports.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read the reports on it | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Export a report as a PDF, or the Statement of Applicability as a CSV file | Owner, Admin, Editor, Auditor |
| Save an exported PDF to the workspace's files | Owner, Admin, Editor |
| Open the trust center settings from here | Owner, Admin |

The export buttons appear only for the roles that can export, and the save button only for those that can save. If your workspace's plan does not include PDF exports, an upgrade prompt shows in place of the PDF buttons.

If your workspace uses custom roles, exporting follows your custom role's own permission to export reports.

## What it is for

Use the page to answer "how ready are we for this framework?" and to produce the documents that prove it: a readiness report for management, a gap analysis for the people closing the gaps, and the Statement of Applicability an ISO 27001 auditor asks for.

## What you see

**The header.** The title and a line describing the reports. Owners and Admins also see a button that opens the **{{ui:reports.trustCenter}}** settings. Under it, **{{ui:reports.frameworkLabel}}** chooses which of the workspace's frameworks the page reports on. It is locked when the workspace uses only one.

**The report cards.**

| Card | What it offers |
| --- | --- |
| {{ui:reports.cardCoverageTitle}} | **{{ui:reports.viewOnPage}}**, which scrolls to the readiness report further down |
| {{ui:reports.cardGapTitle}} | **{{ui:reports.exportPdf}}**: a PDF of the framework's requirements that have no mapped or implemented control |
| {{ui:reports.cardRiskTitle}} | The names of up to five of the workspace's risk report templates, and **{{ui:reports.openRiskReports}}**, which opens the risk reports page where they are run and scheduled |
| {{ui:reports.cardSoaTitle}} | For an ISO 27001 framework only: **{{ui:reports.openSoa}}**, and **{{ui:reports.exportCsv}}** to download it |

**The readiness report.** For the chosen framework, with **{{ui:reports.exportPdf}}** beside its heading:

| Figure | What it means |
| --- | --- |
| {{ui:reports.mappedPct}} | The share of requirements that have at least one control mapped to them. It measures mapping, not completion |
| {{ui:reports.implementedPct}} | The share of requirements whose controls are implemented |
| {{ui:reports.readinessScore}} | An overall score for how ready the workspace is |
| {{ui:reports.gapsMappedNotImplemented}} | Requirements with a control mapped that is not implemented |
| {{ui:reports.excepted}} | Requirements excluded by an approved exception |

Under the figures, a sentence counts how many requirements are mapped and implemented, then **{{ui:reports.coverageBySection}}** breaks the coverage down by section of the framework. Last comes the gap analysis: every requirement with no control mapped, or **{{ui:reports.noGaps}}**.

## What you can do

### Report on another framework

Choose it in **{{ui:reports.frameworkLabel}}**. The cards and the readiness report switch to it.

### Export a PDF

Click **{{ui:reports.exportPdf}}** on the gap analysis card or beside the readiness report. The PDF downloads to your computer. Owners, Admins and Editors also get a save button beside it, which saves the PDF to the workspace's files instead, so it can be attached as evidence; a browser message confirms the file's name and size.

### Export the Statement of Applicability

On an ISO 27001 framework, click **{{ui:reports.exportCsv}}** on its card for a spreadsheet of every Annex A control, whether it applies, and why. **{{ui:reports.openSoa}}** opens the statement on its own page.

## What happens next

- The figures move as controls are mapped and implemented and exceptions approved; they are worked out each time the page opens.
- A PDF saved to the workspace's files can be attached as evidence like any other file.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:reports.loadingReadiness}}** | The report for the chosen framework is loading | Wait a moment |
| **{{ui:reports.readinessLoadError}}** | The readiness report did not load | Choose the framework again, or reload the page |
| A browser message that the export failed | The PDF was not made. The message does not say why | Try again; if your plan limits PDF exports, ask an Owner |
| No Statement of Applicability card | The chosen framework is not ISO 27001 | Choose an ISO 27001 framework, if the workspace uses one |

## Related

- [{{ui:frameworks.list.heading}}](../govern/frameworks.md), where frameworks are added and their requirements mapped.
- [{{ui:controls.title}}](../govern/controls.md), whose implementation drives the figures.
- [{{ui:risks.title}}](../govern/risks.md), with the risk reports.
