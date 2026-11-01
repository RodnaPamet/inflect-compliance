---
route: /t/[tenantSlug]/agents/runs/[runId]
---

# Agent run

A run's own page shows one agent workflow run step by step: what it read, what it proposed, which model calls it made, what the output guard found, and how it ended. Use it to answer "what exactly did this agent do?" after the fact.

## Where to find it

On the [{{ui:agents.runs.title}}](agent-runs.md) page, click a run's workflow name. A proposal in the review queue also links to the run that made it. The breadcrumb reads **{{ui:agents.runs.detail.crumbAgents}}** › **{{ui:agents.runs.crumb}}** › the workflow's name, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Open a run and read its steps | Owner, Admin, AI admin, Auditor |
| {{ui:agents.runs.resume}} or {{ui:agents.runs.abort}} a run | Owner, Admin |

Editors and Readers see **{{ui:agents.runs.accessTitle}}** instead of the page. An AI admin or Auditor sees **{{ui:agents.runs.resume}}** and **{{ui:agents.runs.abort}}** turned off, with the reason on hover. A run from another workspace, or one that does not exist, shows the page-not-found screen.

## What you see

**The header.** The workflow's name, the **{{ui:agents.runs.resume}}** and **{{ui:agents.runs.abort}}** buttons when the run can still take them, and five facts about the run:

| Fact | What it shows |
| --- | --- |
| {{ui:agents.runs.detail.metaStatus}} | How the run stands, such as **{{ui:agents.runs.status.COMPLETED}}** or **{{ui:agents.runs.status.AWAITING_APPROVAL}}**. The statuses are explained on the [{{ui:agents.runs.title}}](agent-runs.md) page |
| {{ui:agents.runs.detail.metaDriver}} | The engine that ran it |
| {{ui:agents.runs.detail.metaSteps}} | How many steps it recorded |
| {{ui:agents.runs.detail.metaTokens}} | Roughly how many tokens the whole run used |
| {{ui:agents.runs.detail.metaStarted}} | When it started |

**Under the header**, when they apply:

- Who started the run. A run a person started names that person. A run an automation rule started names the rule, says no person started it, and names the rule's owner, whose permissions the run used.
- **{{ui:agents.runs.detail.skillsTitle}}**: each skill the run was given, with its version and a fingerprint of its text. A skill this workspace wrote is marked **{{ui:agents.runs.detail.skillTenant}}**. **{{ui:agents.runs.detail.skillsNone}}** means it was given none; **{{ui:agents.runs.detail.skillsNotRecorded}}**
- The error the run stopped on, if it failed, in a sentence. The engine's own message is folded away under **{{ui:agents.runs.detail.error.detailLabel}}**. An error this page does not recognise is shown as the engine wrote it.
- The run's summary, if it produced one.
- **{{ui:agents.runs.detail.delegation.title}}**, when the run handed work to a specialist agent. {{ui:agents.runs.detail.delegation.body}} Each specialist is shown by the name the run gave it, with whether its answer was accepted and how many steps and tokens are its own.

**The steps**, in order. Each one shows:

- its number and its status: **{{ui:agents.runs.detail.stepStatus.DONE}}**, **{{ui:agents.runs.detail.stepStatus.FAILED}}**, **{{ui:agents.runs.detail.stepStatus.PENDING}}**, **{{ui:agents.runs.detail.stepStatus.RUNNING}}** or **{{ui:agents.runs.detail.stepStatus.SKIPPED}}**;
- its kind: **{{ui:agents.runs.detail.kind.READ}}**, **{{ui:agents.runs.detail.kind.PROPOSE}}**, **{{ui:agents.runs.detail.kind.MODEL_CALL}}**, **{{ui:agents.runs.detail.kind.TOOL_CALL}}**, **{{ui:agents.runs.detail.kind.SYNTHESIS}}** or **{{ui:agents.runs.detail.kind.HUMAN_CHECKPOINT}}**;
- the tool it used, and how far that tool reaches, such as **{{ui:agents.runs.detail.scope.READ_TENANT_DATA}}** or **{{ui:agents.runs.detail.scope.EXTERNAL_EGRESS}}**;
- what the output guard found, when it checked the step: **{{ui:agents.runs.detail.guard.CLEAN}}**, **{{ui:agents.runs.detail.guard.FLAGGED}}** or **{{ui:agents.runs.detail.guard.QUARANTINED}}**, with the rules that fired;
- the tokens it used, when it reported them, and when it happened;
- **{{ui:agents.runs.detail.decisionLink}}**, a link to the decision record the step produced, for a step that made one;
- **{{ui:agents.runs.detail.inputLabel}}** and **{{ui:agents.runs.detail.outputLabel}}**, folded away. They show what went into the step and what came out, as recorded;
- for a **{{ui:agents.runs.detail.kind.PROPOSE}}** step, each proposal it queued and where it stands, linked to the proposal in the review queue.

## What you can do

### Resume or abort the run

The buttons appear in the header only while the run can take them.

| Button | When it appears | What it does |
| --- | --- | --- |
| **{{ui:agents.runs.resume}}** | The run is **{{ui:agents.runs.status.AWAITING_APPROVAL}}** or **{{ui:agents.runs.status.PAUSED}}** | Carries the run on from where it stopped |
| **{{ui:agents.runs.abort}}** | The run is **{{ui:agents.runs.status.RUNNING}}**, **{{ui:agents.runs.status.AWAITING_APPROVAL}}** or **{{ui:agents.runs.status.PAUSED}}** | Asks **{{ui:agents.runs.abortConfirmTitle}}** first. It stops the run where it is. Work already done is not undone, and an aborted run cannot be resumed; a new run starts from the beginning |

The page reloads with the run's new status.

### Step through a run

Above the steps, **{{ui:agents.runs.detail.scrubber.next}}** and **{{ui:agents.runs.detail.scrubber.prev}}** highlight one step at a time; the arrow keys do the same. **{{ui:agents.runs.detail.scrubber.clear}}** removes the highlight. Every step stays on the page; the highlight only marks one.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.runs.detail.emptyTitle}}** | {{ui:agents.runs.detail.emptyDesc}} | Reload the page later |
| The page-not-found screen | The run does not exist in this workspace | Check the link, or open the run from the [{{ui:agents.runs.title}}](agent-runs.md) page |
| **{{ui:agents.runs.accessTitle}}** | Your role cannot see agent activity | Ask an Owner or Admin |
| {{ui:agents.runs.resumeFailed}} or {{ui:agents.runs.abortFailed}} | The run did not change; a reason may be shown with it | Reload the page; the run may already have moved on |

## Related

- [{{ui:agents.runs.title}}](agent-runs.md), every run, and where runs are started, resumed and stopped.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where a run's proposals are reviewed.
