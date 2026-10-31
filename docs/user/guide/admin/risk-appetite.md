---
route: /t/[tenantSlug]/admin/risk-appetite
---

# {{ui:admin.riskAppetite.title}}

The {{ui:admin.riskAppetite.title}} page records how much risk the workspace is willing to carry, as a written statement and as limits Inflect checks every day. It also lists every time a limit has been crossed.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.risk}}, click **{{ui:admin.nav.riskAppetite}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.riskAppetite.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Save the configuration, acknowledge a breach | Owner, Admin |
| Create a remediation task for a breach | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**.

## What it is for

A board sets a risk appetite: the amount of risk the organisation accepts in pursuit of its aims. This page turns that into numbers. Inflect compares the workspace's risks against them every day at 06:00 UTC, records a breach when a limit is crossed, and marks it resolved when the risks come back within it.

The money limits use annualised loss expectancy (ALE): what a risk is expected to cost in a year, from its quantified likelihood and impact. Only risks that have been quantified count towards them.

## What you see

**The status badge.** Beside the title, once a configuration is saved:

| Badge | Meaning |
| --- | --- |
| {{ui:admin.riskAppetite.statusWithin}} | Every limit is met |
| {{ui:admin.riskAppetite.statusApproaching}} | The portfolio's expected annual loss is above 80% of its ceiling |
| Breached, with a number | At least one limit is crossed; the number is how many |

After the label, the portfolio's expected loss a year, in the workspace's currency, and at the percentile it is tested at when a simulation has run (for example "P95: … a year").

**{{ui:admin.riskAppetite.configuration}}.**

| Field | What it sets |
| --- | --- |
| {{ui:admin.riskAppetite.appetiteStatement}} | The appetite in words, as the board approved it |
| {{ui:admin.riskAppetite.portfolioCeiling}} | The most the whole portfolio may be expected to lose in a year, in the workspace's currency |
| {{ui:admin.riskAppetite.singleRiskMax}} | The most any one risk may be expected to lose in a year, in the workspace's currency |
| {{ui:admin.riskAppetite.qualScoreMax}} | The highest likelihood × impact score any one risk may have |
| {{ui:admin.riskAppetite.ceilingTestedAt}} | Which point of the simulated loss range the portfolio ceiling is tested at: P50 is a typical year, P95 or P99 a severe one. Until a simulation has run, the sum of the risks' expected losses is used instead |

Leave a limit empty to not check it.

**{{ui:admin.riskAppetite.breachHistory}}.** Every breach, newest first. Each row shows **{{ui:admin.riskAppetite.active}}** or **{{ui:admin.riskAppetite.resolved}}**, and **{{ui:admin.riskAppetite.acknowledged}}** once somebody has acknowledged it; which limit was crossed ({{ui:admin.riskAppetite.breachType.PORTFOLIO_ALE}}, {{ui:admin.riskAppetite.breachType.SINGLE_RISK_ALE}}, {{ui:admin.riskAppetite.breachType.QUAL_SCORE}} or {{ui:admin.riskAppetite.breachType.CATEGORY_ALE}}); the limit and the value that crossed it, as money or, for a score, as a plain number; and the date it was found.

## What you can do

### Set the appetite

Fill in the statement and the limits, choose the percentile, and click **{{ui:admin.riskAppetite.saveConfig}}**. **{{ui:admin.riskAppetite.saved}}** confirms it. The new limits are checked at the next daily run.

Type numbers without commas or dots between thousands, such as `1000000`; spaces are fine (`1 000 000`). A limit that is not a number is marked **{{ui:admin.riskAppetite.invalidNumber}}**, and **{{ui:admin.riskAppetite.saveConfig}}** stays greyed out until it is fixed.

### Acknowledge a breach

Click **{{ui:admin.riskAppetite.acknowledge}}** on an active breach to record that you have seen it. The button gives way to **{{ui:admin.riskAppetite.acknowledged}}**. Acknowledging does not resolve the breach: only bringing the risks back within the limit does.

### Act on a breach

Click **{{ui:admin.riskAppetite.createTask}}** on an active breach. Inflect creates a task to bring the risk back within appetite and links it to the breach; the button becomes **{{ui:admin.riskAppetite.viewTask}}**, which opens the task.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| No status badge | No configuration has been saved | Fill in the configuration and save it |
| **{{ui:admin.riskAppetite.breachesEmpty}}** | No limit has been crossed since the appetite was set | Nothing |
| **{{ui:admin.riskAppetite.loadFailed}}** | The configuration did not load; nothing on the page is a default standing in for it | Click **{{ui:common.error.tryAgain}}** |
| **{{ui:admin.riskAppetite.breachesLoadFailed}}** | The breach history did not load | Reload the page |
| **{{ui:admin.riskAppetite.invalidNumber}}** under a limit | What is typed there is not a number | Type the number without separators |
| **{{ui:admin.riskAppetite.saveFailed}}**, or the reason the server gave | The configuration was not saved | Fix what it names and try again |
| The reason the server gave, or **{{ui:admin.riskAppetite.actionFailed}}** | An acknowledgement or a task was not saved | Try again |

## Related

- [{{ui:admin.nav.riskMatrix}}](risk-matrix.md), which sets the scale the score limit is measured on.
- [{{ui:nav.risks}}](../govern/risks.md), the risks the limits are checked against.
- [{{ui:nav.tasks}}](../comply/tasks.md), where remediation tasks appear.
