---
route: /t/[tenantSlug]/risks/[riskId]
---

# A risk

A risk's page is where you work on one risk: assess how likely and how serious it is, decide how to treat it, put a money figure on it, and link the controls, tasks and evidence that reduce it.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}** and click a risk's title. The breadcrumb reads **{{ui:risks.detail.bcDashboard}}** › **{{ui:risks.detail.bcRisks}}** › the risk's title. Arrows beside the title step to the previous or next risk in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the risk and every tab | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Change the status, edit the risk, save an assessment or a quantification | Owner, Admin, Editor |
| Link controls, assets, tasks and evidence | Owner, Admin, Editor |
| Complete a treatment plan | Owner, Admin |

If your workspace uses custom roles, the page offers only what your role's permissions allow.

## What it is for

Keep everything about one risk together, so that anyone can see how bad it is before and after your controls, what you have decided to do about it, who is doing it and by when.

## What you see

**The header.** The risk's title, then **{{ui:risks.detail.status}}**, **{{ui:risks.detail.inherentScore}}** with its band from your risk matrix, and, when the risk has been quantified, its **{{ui:risks.detail.ale}}**: the loss you expect from it in a year. Click the score to see how it was worked out, or the ALE to open the quantification. **{{ui:risks.detail.owner}}**, **{{ui:risks.detail.assignedTo}}** and **{{ui:risks.detail.nextReview}}** follow when they are set. The review date turns red once it has passed.

On the right: **Where used**, which lists the process maps that refer to the risk, and, if you can edit, the status picker.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:risks.detail.tabOverview}}** | The risk's description and fields, and its inherent score |
| **{{ui:risks.detail.tabAssessment}}** | A guided assessment: likelihood and impact before and after controls, the treatment decision, the treatment plan and the review cadence |
| **{{ui:risks.detail.tabQuantification}}** | A FAIR analysis that turns the risk into a yearly loss in money |
| **{{ui:risks.detail.tabBowtie}}** | A bow-tie diagram: what causes the risk, what it leads to, and the controls on each side |
| **{{ui:risks.detail.tabHistory}}** | How the score and the yearly loss have moved over time |
| **{{ui:risks.detail.tabTasks}}** | The tasks linked to the risk |
| **{{ui:risks.detail.tabEvidence}}** | **{{ui:risks.detail.attachedEvidence}}**, and the evidence **{{ui:risks.detail.inheritedFromControls}}** |
| **{{ui:risks.detail.tabTraceability}}** | The controls and assets linked to the risk, the requirements and test plans it inherits through those controls, and linked vendors |

**The overview.** **{{ui:risks.detail.description}}**, **{{ui:risks.detail.category}}**, **{{ui:risks.detail.treatmentOwner}}**, **{{ui:risks.detail.treatment}}** and **{{ui:risks.detail.targetDate}}**, then the **{{ui:risks.detail.inherentRiskScore}}**: **{{ui:risks.detail.likelihood}}** **{{ui:risks.detail.impactTimes}}**. Below that, **{{ui:risks.detail.threat}}**, **{{ui:risks.detail.vulnerability}}**, **{{ui:risks.detail.treatmentNotes}}** and **{{ui:risks.detail.created}}**.

## What you can do

### Change the status

Choose a status from the picker in the header. The assessment also suggests a status from your treatment decision, with a button to apply it.

### Edit the risk

Click the pencil at the top of the overview to change the title, description, category, threat, vulnerability, likelihood, impact, owner and dates.

### Assess the risk

On **{{ui:risks.detail.tabAssessment}}**, work down the steps:

1. Rate **{{ui:risks.assessment.likelihood}}** and **{{ui:risks.assessment.impact}}** before controls.
2. Rate them after controls. The page suggests a residual score from the controls linked to the risk, which you can accept or set yourself.
3. Choose a treatment decision, and fill in the treatment plan: who does what, by when.
4. Set how often the risk is reviewed.

Each step saves on its own.

### Quantify the risk

On **{{ui:risks.detail.tabQuantification}}**, enter the FAIR estimates, as a low, likely and high value each: how often the threat occurs, how vulnerable you are, and what a loss would cost. Click **{{ui:risks.fair.save}}**. The page warns, without blocking the save, about values that look wrong, such as a probability above 1.

### Link controls, assets, tasks and evidence

On **{{ui:risks.detail.tabTraceability}}**, link the controls that reduce the risk and the assets it affects. On **{{ui:risks.detail.tabTasks}}**, create or link tasks. On **{{ui:risks.detail.tabEvidence}}**, attach evidence to the risk itself. Evidence on the linked controls shows below it without being attached twice.

## What happens next

- The score and status show on the risk register, the heat map and the dashboard.
- A review date that passes shows the risk as overdue for review on the register.
- Each saved assessment or quantification adds a point to **{{ui:risks.detail.tabHistory}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.detail.notFound}}** | The risk does not exist, was deleted, or is in another workspace | Go back to the register |
| **{{ui:risks.detail.untreated}}** under **{{ui:risks.detail.treatment}}** | No treatment decision has been made | Make one on **{{ui:risks.detail.tabAssessment}}** |
| **{{ui:risks.history.empty}}** | The risk has not been assessed or quantified yet | Save an assessment |
| **{{ui:risks.history.loadFailed}}** | The history could not load | Click **{{ui:risks.history.retry}}** |
| A red message above the tabs | The status or an edit was refused; the message gives the reason | Follow the reason given, then try again |
| **{{ui:risks.fair.saveFailed}}** | The quantification was not saved | Try again |
| Warnings under the FAIR inputs | A value looks out of range. The warnings are in English and name the input by its internal name | Check the value; you can still save |

## Related

- [{{ui:risks.title}}](risks.md), the risk register.
- [{{ui:controls.list.pageTitle}}](controls.md), where the controls that treat a risk live.
- [{{ui:assets.title}}](assets.md), the assets a risk can affect.
