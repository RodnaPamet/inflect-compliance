---
route: /t/[tenantSlug]/admin/vendor-templates
---

# {{ui:admin.vendorTemplates.title}}

The {{ui:admin.vendorTemplates.title}} page lists the questionnaires your workspace sends to vendors, and is where you start a new one. A template is a set of sections and questions; once published, it can be sent to vendors for assessment.

## Where to find it

Open [{{ui:admin.crumb.admin}}](administration.md) and click **{{ui:admin.nav.vendorTemplates}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.vendorTemplates}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and the templates | Owner, Admin |
| Create a template | Owner, Admin |

Everyone else is refused the page.

## What you see

**{{ui:admin.vendorTemplates.createHeading}}**, a short form, and below it the templates. Each one shows:

- its name;
- its key, its version, and how many sections and questions it has;
- **{{ui:admin.vendorTemplates.published}}** or **{{ui:admin.vendorTemplates.draft}}**, and **{{ui:admin.vendorTemplates.builtIn}}** for a template that comes with the product;
- when it was last changed.

Click a template to open it.

## What you can do

### Create a template

1. Under **{{ui:admin.vendorTemplates.createHeading}}**, enter a **{{ui:admin.vendorTemplates.keyLabel}}**, a short identifier such as `soc2-vendor` that stays the same across versions, and a **{{ui:admin.vendorTemplates.nameLabel}}**.
2. Click **{{ui:admin.vendorTemplates.createDraft}}**.

The new template opens as a draft, ready for its sections and questions. See [a vendor questionnaire template](vendor-template-builder.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.vendorTemplates.emptyTitle}}** | {{ui:admin.vendorTemplates.emptyDesc}} | Create one |
| {{ui:admin.vendorTemplates.keyNameRequired}} | One of the two fields is empty | Fill in both |
| {{ui:admin.vendorTemplates.createFailed}} | The template was not created, or the server said why below the form | Check the message, then try again |
| {{ui:admin.vendorTemplates.loadFailed}} | The list did not load | Click **{{ui:admin.vendorTemplates.retry}}** |

## Related

- [A vendor questionnaire template](vendor-template-builder.md), where a template's questions are written and it is published.
- [{{ui:vendors.reviewQueue.title}}](vendor-assessment-reviews.md), where vendors' completed questionnaires are reviewed.
- [Vendors](../manage/vendors.md), the vendors questionnaires are sent to.
