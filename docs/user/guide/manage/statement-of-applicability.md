---
route: /t/[tenantSlug]/reports/soa
---

# {{ui:reports.cardSoaTitle}}

The {{ui:reports.cardSoaTitle}} page lists every ISO 27001 Annex A requirement with whether it applies to you, how far its controls are implemented, and, for each one you exclude, why. It is the document an ISO 27001 auditor asks for first.

## Where to find it

On the [{{ui:reports.title}}](reports.md) page, choose an ISO 27001 framework and click **{{ui:reports.openSoa}}** on the **{{ui:reports.cardSoaTitle}}** card. The page has a back link. It exists only for ISO 27001: opened for any other framework, it returns to the reports page.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the statement and print it | Every role |
| Map a control to a requirement, and justify an exclusion | Owner, Admin, Editor |

## What it is for

Show the auditor, requirement by requirement, which Annex A controls you apply and which you exclude, with a reason for every exclusion. Find the gaps that keep the statement from being ready, and close them here.

## What you see

The framework's name and how many requirements it has, then seven figures: **{{ui:reports.soaView.total}}**, **{{ui:reports.soaView.applicable}}**, **{{ui:reports.soaView.notApplicable}}**, **{{ui:reports.soaView.unmapped}}**, **{{ui:reports.soaView.implemented}}**, **{{ui:reports.soaView.excepted}}** and **{{ui:reports.soaView.missingJustification}}**.

While any requirement is unmapped or an exclusion lacks a reason, a red banner says **{{ui:reports.soaView.notReady}}**, how many of each, and **{{ui:reports.soaView.fixNow}}**.

**The table.** One row per requirement:

| Column | Shows |
| --- | --- |
| **{{ui:reports.soaView.colCode}}** and **{{ui:reports.soaView.colRequirement}}** | The Annex A control |
| **{{ui:reports.soaView.colApplicability}}** | **{{ui:reports.soaView.applicable}}** if any mapped control applies, **{{ui:reports.soaView.notApplicable}}** if every mapped control is excluded, **{{ui:reports.soaView.unmapped}}** if none is mapped |
| **{{ui:reports.soaView.colStatus}}** | The least advanced status among the applicable mapped controls, or **{{ui:reports.soaView.excepted}}** when an exception in force covers it |
| **{{ui:reports.soaView.colControls}}** | The mapped controls |
| **{{ui:reports.soaView.colGaps}}** | **{{ui:reports.soaView.unmapped}}** or **{{ui:reports.soaView.justificationMissing}}** |

Click a row to open it: **{{ui:reports.soaView.mappedControls}}**, each with its applicability, its reason if excluded, its evidence, open tasks and last test.

## What you can do

### Show only what needs fixing

Click **{{ui:reports.soaView.showGaps}}**, or **{{ui:reports.soaView.fixNow}}** in the banner. **{{ui:reports.soaView.clear}}** shows every requirement again.

### Map a control to an unmapped requirement

1. Click the map button on the requirement's row.
2. Search for the control and click it.

The requirement then takes the control's applicability.

### Justify an exclusion

1. Open the requirement's row and click **{{ui:reports.soaView.justify}}** beside an excluded control that has no reason. A reason already given is changed on the control's own page.
2. Write why it does not apply, for example: {{ui:reports.soaView.justPlaceholder}}
3. Click **{{ui:reports.soaView.saveJustification}}**.

The reason is saved on the control, so it applies wherever the control is mapped.

### Print it

Click **{{ui:reports.soaView.print}}**. A plain version opens in a new tab, ready to print or save as a PDF. To download it as a CSV file, use **{{ui:reports.exportCsv}}** on the reports page.

## What happens next

- The statement is worked out from your controls each time it opens. Change a control's applicability or status on its own page and the statement follows.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:reports.soaView.noGaps}} | Every requirement is mapped and every exclusion has a reason | Nothing to fix |
| **{{ui:reports.soaView.mapFailed}}** | The control was not mapped | Try again |
| **{{ui:reports.soaView.justificationFailed}}** | The reason was not saved | Try again |

## Related

- [{{ui:reports.title}}](reports.md), where the statement is opened and exported.
- [{{ui:controls.list.pageTitle}}](../govern/controls.md), where each control's applicability is set.
- [A framework](../govern/framework-detail.md), ISO 27001's requirements and your mappings.
