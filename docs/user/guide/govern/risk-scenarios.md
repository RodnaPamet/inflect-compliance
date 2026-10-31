---
route: /t/[tenantSlug]/risks/scenarios
---

# Risk scenarios

A scenario is a "what if": what would your yearly losses look like if a control cut the chance of one risk, or a new system raised the cost of another? The {{ui:risks.scenarios.title}} page lets you describe such a change, simulate it, and compare it with today.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.scenarios}}**. The breadcrumb reads **{{ui:risks.breadcrumbRoot}}** › **{{ui:risks.scenarios.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View scenarios | Every role |
| Create, simulate, copy or archive a scenario | Owner, Admin, Editor |

## What it is for

Test an investment before you make it. A scenario with its cost tells you how much loss the change removes and what return that gives.

## What you see

**{{ui:risks.scenarios.newScenario}}**, for roles that can create one: **{{ui:risks.scenarios.name}}**, **{{ui:risks.scenarios.investment}}** and **{{ui:risks.scenarios.overridesTitle}}**. Each override changes one input of one risk's money estimate: pick the risk, the input and its new value, then click **{{ui:risks.scenarios.addOverride}}**.

**The scenarios.** Each with its status, its name, its investment and, once simulated, its return on investment.

**{{ui:risks.scenarios.baselineVsScenario}}**, after a simulation: the average yearly loss and the losses exceeded only 5% and 1% of the time, today and under the scenario, with the difference, and the return on investment. **{{ui:risks.scenarios.perRiskImpact}}** shows how each risk's expected loss moves.

## What you can do

### Create a scenario

Give it a name, the investment if it has a cost, and the overrides it makes, then click **{{ui:risks.scenarios.create}}**.

### Simulate it

Click **{{ui:risks.scenarios.simulate}}** on a scenario. Two simulations run, today's and the scenario's, and the comparison appears below the list.

### Copy or archive a scenario

**{{ui:risks.scenarios.clone}}** makes a copy you can change. **{{ui:risks.scenarios.archive}}** puts it away; an archived scenario stays listed and can still be copied, but no longer simulated.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.scenarios.empty}}** | The workspace has no scenarios | Owners, Admins and Editors create one |
| **{{ui:risks.scenarios.loadError}}** | The scenarios could not load | Reload the page |
| **{{ui:risks.scenarios.saveError}}** | The last change was not saved | Try again |
| **{{ui:risks.scenarios.correlationsDropped}}** | The correlations you set contradict each other, so the simulations ignored them | Fix them on the [correlations page](risk-correlations.md) |

## Related

- [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md), where today's simulation lives.
- [A risk](risk-detail.md), whose Quantification tab holds the inputs a scenario overrides.
