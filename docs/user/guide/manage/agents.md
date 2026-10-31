---
route: /t/[tenantSlug]/agents
---

# {{ui:agents.register.title}}

The {{ui:agents.register.title}} lists every autonomous agent this workspace runs. For each one it shows the four things that decide how much authority the agent may hold: how autonomous it is, how far into your data it reaches, how hard its actions are to undo, and who wrote it. It is also where a new agent is registered.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar. The entry appears only for roles that can read the agent register. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the register, its notices and its summary cards | Owner, Admin, AI admin, Auditor |
| Open an agent's own page | Owner, Admin, AI admin, Auditor |
| Register an agent | Owner, Admin, AI admin |
| Set the concurrent-run cap and the monthly token budget | Owner, Admin, AI admin |
| Choose the agent that answers questions on {{ui:nav.agentsAsk}} | Owner, Admin, AI admin, on the agent's own page |

Editors and Readers do not see the sidebar entry, and opening the page shows **{{ui:agents.register.accessTitle}}**. Auditors get the same page with every change withheld: no **{{ui:agents.register.addAgent}}** button, and the cap and the budget shown as sentences without a form.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. A change to the register is accepted only from a member whose built-in role in the workspace is Owner, Admin or AI admin, so a custom role that may manage the register is not offered its buttons when it is held on an Editor, Reader or Auditor membership. A role that cannot see vendors finds the supplier field disabled when registering a third-party agent.

The **{{ui:common.ui.viewsMenu}}** menu lists only the agent pages your role can open, so it differs by role.

## What it is for

Use the register to answer two questions: which agents may act in this workspace, and who answers for each one. Every agent has an accountable owner, and a person assesses its risk before it may act. When the workspace enforces registration, a credential an agent uses is refused unless it names an agent that is active here.

## What you see

**The notices.** Above the cards, in this order:

- **Whether registration is enforced.** A warning when it is not: the register is then a record only, and suspending an agent here stops nothing. A warning naming the credentials that are bound to no agent, when registration is enforced and some are; each of them is refused. Otherwise a blue note that registration is enforced.
- **{{ui:agents.register.assurance.heading}}.** How many registered agents have an assessed risk tier, how often a second reviewer disagreed with a sampled approval over the last 90 days, and the latest result of four scheduled agent checks, as **{{ui:controlTests.result.PASS}}**, **{{ui:controlTests.result.FAIL}}** or **{{ui:controlTests.result.INCONCLUSIVE}}**. An inconclusive check is shown as a warning rather than a failure: it could not decide. A check that has never run reads **{{ui:agents.register.assurance.checkNeverRun}}**. Retired agents are left out of the coverage line.
- **{{ui:agents.register.concurrency.heading}}.** How many agent runs may execute at once, and how many are running now.
- **{{ui:agents.register.budget.heading}}.** How many tokens agent runs may use in a calendar month (UTC), and how many have been used this month.

**Summary cards.** Four cards sit above the table:

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:agents.register.kpi.total}} | Every agent on the register, whatever the filters | Clears every filter |
| {{ui:agents.register.kpi.active}} | {{ui:agents.register.filterEnums.status.ACTIVE}} agents that match your other filters | Filters to {{ui:agents.register.filterEnums.status.ACTIVE}} |
| {{ui:agents.register.kpi.unscored}} | Agents nobody has scored, among those matching your other filters. Shown in red when it is not zero | Filters to {{ui:agents.register.filterEnums.riskTier.UNSCORED}} |
| {{ui:agents.register.kpi.egress}} | Agents that can send data outside the workspace, among those matching your other filters | Filters to {{ui:agents.register.filterEnums.accessScope.EXTERNAL_EGRESS}} |

**The toolbar.** From left to right:

- **{{ui:agents.register.addAgent}}** opens the registration form. Only roles that can register agents see it.
- The **{{ui:common.ui.filter}}** button holds the filters: {{ui:agents.register.filters.status}}, {{ui:agents.register.filters.accessScope}} and {{ui:agents.register.filters.riskTier}}. You can pick several values in each, and each active filter shows as a pill beside the button. The search box, **{{ui:agents.register.searchPlaceholder}}**, narrows the list to the agents whose name contains what you type. The summary cards other than **{{ui:agents.register.kpi.total}}** count within your search as well as your filters.
- **{{ui:common.ui.viewsMenu}}** opens the other agent pages, in two groups. **{{ui:agents.views.groupOperate}}** holds {{ui:agents.views.compose}}, {{ui:agents.views.proposals}} (with a count of proposals waiting), {{ui:agents.views.runs}} and {{ui:agents.views.ownerOrphanPass}}. **{{ui:agents.views.groupAssurance}}** holds {{ui:agents.views.receipts}}, {{ui:agents.views.quarantine}}, {{ui:agents.views.decisions}}, {{ui:agents.views.reports}}, {{ui:agents.views.auditPilot}}, {{ui:agents.views.reviewQuality}}, {{ui:agents.views.externalTools}} and {{ui:agents.views.peers}}.
- A settings button chooses which summary cards are shown. The page remembers your choice.

Filters and the search are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who can read the register.

**The table.** Newest agents come first. Click a row to open the agent's own page.

| Column | What it shows |
| --- | --- |
| {{ui:agents.register.colAgent}} | The agent's name, and below it its accountable owner's name, or their email address when they have no name |
| {{ui:agents.register.colStatus}} | {{ui:agents.register.filterEnums.status.DRAFT}}, {{ui:agents.register.filterEnums.status.ACTIVE}}, {{ui:agents.register.filterEnums.status.SUSPENDED}} or {{ui:agents.register.filterEnums.status.RETIRED}}. While registration is enforced, only an active agent may act |
| {{ui:agents.register.colAutonomy}} | Its autonomy level, from 0 (it only suggests) to 6 (it acts unattended across systems) |
| {{ui:agents.register.colAccess}} | How far into your data it reaches, from {{ui:agents.register.filterEnums.accessScope.NONE}} to {{ui:agents.register.filterEnums.accessScope.EXTERNAL_EGRESS}} |
| {{ui:agents.register.colReversibility}} | {{ui:agents.register.reversibility.REVERSIBLE}}, {{ui:agents.register.reversibility.COMPENSABLE}} or {{ui:agents.register.reversibility.TERMINAL}} |
| {{ui:agents.register.colTier}} | Its assessed authority: {{ui:agents.register.filterEnums.riskTier.LOW}}, {{ui:agents.register.filterEnums.riskTier.MODERATE}}, {{ui:agents.register.filterEnums.riskTier.HIGH}} or {{ui:agents.register.filterEnums.riskTier.CRITICAL}}. **{{ui:agents.register.unscored}}** means nobody has assessed it, and it then reaches nothing |
| {{ui:agents.register.colAiAct}} | The EU AI Act tier of the AI system it belongs to, and the clause that decided it. This is a different scale from the authority tier |
| {{ui:agents.register.colKeys}} | How many API keys are bound to the agent, revoked and expired ones included |

## What you can do

### Register an agent

Click **{{ui:agents.register.addAgent}}**. The **{{ui:agents.register.new.title}}** form asks for:

- **{{ui:agents.register.new.nameLabel}}**, at least two characters, and optionally **{{ui:agents.register.new.descriptionLabel}}**.
- **{{ui:agents.register.new.ownerLabel}}**, chosen from the workspace's active members.
- **{{ui:agents.register.new.autonomyLabel}}**, **{{ui:agents.register.new.accessLabel}}**, **{{ui:agents.register.new.reversibilityLabel}}** and **{{ui:agents.register.new.provenanceLabel}}**. Each starts on its least exposing choice.
- **{{ui:agents.register.new.vendorLabel}}**, for a third-party agent only. A third-party agent must name the vendor that supplies it, and the form says so before sending if you leave it empty. The list opens on your first vendors; type part of a name to search all of them.
- **{{ui:agents.register.new.classificationHeading}}**: three lists, for a prohibited practice, a high-risk area and a transparency case, and a box to tick when the agent is a safety component of a regulated product. Each list starts on {{ui:agents.register.new.noneApplicable}}. Inflect works out the AI Act tier from your answers, and leaving them all as they are gives the minimal tier; the form has no field for the tier itself.

Click **{{ui:agents.register.new.submit}}**. The agent joins the register as {{ui:agents.register.filterEnums.status.DRAFT}} and {{ui:agents.register.unscored}}, with an entry in the workspace's AI-system register.

### Set the concurrent-run cap

Under **{{ui:agents.register.concurrency.heading}}**, type a whole number up to 1,000 and click **{{ui:agents.register.concurrency.save}}**. Leave the box empty for no cap. A cap of 0 stops new agent runs from starting without stopping the ones already running.

### Choose the agent that answers on {{ui:nav.agentsAsk}}

Open the agent and click **{{ui:admin.agentDetail.interactive.use}}**. From then on it answers every question asked on the [{{ui:agents.ask.title}}](../comply/ask.md) page, in place of any agent chosen before, and its page shows **{{ui:admin.agentDetail.interactive.badge}}** beside its name. Click **{{ui:admin.agentDetail.interactive.stop}}** to stop it; questions are then refused until another agent is chosen. A retired agent cannot be chosen. Until an agent is chosen, every question on that page is refused.

### Set the monthly token budget

Under **{{ui:agents.register.budget.heading}}**, choose **{{ui:agents.register.budget.useNone}}** or **{{ui:agents.register.budget.useSet}}**, then click **{{ui:agents.register.budget.save}}**. Each run is charged its full token ceiling when it starts, so a budget is either 0, which refuses every new run, or at least one run's ceiling. The panel says what that ceiling is.

## What happens next

- A new agent cannot act until somebody scores its risk and activates it on its own page. While registration is not enforced, its status decides nothing.
- Opening an agent leads to its own page, with the tabs {{ui:admin.agentDetail.tabOverview}}, {{ui:admin.agentDetail.tabRisk}}, {{ui:admin.agentDetail.tabPolicy}}, {{ui:admin.agentDetail.tabTools}}, {{ui:admin.agentDetail.tabSkills}}, {{ui:admin.agentDetail.tabCoverage}}, {{ui:admin.agentDetail.tabRuns}} and {{ui:admin.agentDetail.tabBreaker}}. That is where an agent is assessed, amended, activated, suspended, retired or stopped. Owners, Admins and AI admins are offered **{{ui:admin.agentDetail.amend.action}}**, **{{ui:admin.agentDetail.overview.activateAction}}**, **{{ui:admin.agentDetail.overview.suspendAction}}** and **{{ui:admin.agentDetail.overview.retireAction}}** there, and can score an agent's risk. An Auditor finds several of those tabs greyed out and is offered none of those changes.
- Every registration, cap change, budget change and choice of the agent that answers questions is recorded in the workspace's audit log, naming who made it.
- A cap or a budget applies to the next run that starts. A run refused by either says which one refused it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.register.accessTitle}}** | Your role cannot read the agent register | Ask an Owner or Admin |
| **{{ui:agents.register.emptyTitle}}** | No agent is registered | Click **{{ui:agents.register.addAgent}}** |
| **{{ui:agents.register.emptyMatchingTitle}}** | Agents exist, but none match the filters | Remove a filter pill |
| **{{ui:agents.register.new.vendorRequired}}** under the supplier field | A third-party agent was submitted with no supplier | Choose the supplier and try again |
| A reason from the server above the form after **{{ui:agents.register.new.submit}}** | The agent was not registered, for the reason it names | Correct what it names and try again |
| **{{ui:agents.register.new.errorFallback}}** | The agent was not registered, and no reason came back | Try again |
| A warning that the cap must be a whole number from 0 to 1,000 | The cap is not a whole number, or is above 1,000 | Correct it, or empty the box |
| A warning that the budget would refuse every run, with **{{ui:agents.register.budget.save}}** greyed out | The budget is above 0 but below one run's ceiling | Enter 0, or at least the ceiling the warning names |
| **{{ui:agents.register.concurrency.saveFailed}}** or **{{ui:agents.register.budget.saveFailed}}** | The change did not go through | Try again |

The table loads the 200 newest agents. A register holding more shows only those 200, with a notice above the table saying so; narrow the list with the filters or the search to reach the rest. The **{{ui:agents.register.kpi.total}}** card still counts them all.

## Related

- [{{ui:agents.runs.title}}](agent-runs.md), for what agents have done.
- [{{ui:agents.proposals.title}}](agent-proposals.md), for the changes agents are asking to make.
- [{{ui:agents.reports.title}}](agent-reports.md), for the figures an assessor asks for, and for agents found outside the register.
- [{{ui:admin.security.title}}](../admin/security.md), where registration enforcement is turned on with **{{ui:admin.security.agentEnforcement.enableAction}}**.
- [{{ui:admin.apiKeys.pageTitle}}](../admin/api-keys.md), where a key is bound to an agent when it is created.
