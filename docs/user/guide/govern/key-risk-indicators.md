---
route: /t/[tenantSlug]/risks/kri
---

# Key risk indicators

A key risk indicator (KRI) is a figure you measure regularly that warns you a risk is getting worse, for example the share of staff who click a phishing test or the number of unpatched servers. The {{ui:risks.kri.title}} page is where you define your indicators, record their readings and see which have crossed their thresholds.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.kri}}**. The breadcrumb reads **{{ui:risks.breadcrumbRoot}}** › **{{ui:risks.kri.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View indicators and their readings | Every role |
| Create an indicator, record a reading, edit, deactivate or delete an indicator | Owner, Admin, Editor |

## What it is for

Give each important risk an early warning. When a reading crosses a threshold, the indicator turns amber or red, and a red reading on an indicator linked to a risk prompts you to reassess that risk.

## What you see

**{{ui:risks.kri.newKri}}**, for roles that can create one: **{{ui:risks.kri.name}}**, **{{ui:risks.kri.unit}}**, the two thresholds **{{ui:risks.kri.greenMax}}** and **{{ui:risks.kri.amberMax}}**, **{{ui:risks.kri.target}}**, **{{ui:risks.kri.riskLabel}}**, **{{ui:risks.kri.directionLabel}}**, **{{ui:risks.kri.frequencyLabel}}**, **{{ui:risks.kri.ownerLabel}}** and **{{ui:risks.kri.descriptionLabel}}**.

**The indicators.** One card each, with:

- its name, and **{{ui:risks.kri.inactive}}** if it has been switched off;
- its latest reading with its colour, or **{{ui:risks.kri.noData}}**;
- a small trend line of recent readings;
- its target, how often it is measured and its thresholds.

When the latest reading is red and the indicator is linked to a risk, **{{ui:risks.kri.reassess}}** opens that risk's assessment.

## What you can do

### Create an indicator

Fill in at least a name, set the thresholds and the direction, and click **{{ui:risks.kri.create}}**. **{{ui:risks.kri.directionLabel}}** says which way is bad: **{{ui:risks.kri.dirHigherWorse}}** for most figures, **{{ui:risks.kri.dirLowerWorse}}** for figures like patch coverage.

### Record a reading

On an indicator's card, type the value under **{{ui:risks.kri.recordReading}}** and click **{{ui:risks.kri.add}}**. The reading is coloured against the thresholds. If it is worse than the previous one and the indicator is linked to a risk, a remediation task may be created for that risk; a message tells you when it is.

### Edit, deactivate or delete an indicator

Use **{{ui:risks.kri.edit}}**, **{{ui:risks.kri.deactivate}}** (or **{{ui:risks.kri.activate}}**) and **{{ui:risks.kri.delete}}** at the bottom of its card. Deleting an indicator removes all its readings and cannot be undone.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.kri.empty}}** | The workspace has no indicators | Owners, Admins and Editors create one |
| **{{ui:risks.kri.loadError}}** | The indicators could not load | Reload the page |
| **{{ui:risks.kri.saveError}}** | The last change was not saved | Try again |

## Related

- [{{ui:risks.title}}](risks.md), where the risks an indicator watches live.
- [A risk](risk-detail.md), where a red indicator sends you to reassess.
