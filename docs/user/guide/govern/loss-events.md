---
route: /t/[tenantSlug]/risks/loss-events
---

# Loss events

A loss event is money your organisation actually lost: an incident's clean-up, a fine, a contract penalty. The {{ui:risks.lossEvents.title}} page records them, and compares what was lost with what your risk estimates predicted, so you can see whether the estimates hold up.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.lossEvents}}**. The breadcrumb reads **{{ui:risks.breadcrumbRoot}}** › **{{ui:risks.lossEvents.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View losses and the comparison | Every role |
| Record a loss | Owner, Admin, Editor |
| Remove a loss | Owner, Admin |

## What it is for

Check your money estimates against reality. A model that keeps most risks at or under their pessimistic estimate is believable; one that is often beaten needs its inputs looked at again.

## What you see

**{{ui:risks.lossEvents.predictedVsActual}}.** **{{ui:risks.lossEvents.totalLosses}}**, **{{ui:risks.lossEvents.lossEventsStat}}** and **{{ui:risks.lossEvents.calendarYears}}**, then a bar per year with its total and number of losses. If a portfolio simulation has been run, a line below gives its yearly prediction.

**{{ui:risks.lossEvents.calibrationTitle}}.** Shown once some losses are linked to risks that have a simulated estimate. It shows how many risks stayed within their pessimistic (P90) estimate, how many were beaten, and how many were scored. Each risk is listed with its status and its actual loss against its typical (P50) and pessimistic (P90) estimates. For a risk that missed, **{{ui:risks.lossEvents.reestimate}}** opens its Quantification tab.

**{{ui:risks.lossEvents.recordLoss}}**, for roles that can: **{{ui:risks.lossEvents.date}}**, **{{ui:risks.lossEvents.amount}}**, **{{ui:risks.lossEvents.whatHappened}}**, **{{ui:risks.lossEvents.riskLabel}}**, and where the loss came from: entered by hand, from a finding or from an incident.

**{{ui:risks.lossEvents.register}}.** The latest 50 losses, newest first: date, source, amount and description.

## What you can do

### Record a loss

Fill in the date, the amount and what happened, link the risk it belongs to, and click **{{ui:risks.lossEvents.record}}**. Linking a risk is what lets the comparison score that risk's estimate.

### Remove a loss

Owners and Admins click **{{ui:risks.lossEvents.remove}}** on a loss in the register. It is removed at once.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.lossEvents.emptyActuals}}** | No loss has been recorded yet | Record one |
| **{{ui:risks.lossEvents.emptyRegister}}** | The register is empty | Record a loss |
| **{{ui:risks.lossEvents.loadError}}** | The register could not load | Reload the page |
| **{{ui:risks.lossEvents.saveFailed}}** | The loss was not recorded or removed | Try again |

## Related

- [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md), where the simulation the comparison uses is run.
- [A risk](risk-detail.md), whose Quantification tab holds the inputs to re-estimate.
