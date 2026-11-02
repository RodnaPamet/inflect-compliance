---
route: /t/[tenantSlug]/admin/vendor-templates/[templateId]
---

# A vendor questionnaire template

A template's own page is where you write a vendor questionnaire: its sections, the questions in each, and their order. When it is ready, you publish it so it can be sent to vendors. A published template cannot change; to revise it, you copy it into a new draft.

## Where to find it

On the [{{ui:admin.vendorTemplates.title}}](vendor-templates.md) page, click a template, or create a new one. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.vendorTemplates}}** › the template's name.

## Who can use it

| Action | Roles |
| --- | --- |
| Open a template | Owner, Admin |
| Add sections and questions, reorder them, publish, copy into a new draft | Owner, Admin |

Everyone else is refused the page.

## What you see

**The header.** The template's name, **{{ui:admin.templateBuilder.published}}** or **{{ui:admin.templateBuilder.draft}}**, and the buttons for what you can do now.

**On a published template**, a notice: **{{ui:admin.templateBuilder.publishedTitle}}** {{ui:admin.templateBuilder.publishedDesc}}

**The sections**, in order, each with its questions. Each question shows its text, its kind of answer, **{{ui:admin.templateBuilder.required}}** when it must be answered, and its weight in the score.

## What you can do

On a draft:

### Add a section

At the foot of the page, type the section's title in **{{ui:admin.templateBuilder.newSectionTitle}}** and click **{{ui:admin.templateBuilder.addSectionBtn}}**.

### Add a question

Under a section:

1. Type the question in **{{ui:admin.templateBuilder.promptLabel}}**, such as {{ui:admin.templateBuilder.promptPlaceholder}}
2. Choose its **{{ui:admin.templateBuilder.typeLabel}}**: yes or no, one choice, several choices, text, a number, a scale, or a file to upload.
3. Set its **{{ui:admin.templateBuilder.weightLabel}}**, how much it counts in the score, and tick **{{ui:admin.templateBuilder.requiredCheckbox}}** if the vendor must answer it.
4. Click **{{ui:admin.templateBuilder.addQuestionBtn}}**.

### Reorder

Drag a section, or a question within or between sections, to its new place. Then click **{{ui:admin.templateBuilder.saveOrder}}**.

### Publish

Click **{{ui:admin.templateBuilder.publish}}**. The template can then be sent to vendors, and can no longer change.

On a published template:

### Revise it

Click **{{ui:admin.templateBuilder.cloneToDraft}}**. A new draft version opens, with the same sections and questions, ready to change and publish. Assessments already sent keep the version they were sent with.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:admin.templateBuilder.questionsEmpty}} | The section has no questions | Add one |
| {{ui:admin.templateBuilder.notFound}} | The template does not exist in this workspace | Open it from the list |
| An error naming what failed, such as saving the order or publishing | The change was not saved | Try again |

## Related

- [{{ui:admin.vendorTemplates.title}}](vendor-templates.md), every template.
- [{{ui:vendors.reviewQueue.title}}](vendor-assessment-reviews.md), where completed questionnaires are reviewed.
