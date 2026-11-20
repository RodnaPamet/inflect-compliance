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
| Write, approve, reject and retire versions on **{{ui:admin.agentDetail.tabBehaviour}}**, accept a new behaviour baseline | Owner, Admin, AI admin. Nobody approves or rejects a version they wrote |
| Declare, narrow, review and withdraw its **{{ui:admin.agentDetail.spending.heading}}** | Owner, Admin, AI admin. Nobody reviews an envelope they declared, or one for an agent they own |
| Stop it and resume it | Owner, Admin, AI admin |
| Create a key for it under **{{ui:admin.agentDetail.connect.action}}** | Owner, Admin |
| Propose or accept a new owner | Owner, AI admin |

Tabs a role cannot open are greyed out, and an Auditor sees a note once saying why: {{ui:admin.agentDetail.viewOnlyTabs}} Everyone else sees **{{ui:admin.agentDetail.forbiddenTitle}}** instead of the page.

If your workspace uses custom roles, those tabs and changes also need a membership whose built-in role is Owner, Admin or AI admin: a custom role granting the agent register on an Editor, Reader or Auditor membership finds them greyed out.

## What you see

**The header.** The agent's name and status (draft, active, suspended or retired), **{{ui:admin.agentDetail.interactive.badge}}** when it answers questions on Ask, and six facts: **{{ui:admin.agentDetail.metaAutonomy}}** (Level 0 to Level 4, how far it may act on its own), **{{ui:admin.agentDetail.metaAccess}}**, **{{ui:admin.agentDetail.metaReversibility}}**, **{{ui:admin.agentDetail.metaProvenance}}**, **{{ui:admin.agentDetail.metaTier}}** (or **{{ui:admin.agentDetail.unscored}}**) and **{{ui:admin.agentDetail.metaAiAct}}** (or **{{ui:admin.agentDetail.unclassified}}**), each in words, such as "Reads tenant data" or "Compensable".

Beside the header's buttons, **{{ui:agentCanvas.openOnCanvas}}** opens the agent on the process canvas. It is shown only where the workspace has the process canvas.

When the agent, or every agent in the workspace, is stopped, a banner across the page says so, when and why: **{{ui:admin.agentDetail.kill.bannerAgentTitle}}** or **{{ui:admin.agentDetail.kill.bannerTenantTitle}}**.

**The tabs:**

| Tab | What it holds |
| --- | --- |
| {{ui:admin.agentDetail.tabOverview}} | The accountable owner, declared model, supplier, EU AI Act classification, when it was registered and last scored, its live credentials and description. **{{ui:admin.agentDetail.overview.availabilityHeading}}**: activate, suspend or retire it. Below: **{{ui:admin.agentDetail.spLink.heading}}**, **{{ui:admin.agentDetail.spending.heading}}**, **{{ui:admin.agentDetail.fingerprint.heading}}** and **{{ui:admin.agentDetail.ownership.heading}}** |
| {{ui:admin.agentDetail.tabRisk}} | **{{ui:admin.agentDetail.risk.standingHeading}}**: the tier in force and when it was scored, and whether the agent has changed since. **{{ui:admin.agentDetail.risk.questionnaireHeading}}**: the questions that score it |
| {{ui:admin.agentDetail.tabPolicy}} | The agent's policy card: the tools it may use, its maximum data scope and autonomy, its action budgets per run and per day, its escalation triggers and its approval rung. Each change adds a version |
| {{ui:admin.agentDetail.tabTools}} | **{{ui:admin.agentDetail.tools.heading}}**: every tool the agent may call; anything absent is refused. Below, the tools the agent runtime adds on its own, each with when it appears, and the approval state of each tool's definition |
| {{ui:admin.agentDetail.tabSkills}} | The skills its workflows mount, and this workspace's own skills |
| {{ui:admin.agentDetail.tabBehaviour}} | Shown only where agent profiles are switched on. {{ui:agents.behaviour.intro}} See [Write its behaviour](#write-its-behaviour) |
| {{ui:admin.agentDetail.tabCoverage}} | **{{ui:admin.agentDetail.coverage.summaryHeading}}**: how many of the agentic risks that apply to it a control covers, and the open gaps |
| {{ui:admin.agentDetail.tabRuns}} | **{{ui:admin.agentDetail.runs.heading}}**: the workflow runs it started, newest first, each linked to [its run page](agent-run-detail.md) |
| {{ui:admin.agentDetail.tabBreaker}} | **{{ui:admin.agentDetail.breaker.stateHeading}}**: whether its behaviour has moved far enough from its usual pattern to stop it, signal by signal, including **{{ui:admin.agentDetail.breaker.signalBehaviourAnomaly}}** from the nightly fingerprint. The details of a close are shown only while that close still stands |

## What you can do

### Change its settings

Click **{{ui:admin.agentDetail.amend.action}}**. Change its name, description, autonomy level, data access, reversibility, provenance, model reference or supplier, and save. {{ui:admin.agentDetail.amend.loweringAlwaysAllowed}} The owner is not changed here: {{ui:admin.agentDetail.amend.ownerMovesByTransfer}} When the supplier list cannot be read, the supplier field is greyed out and says so, rather than offering a list that does not show the current supplier.

### Assess its risk

On **{{ui:admin.agentDetail.tabRisk}}**, answer the questions, then click **{{ui:admin.agentDetail.risk.completeAction}}** and confirm. {{ui:admin.agentDetail.risk.completeHint}} An agent that has never been assessed is refused every tool, so it cannot be activated.

### Activate, suspend or retire it

On **{{ui:admin.agentDetail.tabOverview}}**, under **{{ui:admin.agentDetail.overview.availabilityHeading}}**:

- **{{ui:admin.agentDetail.overview.activateAction}}** puts an assessed agent into service.
- **{{ui:admin.agentDetail.overview.suspendAction}}** takes it out of service until it is activated again. {{ui:admin.agentDetail.overview.suspendPrompt}}
- **{{ui:admin.agentDetail.overview.retireAction}}** ends it for good. The confirmation lists what happens at once: its live keys are revoked, its tool grants dropped, its proposals awaiting review expire, and its policy card is frozen. {{ui:admin.agentDetail.overview.retireIrreversible}} If the request does not complete, the page says it is not known whether the agent was retired; check its status before trying again.

### Stop it at once

Click **{{ui:admin.agentDetail.kill.engageAction}}**, give a **{{ui:admin.agentDetail.kill.reasonLabel}}**, and confirm. {{ui:admin.agentDetail.kill.engagePrompt}} To undo it, click **{{ui:admin.agentDetail.kill.liftAction}}** and give a reason. When the stop covers the whole workspace, the button reads **{{ui:admin.agentDetail.kill.liftActionTenant}}**.

### Record what it may spend

On **{{ui:admin.agentDetail.tabOverview}}**, **{{ui:admin.agentDetail.spending.heading}}** records what the agent may pay for, as the cardholder consented to it: one envelope per payment rail, with a per-transaction limit, a budget per day, week or month, the merchants it may pay, an expiry, the member who consented, and the agent platform that holds the payment token with that platform's own reference for it. Inflect never holds a card number or a payment token, and refuses a value that looks like one. The platform and the card issuer enforce the limits; the envelope is what you check them against.

1. Click **{{ui:admin.agentDetail.spending.declare}}**, fill in the envelope and click **{{ui:admin.agentDetail.spending.declareSave}}**. With no merchant websites and no category codes, the agent may pay any merchant, and the form says so.
2. Another person clicks **{{ui:admin.agentDetail.spending.review}}** and confirms with **{{ui:admin.agentDetail.spending.reviewConfirm}}**. The person who declared it and the agent's owner are not offered the review, and the card says why. Until it is reviewed, the agent cannot be activated; if it is already active, a finding stays open until the envelope is reviewed or withdrawn.

**{{ui:admin.agentDetail.spending.narrow}}** lowers a limit, shortens the expiry or removes merchants, and keeps the review. Anything wider is refused there: use **{{ui:admin.agentDetail.spending.redeclare}}**, which a second person reviews again. **{{ui:admin.agentDetail.spending.withdraw}}** removes the envelope from the register; ask the platform to cancel the token too.

When the agent is stopped with **{{ui:admin.agentDetail.kill.engageAction}}**, each envelope reads **{{ui:admin.agentDetail.spending.status.SUSPENDED_REQUESTED}}** and a task asks the agent's owner to have the platform suspend the token. Resuming the agent does not restore the envelope: declare it again for a second person to review, or withdraw it.

### Read its behaviour fingerprint

On **{{ui:admin.agentDetail.tabOverview}}**, **{{ui:admin.agentDetail.fingerprint.heading}}** compares each day of the agent's activity with its own previous days, counting calls, tokens and proposals but never reading content. It reads **{{ui:admin.agentDetail.fingerprint.verdict.LEARNING}}** until it has enough active days, then **{{ui:admin.agentDetail.fingerprint.verdict.STEADY}}** or **{{ui:admin.agentDetail.fingerprint.verdict.ANOMALOUS}}**. For the latest anomaly it lists the counts that drove it against the agent's usual figures; earlier anomalies are listed on [{{ui:agents.reports.title}}](agent-reports.md). When the detector is not switched on for the deployment or the workspace, the card says so: no anomalies then means nobody looked.

When the change was intended, click **{{ui:admin.agentDetail.fingerprint.acceptAction}}** and confirm with **{{ui:admin.agentDetail.fingerprint.acceptConfirm}}**. Both the nightly fingerprint and the hourly circuit breaker discard the agent's earlier baseline and learn again from today, and neither judges the agent until they have. The finding stays open until you close it. While the circuit breaker is open the button is not offered: close the breaker on **{{ui:admin.agentDetail.tabBreaker}}** instead, saying whether the change was intended.

### Use it to answer questions on Ask

Click **{{ui:admin.agentDetail.interactive.use}}**. The badge **{{ui:admin.agentDetail.interactive.badge}}** appears. **{{ui:admin.agentDetail.interactive.stop}}** undoes it.

### Grant or revoke a tool

On **{{ui:admin.agentDetail.tabTools}}**, tick or untick a tool. A revoke can be undone for a few seconds. A tool whose definition changed since it was approved has no effect until someone approves it again on the [{{ui:agents.externalTools.title}}](agent-external-tools.md) page.

### Edit its policy card

On **{{ui:admin.agentDetail.tabPolicy}}**, click **{{ui:admin.agentDetail.policyCard.seedAction}}** the first time, then **{{ui:admin.agentDetail.policyCard.editAction}}**. The card can only narrow what the agent's grants and risk tier already allow.

Each save may widen one thing: raise one limit by one step, or permit any number of tools the card's limits already allow. Taking authority away is never limited. A tool that reaches further than the card's data scope cannot be ticked, so to permit tools that read workspace data on a card at the lowest data scope, raise the data scope first, one step per save, then tick the tools in one save.

### Write its behaviour

The **{{ui:admin.agentDetail.tabBehaviour}}** tab is shown only where agent profiles are switched on. It holds the instructions the agent follows when it runs, and the tools, skills and limits they run with. The card at the top shows the version **{{ui:agents.behaviour.inForce.heading}}**, the version open for review, if any, and **{{ui:agents.behaviour.history.heading}}**.

1. Click **{{ui:agents.behaviour.createAction}}** the first time, or **{{ui:agents.behaviour.editAction}}** after that. Write the **{{ui:agents.behaviour.field.instructions}}** in plain language, then choose:
   - **{{ui:agents.behaviour.field.tools}}** and **{{ui:agents.behaviour.field.skills}}**, from what the agent is granted and can mount now. The skills picker counts the bytes of their descriptions against the budget a run can mount, and the draft cannot be saved over it.
   - **{{ui:agents.behaviour.field.modelTier}}**, **{{ui:agents.behaviour.field.effort}}** and **{{ui:agents.behaviour.field.maxTurns}}**.
   - **{{ui:agents.behaviour.field.compaction}}**: **{{ui:agents.behaviour.compaction.default}}**, **{{ui:agents.behaviour.compaction.off}}** or **{{ui:agents.behaviour.compaction.lower}}**. When a run's next request would pass the threshold, the model summarises the earlier turns and carries on from the summary. A version can turn this off or lower the threshold, never raise it.
   - **{{ui:agents.behaviour.field.deferral}}**: the propose tools whose calls stop the run until a person approves or rejects the proposal it queued on [{{ui:agents.proposals.title}}](agent-proposals.md). The run then carries on with the decision. With none ticked, every call queues its proposal and the run goes on.
   - **{{ui:agents.behaviour.field.outputKind}}** and **{{ui:agents.behaviour.field.triggers}}**.
   - **{{ui:agents.behaviour.subagents.heading}}**: click **{{ui:agents.behaviour.subagents.add}}** to add one, up to four. Each has a name, its own instructions, a turn limit no higher than the version's, and tools and skills chosen from the version's own. A sub-agent cannot delegate further, and cannot use a tool that waits for a person.
2. Click **{{ui:agents.behaviour.editor.save}}**. Saving creates a draft; it replaces any version still open for review. Nothing changes for the agent yet.
3. Click **{{ui:agents.behaviour.open.submit}}**.
4. Another person clicks **{{ui:agents.behaviour.review.approve}}** or **{{ui:agents.behaviour.review.reject}}**. {{ui:agents.behaviour.review.authorCannotDecide}} The review shows what changed from the version in force, including the sub-agents and any drawn flow, and approving approves exactly what was shown. A rejection needs a reason, which the author reads on the version. Where the workspace has the process canvas, **{{ui:agents.behaviour.canvas.compare}}** draws the version's changes from the version in force [on the canvas](agent-canvas.md#comparing-two-versions).

**{{ui:agents.behaviour.testRun.action}}**, on a version waiting for review or in force, starts a read-only run of that version as the agent and opens the **{{ui:admin.agentDetail.tabRuns}}** tab. It is greyed out, with the reason beside it, when the workspace's engine does not run agent profiles, when the agent is not active and assessed, when the version does not allow Test runs, when it names only propose tools, or when it carries a drawn flow.

**{{ui:agents.behaviour.canvas.open}}**, on the version in force and on the version open for review, draws that version [on the canvas](agent-canvas.md). It is shown only where the workspace has the process canvas.

**{{ui:agents.behaviour.open.retire}}** retires a draft, a version waiting for review, or the version in force. {{ui:agents.behaviour.open.retireInForceNote}} A retired agent's profile can no longer change.

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
| **{{ui:admin.agentDetail.kill.stateUnknownTitle}}** | {{ui:admin.agentDetail.kill.stateUnknown}} | Reload the page |
| **{{ui:admin.agentDetail.tools.manifests.forbiddenTitle}}** on **{{ui:admin.agentDetail.tabTools}}** | Your role cannot read the approval state of tool definitions | Ask an Owner, Admin or AI admin |
| **{{ui:agents.behaviour.inForce.noneTitle}}** on **{{ui:admin.agentDetail.tabBehaviour}}** | {{ui:agents.behaviour.inForce.noneDescription}} | Write a version and have another person approve it |
| **{{ui:admin.agentDetail.forbiddenTitle}}** | Your role cannot open the agent register | Ask an Owner or Admin |

## Related

- [{{ui:nav.agents}}](agents.md), the agent register.
- [Agent run](agent-run-detail.md), one of the agent's runs.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where its proposals are decided.
- [{{ui:agents.externalTools.title}}](agent-external-tools.md), where an outside tool's definition is approved.
