---
route: /t/[tenantSlug]/audits/nis2-gap/respond/[assignmentId]
---

# {{ui:audits.respond.title}}

When an Owner or Admin hands you part of a [{{ui:audits.nav.nis2Gap}}](nis2-gap.md), this page lists the questions given to you and takes your answers. You see only your questions; the owner of the assessment puts everyone's answers together and finalises it.

## Where to find it

Open the link in the notification **NIS2 gap assessment assigned**, or in the task you were given, which appears in your [{{ui:nav.tasks}}](tasks.md). The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.nav.nis2Gap}}** › **{{ui:audits.crumb.respond}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and answer the questions | The person the questions were assigned to, whatever their role |
| Open and answer anyone's questions | Owner, Admin |

Anyone else who opens the link sees **{{ui:audits.respond.loadFailed}}** or the reason the server gives.

## What you see

**{{ui:audits.respond.description}}**

The questions, grouped by domain. Each one shows:

- how critical it is: **{{ui:audits.nis2Gap.crit.CRITICAL}}**, **{{ui:audits.nis2Gap.crit.HIGH}}**, **{{ui:audits.nis2Gap.crit.MEDIUM}}** or **{{ui:audits.nis2Gap.crit.LOW}}**;
- the question, in English (or German where your language is German);
- its legal basis in the NIS2 Directive;
- four answers to choose from: **{{ui:audits.nis2Gap.answer.YES}}**, **{{ui:audits.nis2Gap.answer.PARTIALLY}}**, **{{ui:audits.nis2Gap.answer.NO}}** or **{{ui:audits.nis2Gap.answer.NA}}**.

At the foot of the page, the questions' source and licence.

## What you can do

### Answer and submit

1. Choose an answer for each question.
2. Click the submit button at the top. It counts your answers, such as **Submit 12 answers**.
3. The message **{{ui:audits.respond.submitted}}** confirms it.

Your answers are saved only when you submit. If you leave the page first, they are lost.

### Change your answers

After you submit, the page says **{{ui:audits.respond.alreadySubmitted}}** Change any answer and submit again, until the owner finalises the assessment. After that the page says **{{ui:audits.respond.finalized}}** and the answers can only be read.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:audits.respond.loading}} | Your questions are loading | Wait |
| **{{ui:audits.respond.loadFailed}}**, or a reason | Your questions did not load, for example because the assignment belongs to someone else | Open the link from your own notification or task |
| **{{ui:audits.respond.submitFailed}}**, or a reason | Your answers were not saved, for example because the assessment was finalised while you were answering | Follow the reason given |
| {{ui:audits.respond.finalized}} | The owner has finalised the assessment | Nothing; your answers are part of it |

## Related

- [{{ui:audits.nav.nis2Gap}}](nis2-gap.md), the whole assessment, where questions are assigned and the run is finalised.
- [{{ui:nav.tasks}}](tasks.md), where your assignment appears as a task.
