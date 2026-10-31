---
route: /t/[tenantSlug]/risks/board
---

# The risk board

The {{ui:riskManager.board.title}} gives the short version of your risk programme, the one you would take to a board meeting. It answers five questions: how much you stand to lose in a year, whether that is within the limit you set, which risks drive it, which controls give the most for their cost, and how much of the register is out of date.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.board}}**. **{{ui:riskManager.board.operationalDashboard}}** at the top of the board opens the [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md).

## Who can use it

Every role can open the board. It only shows figures; nothing on it changes your data.

## What it is for

Show the state of the programme in five figures, without the detail of the dashboard. Each card says plainly when it has nothing to show, rather than showing a zero.

## What you see

**{{ui:riskManager.board.position}}.** The loss you should plan reserves for: the 80th-percentile year from the latest portfolio simulation, roughly the worst year in five. It is coloured by the appetite below, and stays uncoloured when no ceiling is set. Until a simulation has been run on the dashboard, the card says the figure is not available yet.

**{{ui:riskManager.board.appetite}}.** Whether that loss is **{{ui:riskManager.board.within}}**, **{{ui:riskManager.board.approaching}}** or **{{ui:riskManager.board.breached}}**, measured against the portfolio loss ceiling your workspace set, and the ceiling itself. With no ceiling set, it reads **{{ui:riskManager.board.noAppetite}}**; an Owner or Admin also sees **{{ui:riskManager.board.setAppetite}}**, which opens the risk appetite settings.

**{{ui:riskManager.board.topContributors}}.** The five risks with the largest expected yearly loss, largest first. Click one to open its Quantification tab, where that figure comes from.

**{{ui:riskManager.board.bestValue}}.** The three controls whose cost buys the most reduction in expected loss, with how many times their cost they return. A control appears here only when it has a cost, an effectiveness and at least one linked risk with a money estimate. Click one to open it.

**{{ui:riskManager.board.hygiene}}.** How many risks carry an assessment that is out of date: past its review date, untouched for too long, or overtaken by newer control tests. When none is out of date, it reads **{{ui:riskManager.board.hygieneAllFresh}}**.

## What you can do

- Click a risk or a control to open it.
- Click **{{ui:riskManager.board.operationalDashboard}}** for the full dashboard, where you can run a new simulation.

## What happens next

The board reads the same figures as the dashboard. When someone runs a new simulation, records a new assessment or prices a control, the board shows the change the next time it is opened.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:riskManager.board.positionEmpty}}** | No portfolio simulation has been run | Run one on the dashboard |
| **{{ui:riskManager.board.appetiteEmpty}}** | Your workspace has no portfolio loss ceiling | An Owner or Admin clicks **{{ui:riskManager.board.setAppetite}}** |
| **{{ui:riskManager.board.topEmpty}}** | No risk has a money estimate yet | Give risks a money estimate on their Quantification tab |
| **{{ui:riskManager.board.bestValueEmpty}}** | No control has a cost, an effectiveness and a linked risk with a money estimate | Price your most important controls |
| **{{ui:riskManager.board.bestValueError}}** | The best-value controls could not load | Click **{{ui:riskManager.board.retry}}** |
| **{{ui:riskManager.board.loadErrorTitle}}** | The board's figures could not load | Click **{{ui:riskManager.board.retry}}** |

## Related

- [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md), the full analyst view.
- [{{ui:risks.title}}](risks.md), the register.
- [A risk](risk-detail.md), where a risk is assessed and quantified.
