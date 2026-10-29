---
route: /t/[tenantSlug]/dashboard
---

# {{ui:dashboard.title}}

The {{ui:dashboard.title}} is the workspace's home page. It sums up where compliance stands across every framework: a posture headline, six headline figures, status charts, a month of trends, the next thing to fix and, for roles that can read the audit log, the latest activity.

## Where to find it

Click **{{ui:nav.dashboard}}** at the top of the sidebar, above **{{ui:nav.govern}}**. Inflect also opens this page when you sign in. The page title reads **{{ui:dashboard.title}}**, with **{{ui:dashboard.subtitle}}** under it.

## Who can use it

| Action | Roles |
| --- | --- |
| View the dashboard and follow its links | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Click **{{ui:dashboard.hero.regenerate}}** on the posture summary | Owner, Admin, Editor |
| See the **{{ui:dashboard.recentActivity}}** card | Owner, Admin, Auditor: the roles that can read the audit log |
| See the **{{ui:dashboard.addRisk}}**, **{{ui:dashboard.addEvidence}}** and **{{ui:dashboard.newPolicy}}** links | Owner, Admin, Editor: each link only for a role that can create that record |
| See the **{{ui:onboarding.banner.title}}** card | Owner, Admin, until the setup wizard is complete |
| See the **{{ui:agents.dashboardWidget.title}}** card | Owner, Admin, AI admin, once the workspace has registered an agent |

Every figure counts the whole workspace, whatever your role. A link can lead to a page where your role can look but not change anything.

If your workspace uses custom roles, **{{ui:dashboard.hero.regenerate}}** needs permission to edit controls, and the **{{ui:agents.dashboardWidget.title}}** card needs permission to manage the agent register. A quick-add link needs permission to create that record, on a custom role based on a role that can edit. The setup card and the **{{ui:dashboard.recentActivity}}** card follow the built-in role your custom role is based on.

## What it is for

Use the dashboard to see at a glance how far the workspace is from audit-ready, which area holds it back, and what to do next. Each figure links to the list behind it, so the dashboard is also the quickest way into the work.

## What you see

**{{ui:onboarding.banner.title}}.** While the setup wizard is unfinished, Owners and Admins see this card at the top. **{{ui:onboarding.banner.continue}}** opens the wizard.

**The posture summary.** The top card, headed **{{ui:dashboard.hero.eyebrow}}**, rates six areas of the workspace and shows the result as a level from 1 to 5:

- On the right, a radar chart draws one spoke per area, and a list gives each area's count of healthy items out of its total, and its level, such as **L3**. An area the workspace does not use yet reads **{{ui:dashboard.hero.ladderNoEstate}}** and is left off the chart.
- The headline is the name of the overall level, for example **{{ui:dashboard.hero.ladder.defined}}**, followed by the number and **{{ui:dashboard.hero.levelOfSuffix}}**. A line below names the area that sets it.
- A short written summary follows, with a list of next steps, and a last bullet that names the next weakest area. Depending on how your Inflect installation is set up, the summary is written by an AI model or by fixed rules.

| Area | Healthy items, out of |
| --- | --- |
| {{ui:dashboard.hero.radarAxes.controls}} | Implemented controls, out of every control that has not been scoped out |
| {{ui:dashboard.hero.radarAxes.evidence}} | Approved evidence not past its review date, out of that plus unapproved evidence past its review date |
| {{ui:dashboard.hero.radarAxes.risk}} | Open risks scoring below 10, out of every open risk. Closed and accepted risks are left out |
| {{ui:dashboard.hero.radarAxes.policies}} | Policies not past their review date, out of every policy |
| {{ui:dashboard.hero.radarAxes.tasks}} | Tasks that are finished or not past their due date, out of every task |
| {{ui:dashboard.hero.radarAxes.vendors}} | Vendors not past their review date, out of every vendor |

An area's level comes from its share of healthy items: below half is 1, **{{ui:dashboard.hero.ladder.initial}}**; half or more is 2, **{{ui:dashboard.hero.ladder.developing}}**; 75% is 3, **{{ui:dashboard.hero.ladder.defined}}**; 90% is 4, **{{ui:dashboard.hero.ladder.managed}}**. Level 5, **{{ui:dashboard.hero.ladder.optimising}}**, needs every item healthy. The overall level is the lowest area's level, not an average.

Until a summary has been written for the workspace, the card shows the share of implemented controls in large type instead, with the level line under it and the same chart.

**Headline cards.** Six cards follow. Click a card to highlight the chart that belongs to it and dim the others; click it again to clear. The small arrow in a card's top-right corner opens its list.

| Card | What it shows | The arrow opens |
| --- | --- | --- |
| {{ui:dashboard.controls}} | The share of controls implemented, and how many out of how many | {{ui:nav.controls}} |
| {{ui:dashboard.risks}} | Every risk, and how many open risks score 10 or more: the High and Critical bands of **{{ui:dashboard.riskDistribution}}** | {{ui:nav.risks}} |
| {{ui:dashboard.evidence}} | Every piece of evidence, and how many are overdue for review | {{ui:nav.evidence}} |
| {{ui:dashboard.openTasks}} | Tasks that are not resolved, closed or canceled, and how many are past due | {{ui:nav.tasks}}, filtered to those tasks |
| {{ui:dashboard.policies}} | Every policy, and how many are published | {{ui:nav.policies}} |
| {{ui:dashboard.openFindings}} | Findings that are not closed | The {{ui:findings.title}} |

Four cards carry a 30-day trend line once the workspace has two days of history. The line under {{ui:dashboard.risks}} follows open risks, and the one under {{ui:dashboard.evidence}} follows overdue evidence.

**{{ui:dashboard.customKpi.title}}.** A card you set yourself: choose a metric from the list at its top right. Your choice is remembered in your browser and starts on {{ui:dashboard.customKpi.assets}}. The card shows the metric's total and a pie chart of its parts. For {{ui:dashboard.customKpi.assets}}, a third panel draws the total's 30-day trend once two days of history exist. Inflect keeps no daily history of the other metrics, so they have no trend panel. Clicking the pie or a row beside it opens the metric's list.

| Metric | What it counts | Opens |
| --- | --- | --- |
| {{ui:dashboard.customKpi.assets}} | Assets, split into active, retired and other | {{ui:nav.assets}} |
| {{ui:dashboard.customKpi.audits}} | Audit cycles, by status | {{ui:audits.cycles.title}} |
| {{ui:dashboard.customKpi.tests}} | Control test runs, by result | {{ui:nav.tests}} |
| {{ui:dashboard.customKpi.evidence}} | Evidence overdue for review, due within 7 days, due in 8 to 30 days, and current: approved, with no review due in the next 30 days. Each piece of evidence is counted once | {{ui:nav.evidence}} |
| {{ui:dashboard.customKpi.exceptions}} | Control exceptions: approved, expiring soon, waiting for approval, and expired | {{ui:nav.controls}} |
| {{ui:dashboard.customKpi.treatmentPlans}} | Risk treatment plans on track, overdue and completed | {{ui:nav.risks}} |

**Status charts.** Four cards, in two rows. Click a slice of a pie, or its row in the legend, to open the list filtered to it.

- **{{ui:dashboard.controlCoverage}}**: a bar of implemented, in-progress and not-started controls, with a trend line once history exists.
- **{{ui:dashboard.riskDistribution}}**: open risks by score, Critical 15 to 25, High 10 to 14, Medium 5 to 9 and Low 1 to 4, and the count of open and mitigating risks beside **{{ui:dashboard.openMitigating}}**. Closed and accepted risks are in no band.
- **{{ui:dashboard.taskStatus}}**: tasks that are open, in progress, in review, blocked, and resolved, closed or canceled. Every task is in one slice.
- **{{ui:dashboard.policyStatus}}**: policies by status.

**{{ui:agents.dashboardWidget.title}}.** For Owners, Admins and AI admins, once an agent is registered. It counts the registered agents by status and warns when a kill switch is stopping agents, when an active agent has no assessed authority tier, when the workspace does not require agents to be registered, and when agent proposals are waiting for a decision or agent runs are under way. With no kill switch in force, no unscored active agent and registration enforced, it reads **{{ui:agents.dashboardWidget.clear}}** The **{{ui:agents.dashboardWidget.viewRegister}}** link opens the register.

**{{ui:dashboard.complianceTrends}}.** Four 30-day trend lines: **{{ui:dashboard.coverage}}**, **{{ui:dashboard.openRisks}}**, **{{ui:dashboard.overdueEvidenceLabel}}** and **{{ui:dashboard.openFindings}}**, with the number of days of history in the corner.

**The next step.** A card recommends one thing to do, the first that applies: refresh overdue evidence, resolve overdue tasks, review open risks scoring 10 or more, improve control coverage while it is under 80%, and otherwise run a readiness check. Its button opens the page for that work. Below it, **{{ui:dashboard.addRisk}}** and **{{ui:dashboard.newPolicy}}** open the {{ui:nav.risks}} and {{ui:nav.policies}} lists with the form for a new one already open, and **{{ui:dashboard.addEvidence}}** opens the {{ui:nav.evidence}} list with its menu of ways to add evidence. Each link appears only for a role that can create that record.

**{{ui:dashboard.recentActivity}}.** For Owners, Admins and Auditors, the roles that can read the audit log. The ten latest entries in the workspace's audit log: when, who, what they did and to which item. The item is a link when it has its own page. Changes made by Inflect itself are shown as **{{ui:dashboard.activity.systemActor}}**.

## What you can do

### Follow a figure to its list

Click a card's arrow, a slice of a pie, a legend row or the next-step button. The list opens filtered where the dashboard knows how: tasks and policies by status, and risks by score range and open status. The next-step button opens evidence past its review date, overdue tasks, or open risks scoring 10 or more. The custom metric's pie opens its page unfiltered.

### Refresh the posture summary

Owners, Admins and Editors see **{{ui:dashboard.hero.regenerate}}** in the top-right corner of the posture card. Click it. It reads **{{ui:dashboard.hero.regenerating}}** while Inflect writes a new summary, and the card then shows it. If the refresh fails, the card keeps the old summary and says why under **{{ui:dashboard.hero.eyebrow}}**.

## What happens next

- Inflect writes the posture summary for every active workspace once a day, at 05:30 UTC. **{{ui:dashboard.hero.regenerate}}** writes one straight away.
- Trend lines come from a snapshot Inflect takes each day at 05:00 UTC. They appear once two days of snapshots exist.
- The figures are worked out when the page loads. Coming back to the browser tab refreshes them in the background.
- Apart from **{{ui:dashboard.hero.regenerate}}**, nothing on the dashboard changes anything. Every change happens on the page a link opens.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| The share of implemented controls in place of the posture summary | No summary has been written for the workspace yet | Wait for the daily run, or click **{{ui:dashboard.hero.regenerate}}** if your role has it |
| No radar chart and no level, and a one-word headline such as **{{ui:dashboard.hero.postureLabel.AT_RISK}}** | The workspace has no controls, evidence, risks, policies, tasks or vendors yet, so there is nothing to rate | Add records; the chart appears with them |
| **{{ui:dashboard.trendsEmpty}}** | Fewer than two daily snapshots exist | Come back after two snapshots have run |
| **{{ui:dashboard.customKpi.noData}}** | The chosen metric has nothing to count | Choose another metric |
| **{{ui:dashboard.noRecentActivity}}** | The audit log has no entries yet | Nothing to do |
| A message under **{{ui:dashboard.hero.eyebrow}}** after **{{ui:dashboard.hero.regenerate}}** | The refresh failed or was refused, for the reason the message gives. The previous summary stays | Try again later |
| No **{{ui:dashboard.recentActivity}}** card | Your role cannot read the audit log | Nothing to do |
| No **{{ui:agents.dashboardWidget.title}}** card | Your role cannot manage the agent register, or no agent is registered | Nothing to do |
| **{{ui:common.error.title}}** | The dashboard could not load | Click **{{ui:common.error.tryAgain}}** |

## Related

- [{{ui:risks.title}}](../govern/risks.md), [{{ui:controls.list.pageTitle}}](../govern/controls.md), [{{ui:tasks.list.srTitle}}](../comply/tasks.md) and [{{ui:evidence.title}}](../comply/evidence.md), the lists the headline cards open.
- [{{ui:findings.title}}](../comply/findings.md), behind the **{{ui:dashboard.openFindings}}** card.
- [{{ui:audits.title}}](../comply/audits.md), where audits, cycles and readiness live.
- [Add a framework](../../how-to/get-started/add-a-framework.md), which also covers the setup wizard behind **{{ui:onboarding.banner.continue}}**.
