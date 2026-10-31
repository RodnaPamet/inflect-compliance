---
route: /t/[tenantSlug]/audits/nis2-gap
---

# {{ui:audits.nav.nis2Gap}}

The {{ui:audits.nav.nis2Gap}} page tracks how ready the workspace is for the EU's NIS2 directive, using a self-assessment questionnaire. It scores each run of the questionnaire, shows how the score moves over time, ranks the gaps by how much they matter, and turns the gaps you choose into risks, controls and tasks.

{{ui:audits.nis2Gap.kpiReadinessHint}} It is a self-assessment aid, not a legal finding that you comply with NIS2; the page says so in a notice at the top.

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar, then click **{{ui:audits.nav.nis2Gap}}** in the header. The button appears once the workspace uses NIS2: a NIS2 assessment has been run, or a control is mapped to a NIS2 requirement. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.nav.nis2Gap}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Start a re-assessment | Owner, Admin |
| Create risks, controls and tasks from the gaps | Owner, Admin, Editor |
| Assign the questions to people, and finalise the run | Owner, Admin |
| Answer questions assigned to you | The person assigned, whatever their role. Owners and Admins can also answer anyone's |

**{{ui:audits.nis2Gap.rerun}}** and the assignment panel appear only for Owners and Admins, and the list of gaps to create only for Owners, Admins and Editors.

Questions can be assigned to any member, and being assigned is what lets a person answer them: a Reader, Auditor or AI admin can submit the questions given to them.

## What it is for

Use the page to measure your NIS2 position, find the gaps that carry fines or personal liability for management, and start the work to close them. Re-run the assessment from time to time to show progress.

## What you see

**The header.** **{{ui:audits.nis2Gap.viewCoverage}}** opens the NIS2 framework's control coverage, which is a different measure: how many NIS2 requirements your controls cover. Owners and Admins also see **{{ui:audits.nis2Gap.rerun}}**.

**The scores.** Three cards for the latest run:

| Card | What it shows |
| --- | --- |
| {{ui:audits.nis2Gap.kpiReadiness}} | A weighted score from 0 to 100 |
| {{ui:audits.nis2Gap.kpiFineExposure}} | How many gaps carry a regulatory fine or liability |
| {{ui:audits.nis2Gap.kpiOpenGaps}} | How many gaps are open, and how many questions have been answered |

**{{ui:audits.nis2Gap.readinessOverTime}}.** Once there are at least two scores, a bar chart of the score over time.

**{{ui:audits.nis2Gap.maturityByDomain}}.** A radar chart with the score of each of the questionnaire's 15 domains. Until the run has answers, it reads **{{ui:audits.nis2Gap.radarEmpty}}**

**{{ui:audits.nis2Gap.histTitle}}.** Every run, newest first: whether it was the **{{ui:audits.nis2Gap.runBaseline}}** taken during onboarding or a **{{ui:audits.nis2Gap.runReassessment}}**, its score, its gaps, how many questions were answered, its status, such as {{ui:audits.nis2Gap.runStatus.COMPLETED}}, and its date.

**{{ui:audits.nis2Gap.prioritisedGaps}}.** The latest run's gaps, most urgent first:

| Column | What it shows |
| --- | --- |
| {{ui:audits.nis2Gap.gapCol}} | The question, in plain words. Questions are written in English and German, so the English text shows in other languages |
| {{ui:audits.nis2Gap.gapCrit}} | How critical the gap is: {{ui:audits.nis2Gap.crit.CRITICAL}}, {{ui:audits.nis2Gap.crit.HIGH}}, {{ui:audits.nis2Gap.crit.MEDIUM}} or {{ui:audits.nis2Gap.crit.LOW}} |
| {{ui:audits.nis2Gap.gapLiability}} | **{{ui:audits.nis2Gap.personalLiability}}** when management can be held personally liable, **{{ui:audits.nis2Gap.fineExposure}}** when it carries a fine, or another consequence, such as {{ui:audits.nis2Gap.consequence.AUDIT_FINDING}} |
| {{ui:audits.nis2Gap.gapAnswer}} | The answer given, such as {{ui:audits.nis2Gap.answer.NO}} or {{ui:audits.nis2Gap.answer.PARTIALLY}} |
| {{ui:audits.nis2Gap.gapEffort}} | How long the fix is likely to take, from {{ui:audits.nis2Gap.effort.QUICK_WIN}} to {{ui:audits.nis2Gap.effort.MONTHS}} |
| {{ui:audits.nis2Gap.gapLegalBasis}} | The article of the directive behind it |

**{{ui:audits.nis2Gap.createThese}}.** For Owners, Admins and Editors, when there are gaps to act on: one suggestion per gap, each labelled with what it would do, with its criticality, the reason and the legal basis. **{{ui:audits.nis2Gap.kind.RISK}}**, **{{ui:audits.nis2Gap.kind.TASK}}** and **{{ui:audits.nis2Gap.kind.CONTROL_CREATE}}** create one; **{{ui:audits.nis2Gap.kind.CONTROL_LINK}}** reuses an existing control.

At the bottom, the questionnaire's source and licence.

## What you can do

### Start a re-assessment

Click **{{ui:audits.nis2Gap.rerun}}**. A new run starts, and the message **{{ui:audits.nis2Gap.rerunStarted}}** Answer the questions there, or assign them to people (below). The new run joins the history.

### Assign the questions to people

While the latest run is a re-assessment that is not finished, Owners and Admins see **{{ui:audits.nis2Gap.assignTitle}}**. The questions are split into five groups, each meant for a different person: {{ui:audits.nis2Gap.respondentRole.CEO}}, {{ui:audits.nis2Gap.respondentRole.IT}}, {{ui:audits.nis2Gap.respondentRole.HR}}, {{ui:audits.nis2Gap.respondentRole.PROCUREMENT}} and {{ui:audits.nis2Gap.respondentRole.ANYONE}}. Choose a member for each group and click **{{ui:audits.nis2Gap.dispatch}}**. Each person gets a task and a notification with a link to their questions, and sees only those. Assigning a group again to the same person sends nothing new. Each group then shows its status and how many questions it holds.

The onboarding baseline cannot be assigned. While it is the latest run, the panel offers **{{ui:audits.nis2Gap.baselineDelegateAction}}** instead.

When everyone has submitted, click **{{ui:audits.nis2Gap.finalize}}** to complete the run and score it. Before then, the button reads **{{ui:audits.nis2Gap.forceFinalize}}**: it completes the run anyway, and unanswered questions count as not applicable. If a step is refused, the panel shows the reason.

### Answer your questions

Open the link in your notification, or in the task you were given. The **{{ui:audits.respond.title}}** page lists only the questions assigned to you, grouped by domain, each with its legal basis. Choose an answer for each: {{ui:audits.nis2Gap.answer.YES}}, {{ui:audits.nis2Gap.answer.PARTIALLY}}, {{ui:audits.nis2Gap.answer.NO}} or {{ui:audits.nis2Gap.answer.NA}}. Then click the submit button, which counts your answers. The message **{{ui:audits.respond.submitted}}** confirms it.

Once you have submitted, the page says **{{ui:audits.respond.alreadySubmitted}}** That holds until an Owner or Admin finalises the run. After that the page says **{{ui:audits.respond.finalized}}**, and the answers can only be read.

### Turn gaps into remediation

In **{{ui:audits.nis2Gap.createThese}}**, tick the suggestions you want, then click the create button, which counts your choice. Confirm with **{{ui:audits.nis2Gap.confirmLabel}}**. A message says how many risks, controls and tasks were created and how many were skipped because they already existed. An existing NIS2 control is reused, with a task attached, rather than created again.

## What happens next

- Created risks, controls and tasks appear on their own pages: [{{ui:risks.title}}](../govern/risks.md), [{{ui:controls.title}}](../govern/controls.md) and [{{ui:tasks.list.srTitle}}](tasks.md).
- Finalising a run adds its score to **{{ui:audits.nis2Gap.readinessOverTime}}**.
- Each assigned person's task appears in {{ui:nav.tasks}}.
- Starting, assigning, submitting and finalising are recorded in the workspace's audit log, naming who did it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.nis2Gap.loading}}** | The page is loading | Wait a moment |
| **{{ui:audits.nis2Gap.loadFailed}}** | The page could not load | Refresh the page |
| **{{ui:audits.nis2Gap.rerunFailed}}**, or the reason the server gave | The re-assessment did not start | Follow the reason given |
| **{{ui:audits.nis2Gap.applyFailed}}**, or the reason the server gave | Nothing was created | Follow the reason given, then try again |
| **{{ui:audits.nis2Gap.dispatchFailed}}**, **{{ui:audits.nis2Gap.finalizeFailed}}**, or the reason the server gave | The step was not done | Follow the reason given |
| **{{ui:audits.respond.loadFailed}}**, or a reason | Your questions did not load, for example because the assignment belongs to someone else | Open the link from your own notification |
| **{{ui:audits.respond.submitFailed}}**, or a reason | Your answers were not saved, for example because the run was finalised while you were answering | Follow the reason given |

## Related

- [{{ui:audits.title}}](audits.md), the page that links here.
- [{{ui:frameworks.list.heading}}](../govern/frameworks.md), where the NIS2 framework's control coverage is shown.
- [{{ui:incidents.title}}](../manage/incidents.md), for NIS2 incident reporting.
