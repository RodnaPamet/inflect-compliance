---
route: /t/[tenantSlug]/agents/[agentId]
---

# An agent

An agent's own page shows one registered agent: who answers for it, how much it may do on its own, what it is allowed to reach, how it was assessed, and how it has behaved. From here you change its settings, stop it, retire it, and connect an agent you run to it.

## Where to find it

Open [{{ui:nav.agents}}](agents.md) under **{{ui:nav.manage}}** in the sidebar and click an agent. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:agents.register.breadcrumb}}** › the agent's name.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, its **{{ui:admin.agentDetail.tabOverview}}** and **{{ui:admin.agentDetail.tabRuns}}** tabs | Owner, Admin, AI admin, Auditor |
| Open the other tabs | Owner, Admin, AI admin |
| **{{ui:admin.agentDetail.amend.action}}**, activate, suspend, retire, **{{ui:admin.agentDetail.interactive.use}}**, assess its risk | Owner, Admin, AI admin |
| Edit its policy card, grant and revoke its tools | Owner, Admin, AI admin |
| Stop it and resume it | Owner, Admin, AI admin |
| Create a key for it under **{{ui:admin.agentDetail.connect.action}}** | Owner, Admin |
| Propose or accept a new owner | Owner, AI admin |

Tabs a role cannot open are greyed out, and an Auditor sees a note once saying why: {{ui:admin.agentDetail.viewOnlyTabs}} Everyone else sees **{{ui:admin.agentDetail.forbiddenTitle}}** instead of the page.

## What you see

**The header.** The agent's name and status (draft, active, suspended or retired), **{{ui:admin.agentDetail.interactive.badge}}** when it answers questions on Ask, and six facts: **{{ui:admin.agentDetail.metaAutonomy}}** (Level 0 to Level 4, how far it may act on its own), **{{ui:admin.agentDetail.metaAccess}}**, **{{ui:admin.agentDetail.metaReversibility}}**, **{{ui:admin.agentDetail.metaProvenance}}**, **{{ui:admin.agentDetail.metaTier}}** (or **{{ui:admin.agentDetail.unscored}}**) and **{{ui:admin.agentDetail.metaAiAct}}** (or **{{ui:admin.agentDetail.unclassified}}**), each in words, such as "Reads tenant data" or "Compensable".

When the agent, or every agent in the workspace, is stopped, a banner across the page says so, when and why: **{{ui:admin.agentDetail.kill.bannerAgentTitle}}** or **{{ui:admin.agentDetail.kill.bannerTenantTitle}}**.

**The tabs:**

| Tab | What it holds |
| --- | --- |
| {{ui:admin.agentDetail.tabOverview}} | The accountable owner, declared model, supplier, EU AI Act classification, when it was registered and last scored, its live credentials and description. **{{ui:admin.agentDetail.overview.availabilityHeading}}**: activate, suspend or retire it. Below: **{{ui:admin.agentDetail.ownership.heading}}** and **{{ui:admin.agentDetail.spLink.heading}}** |
| {{ui:admin.agentDetail.tabRisk}} | **{{ui:admin.agentDetail.risk.standingHeading}}**: the tier in force and when it was scored, and whether the agent has changed since. **{{ui:admin.agentDetail.risk.questionnaireHeading}}**: the questions that score it |
| {{ui:admin.agentDetail.tabPolicy}} | The agent's policy card: the tools it may use, its maximum data scope and autonomy, its action budgets per run and per day, its escalation triggers and its approval rung. Each change adds a version |
| {{ui:admin.agentDetail.tabTools}} | **{{ui:admin.agentDetail.tools.heading}}**: every tool the agent may call; anything absent is refused. Below, the tools the agent runtime adds on its own |
| {{ui:admin.agentDetail.tabSkills}} | The skills its workflows mount, and this workspace's own skills |
| {{ui:admin.agentDetail.tabBehaviour}} | Shown only where agent profiles are switched on. {{ui:agents.behaviour.intro}} |
| {{ui:admin.agentDetail.tabCoverage}} | **{{ui:admin.agentDetail.coverage.summaryHeading}}**: how many of the agentic risks that apply to it a control covers, and the open gaps |
| {{ui:admin.agentDetail.tabRuns}} | **{{ui:admin.agentDetail.runs.heading}}**: the workflow runs it started, newest first, each linked to [its run page](agent-run-detail.md) |
| {{ui:admin.agentDetail.tabBreaker}} | **{{ui:admin.agentDetail.breaker.stateHeading}}**: whether its behaviour has moved far enough from its usual pattern to stop it, signal by signal |

## What you can do

### Change its settings

Click **{{ui:admin.agentDetail.amend.action}}**. Change its name, description, autonomy level, data access, reversibility, provenance, model reference or supplier, and save. {{ui:admin.agentDetail.amend.loweringAlwaysAllowed}} The owner is not changed here: {{ui:admin.agentDetail.amend.ownerMovesByTransfer}}

### Assess its risk

On **{{ui:admin.agentDetail.tabRisk}}**, answer the questions, then click **{{ui:admin.agentDetail.risk.completeAction}}** and confirm. {{ui:admin.agentDetail.risk.completeHint}} An agent that has never been assessed is refused every tool, so it cannot be activated.

### Activate, suspend or retire it

On **{{ui:admin.agentDetail.tabOverview}}**, under **{{ui:admin.agentDetail.overview.availabilityHeading}}**:

- **{{ui:admin.agentDetail.overview.activateAction}}** puts an assessed agent into service.
- **{{ui:admin.agentDetail.overview.suspendAction}}** takes it out of service until it is activated again. {{ui:admin.agentDetail.overview.suspendPrompt}}
- **{{ui:admin.agentDetail.overview.retireAction}}** ends it for good. The confirmation lists what happens at once: its live keys are revoked, its tool grants dropped, its proposals awaiting review expire, and its policy card is frozen. {{ui:admin.agentDetail.overview.retireIrreversible}}

### Stop it at once

Click **{{ui:admin.agentDetail.kill.engageAction}}**, give a **{{ui:admin.agentDetail.kill.reasonLabel}}**, and confirm. {{ui:admin.agentDetail.kill.engagePrompt}} To undo it, click **{{ui:admin.agentDetail.kill.liftAction}}** and give a reason. When the stop covers the whole workspace, the button reads **{{ui:admin.agentDetail.kill.liftActionTenant}}**.

### Use it to answer questions on Ask

Click **{{ui:admin.agentDetail.interactive.use}}**. The badge **{{ui:admin.agentDetail.interactive.badge}}** appears. **{{ui:admin.agentDetail.interactive.stop}}** undoes it.

### Grant or revoke a tool

On **{{ui:admin.agentDetail.tabTools}}**, tick or untick a tool. A revoke can be undone for a few seconds. A tool whose definition changed since it was approved has no effect until someone approves it again on the [{{ui:agents.externalTools.title}}](agent-external-tools.md) page.

### Edit its policy card

On **{{ui:admin.agentDetail.tabPolicy}}**, click **{{ui:admin.agentDetail.policyCard.seedAction}}** the first time, then **{{ui:admin.agentDetail.policyCard.editAction}}**. The card can only narrow what the agent's grants and risk tier already allow.

Each save may widen one thing: raise one limit by one step, or permit any number of tools the card's limits already allow. Taking authority away is never limited. A tool that reaches further than the card's data scope cannot be ticked, so to permit tools that read workspace data on a card at the lowest data scope, raise the data scope first, one step per save, then tick the tools in one save.

### Connect an agent you run

Click **{{ui:admin.agentDetail.connect.action}}**. Owners and Admins name a key, set its autonomy ceiling (it can only be lower than the agent's own), and click **{{ui:admin.agentDetail.connect.mint}}**. {{ui:admin.agentDetail.connect.keyOnce}} The panel then shows the settings for your agent to use.

### Hand it to a new owner

Under **{{ui:admin.agentDetail.ownership.heading}}**, propose a new owner. {{ui:admin.agentDetail.ownership.intro}} The person named sees **{{ui:admin.agentDetail.ownership.accept}}** and **{{ui:admin.agentDetail.ownership.decline}}**; the person who proposed it can withdraw it.

### Confirm its Entra service principal

Under **{{ui:admin.agentDetail.spLink.heading}}**, click **{{ui:admin.agentDetail.spLink.confirm}}** and **{{ui:admin.agentDetail.spLink.confirmAction}}** to confirm that the principal a scan linked really is this agent's. Only a confirmed link can be disabled automatically when the agent's owner leaves.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.agentDetail.overview.unscoredTitle}}** | {{ui:admin.agentDetail.overview.unscoredBody}} | Assess it |
| **{{ui:admin.agentDetail.risk.neverScoredTitle}}** | The agent has no risk tier | Answer the questions and complete the assessment |
| **{{ui:admin.agentDetail.policyCard.seedHeading}}** | The agent has no policy card | Create one |
| **{{ui:admin.agentDetail.runs.emptyTitle}}** | {{ui:admin.agentDetail.runs.emptyDescription}} | Nothing to do |
| **{{ui:admin.agentDetail.overview.notFoundTitle}}** | {{ui:admin.agentDetail.overview.notFoundBody}} | Reload the register |
| **{{ui:admin.agentDetail.forbiddenTitle}}** | Your role cannot open the agent register | Ask an Owner or Admin |

## Related

- [{{ui:nav.agents}}](agents.md), the agent register.
- [Agent run](agent-run-detail.md), one of the agent's runs.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where its proposals are decided.
- [{{ui:agents.externalTools.title}}](agent-external-tools.md), where an outside tool's definition is approved.
