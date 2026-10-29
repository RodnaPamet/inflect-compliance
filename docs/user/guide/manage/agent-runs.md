---
route: /t/[tenantSlug]/agents/runs
---

# {{ui:agents.runs.title}}

The {{ui:agents.runs.title}} page lists the workspace's agent workflow runs: what each one is doing or did, how many steps and tokens it took, and whether it is waiting for a person. Owners and Admins also start workflows here, resume a run that is waiting for review, and stop a run.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.runs}}**. The same menu sits on every agent page. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.runs.crumb}}**.

Older links to a separate agent-runs page open this page.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, and open a run's own page | Owner, Admin, AI admin, Auditor |
| Start a workflow | Owner, Admin |
| Resume a run that is waiting for review | Owner, Admin |
| Abort a run | Owner, Admin |

AI admins and Auditors see the buttons greyed out. Hovering one explains that it needs write access to the workspace. Editors and Readers see **{{ui:agents.runs.accessTitle}}** instead of the page.

If your workspace uses custom roles, opening the page depends on the permissions your role was given. Starting, resuming and aborting depend on whether the built-in role your custom role is based on can make changes.

## What it is for

Use the page to see what agent workflows have done and what they are doing now, to step in when a run is waiting for a person, and to stop a run that should not carry on. A run reads the workspace's compliance data and ends with a summary. When it wants to change a record in this workspace, it queues a proposal for a person to approve. A change it makes in an outside system follows that connection's own setting, which can allow it without a person approving each one.

## What you see

**{{ui:agents.runs.startWorkflow}}.** A row of buttons, one per workflow. Hover a button to read what the workflow does. Three of them can start from this page: the posture diagnostic and the two posture reviews, of compliance and of access. Every other workflow needs details this page does not ask for, such as a framework or a question, and starting it from here is refused with a message naming what is missing.

**The list.** The 50 most recent runs, newest first. Each run shows:

- **Its status**, as the code the run records:

| Status | What it means |
| --- | --- |
| **RUNNING** | The run is working now |
| **AWAITING_APPROVAL** | The run has stopped for a person to review what it did. The date its approval window closes is shown beside it |
| **PAUSED** | The run was interrupted, for example when the service restarted |
| **COMPLETED** | The run finished |
| **ABORTED** | Somebody stopped it |
| **FAILED** | It stopped on an error |

- **The engine** that ran it: {{ui:agents.runs.driver.STATIC}}, {{ui:agents.runs.driver.FLUE}}, or {{ui:agents.runs.driver.UNRECOGNISED}} for an engine this version of Inflect does not know.
- **The workflow's short code**, linked to the run's own page.
- **How many steps** it took, roughly how many tokens it used, and when it started.
- **A hint** under a run that is waiting for review. When it queued proposals, the hint links to the review queue and says to approve them, then resume. When it queued none, it reads **{{ui:agents.runs.awaitingApprovalNoProposals}}**
- **The run's summary**, once it has one.

**A run's own page.** Opening a run shows its status, engine, steps, tokens and start time, then every step in order: what kind of step it was, such as {{ui:agents.runs.detail.kind.READ}}, {{ui:agents.runs.detail.kind.PROPOSE}} or {{ui:agents.runs.detail.kind.HUMAN_CHECKPOINT}}, its {{ui:agents.runs.detail.inputLabel}} and {{ui:agents.runs.detail.outputLabel}}, the tokens it used and the proposals it queued. It also lists **{{ui:agents.runs.detail.skillsTitle}}**. The run's page is for reading only: its buttons step through the timeline and change nothing.

## What you can do

### Start a workflow

Click the workflow's button under **{{ui:agents.runs.startWorkflow}}**. The new run appears at the top of the list. If it is refused, a red message under the buttons gives the reason, for example that the workspace's monthly token budget or its cap on runs at once has been reached.

### Resume a run waiting for review

A run marked **AWAITING_APPROVAL** offers **{{ui:agents.runs.resume}}**. First decide what it asked for: follow the hint to the review queue and approve or reject its proposals, or open the run to see why it stopped. Then click **{{ui:agents.runs.resume}}**. The run carries on from where it stopped.

Resume before the approval window closes. After that the run cannot be resumed, and you start the workflow again.

A **PAUSED** run offers only **{{ui:agents.runs.abort}}** on this page.

### Abort a run

A run that is **RUNNING**, **AWAITING_APPROVAL** or **PAUSED** offers **{{ui:agents.runs.abort}}**. Click it, then confirm in the **{{ui:agents.runs.abortConfirmTitle}}** dialog. The run stops before its next step. Work it has already done is not undone, and an aborted run cannot be resumed: starting the workflow again begins a new run from the start.

## What happens next

- Every start, resume and abort is recorded in the workspace's audit log, naming who did it.
- A run's proposals wait in the review queue until somebody approves or rejects them, or until their review window closes.
- Aborting a run counts as refusing what it decided. Its model decisions are recorded as rejected.
- A run that is waiting or paused still counts towards the workspace's cap on runs at once, until it finishes or is aborted.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.runs.accessTitle}}** | Your role cannot read agent runs | Ask an Owner or Admin |
| **{{ui:agents.runs.emptyTitle}}** | No workflow has run in this workspace | Start one, if your role can |
| A message starting **Workflow** and naming what it requires | That workflow needs details this page does not supply | Start one of the three workflows this page can start |
| A message starting **approval_window_closed** after **{{ui:agents.runs.resume}}** | The run's approval window has closed | Start the workflow again |
| **Run is COMPLETED, cannot resume**, or another status | The run is no longer waiting | Reload the page to see where it is |
| A message starting **monthly_token_budget_exceeded**, or one about the cap on agent runs | The workspace's monthly token budget or its cap on runs at once refused the run | Wait, or ask an Owner, Admin or AI admin to raise the limit on the {{ui:agents.register.title}} |
| **{{ui:agents.runs.startFailed}}**, **{{ui:agents.runs.resumeFailed}}** or **{{ui:agents.runs.abortFailed}}** | The action did not go through | Try again |

After you start, resume or abort a run, the list reloads and a waiting run's hint can say nothing is queued even when proposals are waiting. Reload the page to see the right hint.

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), where a run's proposals are approved or rejected.
- [{{ui:agents.register.title}}](agents.md), where the cap on runs at once and the monthly token budget are set.
- [{{ui:agents.reports.title}}](agent-reports.md), for the figures an assessor asks for.
