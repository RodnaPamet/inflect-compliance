---
route: /t/[tenantSlug]/admin/vendor-templates/[templateId]
---

# A vendor questionnaire template

A template's own page is where you write a vendor questionnaire: its sections, the questions in each, the choices a question offers, and their order. When it is ready, you publish it so it can be sent to vendors. A published template cannot change; to revise it, you copy it into a new draft.

## Where to find it

On the [{{ui:admin.vendorTemplates.title}}](vendor-templates.md) page, click a template, or create a new one. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.vendorTemplates}}** › the template's name.

## Who can use it

| Action | Roles |
| --- | --- |
| Open a template | Owner, Admin |
| Add, edit, remove and reorder sections and questions, publish, copy into a new draft | Owner, Admin |

Everyone else is refused the page.

## What you see

**The header.** The template's name, its key and version, **{{ui:admin.templateBuilder.published}}** or **{{ui:admin.templateBuilder.draft}}**, and the buttons for what you can do now.

**On a published template**, a notice: **{{ui:admin.templateBuilder.publishedTitle}}** {{ui:admin.templateBuilder.publishedDesc}}

**The sections**, in order, each with its questions. Each question shows its text, its kind of answer (such as **{{ui:admin.vendorAnswerType.YES_NO}}** or **{{ui:admin.vendorAnswerType.SINGLE_SELECT}}**), **{{ui:admin.templateBuilder.required}}** when it must be answered, and its weight in the score. A choice question also lists its options, and a scale question its range.

On a draft, every section and question has buttons to move it up or down, to edit it and to remove it.

## What you can do

On a draft:

### Add a section

At the foot of the page, type the section's title in **{{ui:admin.templateBuilder.newSectionTitle}}** and click **{{ui:admin.templateBuilder.addSectionBtn}}**.

### Add a question

Under a section:

1. Type the question in **{{ui:admin.templateBuilder.promptLabel}}**, such as {{ui:admin.templateBuilder.promptPlaceholder}}
2. Choose its **{{ui:admin.templateBuilder.typeLabel}}**: **{{ui:admin.vendorAnswerType.YES_NO}}**, **{{ui:admin.vendorAnswerType.SINGLE_SELECT}}**, **{{ui:admin.vendorAnswerType.MULTI_SELECT}}**, **{{ui:admin.vendorAnswerType.TEXT}}**, **{{ui:admin.vendorAnswerType.NUMBER}}**, **{{ui:admin.vendorAnswerType.SCALE}}** or **{{ui:admin.vendorAnswerType.FILE_UPLOAD}}**.
3. For a choice question, fill in **{{ui:admin.templateBuilder.optionsLabel}}**: the wording of each option and, if you like, the points it adds to the vendor's score. Click **{{ui:admin.templateBuilder.addOption}}** for more.
4. For a scale, set the **{{ui:admin.templateBuilder.scaleMin}}** and **{{ui:admin.templateBuilder.scaleMax}}**, and if you like the words shown at each end, such as {{ui:admin.templateBuilder.scaleLowPlaceholder}} and {{ui:admin.templateBuilder.scaleHighPlaceholder}}.
5. Set its **{{ui:admin.templateBuilder.weightLabel}}**, how much it counts in the score (1 is normal, 0 leaves it out), and tick **{{ui:admin.templateBuilder.requiredCheckbox}}** if the vendor must answer it.
6. Click **{{ui:admin.templateBuilder.addQuestionBtn}}**.

### Edit a section or a question

Click its edit button, change what you need, and click **{{ui:admin.templateBuilder.save}}**, or **{{ui:admin.templateBuilder.cancel}}** to leave it as it was. A question's type, options, scale, weight and whether it is required can all be changed.

### Remove a section or a question

Click its remove button. It leaves the page at once, and the message **{{ui:admin.templateBuilder.questionRemoved}}** (or, for a section, the same with how many questions went with it) offers **{{ui:admin.templateBuilder.undo}}** for a few seconds. Removing a section removes its questions.

### Reorder

Drag a section, or a question within or between sections, to its new place, or use the move up and move down buttons. Then click **{{ui:admin.templateBuilder.saveOrder}}**.

### Publish

Click **{{ui:admin.templateBuilder.publish}}** and confirm **{{ui:admin.templateBuilder.publishConfirmTitle}}** {{ui:admin.templateBuilder.publishConfirmBody}} An order you have not saved yet is saved first.

On a published template:

### Revise it

Click **{{ui:admin.templateBuilder.cloneToDraft}}**. A new draft version opens, with the same sections and questions, ready to change and publish. Assessments already sent keep the version they were sent with.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:admin.templateBuilder.questionsEmptyHelp}} | The section has no questions | Add one |
| {{ui:admin.templateBuilder.optionsNeeded}} | A choice question has no options | Add at least one |
| {{ui:admin.templateBuilder.optionsDuplicate}} | Two options have the same wording | Reword one |
| {{ui:admin.templateBuilder.scaleOrder}} | The scale's lowest value is not below its highest | Fix the two values |
| {{ui:admin.templateBuilder.weightInvalid}} | The weight is not a number of 0 or more | Enter one |
| {{ui:admin.templateBuilder.notFound}} | The template does not exist in this workspace | Open it from the list |
| A sentence saying what failed, such as {{ui:admin.templateBuilder.saveError}} | The change was not saved | Read the reason, and try again |

## Related

- [{{ui:admin.vendorTemplates.title}}](vendor-templates.md), every template.
- [{{ui:vendors.reviewQueue.title}}](vendor-assessment-reviews.md), where completed questionnaires are reviewed.
