---
route: /t/[tenantSlug]/reports/soa/print
---

# {{ui:reports.soaPrint.printPreview}}

The print view is a plain version of the [{{ui:reports.cardSoaTitle}}](statement-of-applicability.md), laid out to print or to save as a PDF for an auditor. It has no menus or sidebar, and it starts each section on a new page when printed.

## Where to find it

On the [{{ui:reports.cardSoaTitle}}](statement-of-applicability.md) page, click **{{ui:reports.soaView.print}}**. The print view opens in a new tab, for the same framework.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the print view, print it or save it as a PDF | Owner, Admin, Editor, Auditor |

It also needs a plan that includes PDF exports: every plan except Free, and every self-hosted installation. Anyone else who opens it is sent to the [{{ui:reports.title}}](reports.md) page instead.

## What you see

At the top, on screen only, **{{ui:reports.soaPrint.printPreview}}** with the hint {{ui:reports.soaPrint.printHint}}, and two buttons.

The document itself:

- **The cover.** The statement's title and framework, then **{{ui:reports.soaPrint.organization}}**, **{{ui:reports.soaPrint.framework}}**, **{{ui:reports.soaPrint.generated}}** (the date) and **{{ui:reports.soaPrint.totalControls}}**.
- **{{ui:reports.soaPrint.summary}}**: six counts, each against the total: **{{ui:reports.soaPrint.applicable}}**, **{{ui:reports.soaPrint.notApplicable}}**, **{{ui:reports.soaPrint.unmapped}}**, **{{ui:reports.soaPrint.implemented}}**, **{{ui:reports.soaPrint.excepted}}** and **{{ui:reports.soaPrint.missingJustification}}**.
- **One table per section**, each requirement on a row. Requirements that belong to no section are listed under **{{ui:reports.soaPrint.otherSection}}**.

  | Column | What it shows |
  | --- | --- |
  | {{ui:reports.soaPrint.colCode}} | The requirement's code, such as A.5.1 |
  | {{ui:reports.soaPrint.colRequirement}} | Its title |
  | {{ui:reports.soaPrint.colApplicable}} | **{{ui:reports.soaPrint.yes}}**, **{{ui:reports.soaPrint.no}}**, or **{{ui:reports.soaPrint.unmappedVal}}** when no control covers it; an unmapped row is highlighted |
  | {{ui:reports.soaPrint.colStatus}} | How far its controls are implemented, such as **{{ui:reports.soaView.controlStatus.IMPLEMENTED}}** or **{{ui:reports.soaView.controlStatus.IN_PROGRESS}}**, or **{{ui:reports.soaPrint.excepted}}** with the date the exception ends |
  | {{ui:reports.soaPrint.colControlRefs}} | The controls that cover it, by code and title |
  | {{ui:reports.soaPrint.colJustification}} | Why it applies or does not |

- **A footer** with the date, saying the document is a snapshot to check against the current controls.

## What you can do

- Click **{{ui:reports.soaPrint.printBtn}}**, or press Ctrl+P (Cmd+P on a Mac), and choose a printer or **Save as PDF**. The hint and the buttons at the top are left off the printed copy.
- Click **{{ui:reports.soaPrint.back}}** to return. In the new tab it opens in, that goes to the [{{ui:reports.title}}](reports.md) page.

The print view shows the statement as it stands when you open it. To print a later state, open it again.

## Related

- [{{ui:reports.cardSoaTitle}}](statement-of-applicability.md), the page it prints.
- [{{ui:reports.title}}](reports.md), the other reports and exports.
