---
route: /t/[tenantSlug]/agents/decisions
---

# {{ui:agents.decisions.title}}

The {{ui:agents.decisions.title}} lists the model calls and outside tool calls this workspace has made. Each entry records what made the call, a short summary of the answer, and whether a person has reviewed the outcome. It is the record an assessor asks for under the EU AI Act: what an AI system decided, and whether a human looked.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.decisions}}**. The same **{{ui:common.ui.viewsMenu}}** menu sits in this page's header.

On an agent run's own page, a model-call step that produced a decision has a **{{ui:agents.runs.detail.decisionLink}}** link. It opens this page showing only the decisions made over that step's content.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the log | Owner, Admin, AI admin; Auditor, when an Owner allows it |

An Owner lets Auditors open the log with the switch **{{ui:admin.agentOversight.setting.auditorReadsDecisionLog.name}}** under [AI features](../admin/ai-features.md). It starts off. Without it, an Auditor sees **{{ui:agents.oversightAccess.title}}** instead of the page, as Editors and Readers always do.

## What you see

The newest 100 entries that match the filters, newest first. When there are more, a line says so; narrow the filters to reach older ones. Each entry shows:

- **The review outcome**, as a coloured label:

  | Label | What it means |
  | --- | --- |
  | **{{ui:agents.decisions.outcome.PENDING}}** | No person has decided on this outcome yet |
  | **{{ui:agents.decisions.outcome.ACCEPTED}}** | A person accepted what the model produced |
  | **{{ui:agents.decisions.outcome.EDITED}}** | A person accepted it after changing it |
  | **{{ui:agents.decisions.outcome.REJECTED}}** | A person rejected it |
  | **{{ui:agents.decisions.outcome.AUTONOMOUS}}** | Nobody will review it. An assistant answer or an outside tool call is recorded this way from the start. A run's model calls that were still waiting are stamped this way when the run finishes with nothing left to approve, and an automatic external change is recorded this way because an Owner set it to run without approval |

  When a run leaves proposals, its model calls wait for them: they take the decision a person makes on the proposal, or **{{ui:agents.decisions.outcome.AUTONOMOUS}}** if the proposal expires undecided. Entries recorded before this rule existed may still read **{{ui:agents.decisions.outcome.PENDING}}**.

- **What made the call**, in words:

  | Label | What it means |
  | --- | --- |
  | {{ui:agents.decisions.feature.assistant}} | The workspace assistant answered a question |
  | Agent run, with the workflow's name | A step of an agent run called a model |
  | {{ui:agents.decisions.feature.tool}} | An agent called a tool on an outside tool server |
  | {{ui:agents.decisions.feature.proposal}} | An agent queued a proposal for a person to decide |
  | {{ui:agents.decisions.feature.automatic}} | An agent made a change in an outside system without approval |
  | {{ui:agents.decisions.feature.risk}} | Risk suggestions were generated |
  | {{ui:agents.decisions.feature.matching}} | Accounts were matched to people |

- **The provider and model** it called. For an outside tool call, the tool server's name instead.
- **What the output guard found**, when it checked the answer: **{{ui:agents.decisions.guard.CLEAN}}**, **{{ui:agents.decisions.guard.FLAGGED}}**, **{{ui:agents.decisions.guard.QUARANTINED}}** or **{{ui:agents.decisions.guard.MALICIOUS}}**.
- **When** the call was made.
- **A short summary** of the answer, when one was recorded. It is a bounded, cleaned summary, not the full model output. For an outside tool call it says **{{ui:agents.decisions.toolSummary.done}}** or **{{ui:agents.decisions.toolSummary.failed}}**.
- **Links**: to the run that made the call (**{{ui:agents.decisions.reviewRun}}** while it waits for review, **{{ui:agents.decisions.openRun}}** after), to the proposal queue for a proposal, and to the agent by name, with **{{ui:agents.decisions.onlyThisAgent}}** beside it.
- **Tokens in and out**, and how long the call took, when they were reported.
- **A fingerprint** of the input: the first characters of a code computed from what the model was sent. The content itself is never stored here.

## What you can do

Read. The page changes nothing. A review outcome is recorded where the decision is made, such as approving or rejecting a proposal in the [{{ui:agents.proposals.title}}](agent-proposals.md) queue.

### Narrow the list

Above the list:

- Choose **{{ui:agents.decisions.outcomeAll}}**, **{{ui:agents.decisions.outcomeFilter.PENDING}}**, **{{ui:agents.decisions.outcomeFilter.REVIEWED}}** or **{{ui:agents.decisions.outcomeFilter.AUTONOMOUS}}**. **{{ui:agents.decisions.outcomeFilter.REVIEWED}}** covers accepted, edited and rejected.
- Pick a kind of call from the list, or **{{ui:agents.decisions.kindAll}}**.
- Click **{{ui:agents.decisions.onlyThisAgent}}** on an entry to see one agent's calls. **{{ui:agents.decisions.clearAgent}}** undoes it.

**{{ui:agents.decisions.showAll}}** clears every filter. The page address carries the filters, so you can share a narrowed view.

### See the decisions over one piece of content

 Follow a **{{ui:agents.runs.detail.decisionLink}}** link from a run's step. The page then says it is showing decisions over one piece of content, and lists only those. To see every decision again, click **{{ui:agents.decisions.showAll}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.decisions.emptyTitle}}** | {{ui:agents.decisions.emptyDesc}} Nothing has called a model yet | Nothing to do |
| **{{ui:agents.decisions.emptyFilteredTitle}}** | {{ui:agents.decisions.emptyFilteredDesc}} | Click **{{ui:agents.decisions.showAll}}** |
| **{{ui:agents.decisions.emptyNarrowedTitle}}** | {{ui:agents.decisions.emptyNarrowedDesc}} | Change or clear the filters |
| **{{ui:agents.oversightAccess.title}}** | {{ui:agents.oversightAccess.message}} | Ask an Owner |

## Related

- [{{ui:agents.runs.title}}](agent-runs.md), the agent runs whose model calls appear here.
- [Agent run](agent-run-detail.md), where a model-call step links to its decision.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where proposals are approved or rejected.
