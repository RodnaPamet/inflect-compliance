---
route: /t/[tenantSlug]/risks/dashboard
---

# The risk dashboard

The {{ui:riskManager.dashboardTitle}} brings together everything known about your risks: how many there are and in what state, where they sit on your risk matrix, how much they could cost, how that cost is distributed, and which assessments need attention.

## Where to find it

On the **{{ui:nav.risks}}** list, click the dashboard button to the right of **{{ui:risks.viewsMenu}}**. The [{{ui:riskManager.board.title}}](risk-board.md) links here too. **{{ui:riskManager.riskRegister}}** at the top takes you back to the list.

## Who can use it

| Action | Roles |
| --- | --- |
| View the dashboard | Every role |
| Run a portfolio simulation | Owner, Admin, Editor |

## What it is for

The daily view for whoever runs the risk programme: spot the risks that need a review, see where the money is, and check that the scores and the money estimates tell the same story.

## What you see

**The counts.** **{{ui:riskManager.totalRisks}}**, **{{ui:riskManager.avgScore}}** (the average inherent score, coloured by the band it falls in on your matrix), **{{ui:riskManager.openRisks}}** (open or being mitigated) and **{{ui:riskManager.overdueReviews}}**.

**{{ui:riskManager.statusBreakdown}}.** How many risks are in each status, named as in the register.

**The heatmap.** Your risk matrix, likelihood up the side and impact along the bottom, with the number of risks in each cell. Each cell takes its colour from your matrix's bands. Hover over a cell to see its score and band.

**{{ui:riskManager.dash.quantAnalytics}}.** Shown once at least one risk has a money estimate. If a simulation has been run: a typical year (P50), the years to plan reserves for (P80 and P95), and the largest single expected loss. A percentile above your portfolio appetite ceiling, and a largest loss above your per-risk limit, are coloured as a warning; with no appetite set, they are not coloured. Below them is the sum of every risk's expected yearly loss, which ignores how risks move together. Without a simulation, the totals, the average and the largest expected loss. Then **{{ui:riskManager.dash.top10}}** and **{{ui:riskManager.dash.exposureByCat}}**.

**{{ui:risks.monteCarlo.title}}.** The portfolio simulation: the average yearly loss, the losses exceeded only 5% and 1% of the time, the spread, and a curve showing, for each amount, how likely a year's losses are to exceed it. Your appetite ceiling, if set, appears on the curve with the chance of crossing it, and the number of risks over the per-risk limit. **{{ui:risks.monteCarlo.topContributors}}** lists the five risks that contribute most; click one to open it.

**{{ui:riskManager.dash.coherenceTitle}}.** Shown once enough risks have a money estimate. It lists risks whose matrix score and money estimate disagree, for example a low score with a large expected loss, so you can check which of the two is wrong.

**{{ui:riskManager.dash.staleTitle}}.** Shown when some assessments are out of date: up to ten of them, with what made each one stale.

**{{ui:risks.velocity.title}}.** How the total expected loss moved over the last 30 days, and the risks rising and falling fastest; click one to open it.

**{{ui:riskManager.overdueReviewsTitle}}.** Up to ten risks past their review date, with how many days overdue and the treatment owner, and how many more there are.

If part of the dashboard could not be worked out, a notice at the top names the sections affected, with **{{ui:riskManager.dash.retry}}**.

## What you can do

### Run a simulation

Click **{{ui:risks.monteCarlo.run}}** in the simulation card. Only Owners, Admins and Editors see it, because a run replaces the result everyone in the workspace sees. The simulation draws 10,000 possible years from every risk's money estimate and the correlations you set. The dashboard and the [{{ui:riskManager.board.title}}](risk-board.md) both show the new figures. If the run is refused, the card says why.

### Open a risk

Click a risk in any list to open it. The stale and overdue lists, and the disagreement list, open the risk's assessment; the simulation's contributors and the fastest movers open its Quantification tab.

## What happens next

A new simulation replaces the previous one for everyone in the workspace. The other figures follow your risks as they change.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:panels.riskFirstRun.title}}** | The workspace has no risks yet | Owners, Admins and Editors create or import risks |
| **{{ui:riskManager.dash.quantEmpty}}** | No risk has a money estimate | Give risks a money estimate on their Quantification tab |
| **{{ui:risks.monteCarlo.empty}}** | No simulation has been run | Click **{{ui:risks.monteCarlo.run}}** |
| **{{ui:risks.monteCarlo.emptyReader}}** | No simulation has been run, and your role cannot run one | Ask an Owner, Admin or Editor |
| **{{ui:risks.monteCarlo.loadFailed}}** | The latest simulation could not be read | Click **{{ui:riskManager.dash.retry}}** in the notice at the top |
| **{{ui:riskManager.dash.loadErrorTitle}}** | The dashboard could not load | Click **{{ui:riskManager.dash.retry}}** |
| **{{ui:risks.monteCarlo.correlationsDropped}}** | The correlations you set contradict each other, so the simulation ignored them | Fix them on the [correlations page](risk-correlations.md) |
| **{{ui:risks.velocity.loadFailed}}** | The 30-day movement could not load | Click **{{ui:risks.velocity.retry}}** |

## Related

- [{{ui:riskManager.board.title}}](risk-board.md), the five-figure summary.
- [{{ui:risks.correlations.title}}](risk-correlations.md), which the simulation uses.
- [{{ui:risks.lossEvents.title}}](loss-events.md), where real losses are compared with the simulation.
