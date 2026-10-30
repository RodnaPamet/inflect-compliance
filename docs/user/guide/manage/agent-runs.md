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
| Follow the ad-hoc question to the {{ui:agents.ask.title}} page | Owner, Admin, AI admin, Auditor |
| Resume a run that is waiting for review or paused | Owner, Admin |
| Abort a run | Owner, Admin |

AI admins and Auditors see the start, resume and abort buttons greyed out. Hovering one explains that it needs write access to the workspace. Editors and Readers see **{{ui:agents.runs.accessTitle}}** instead of the page.

If your workspace uses custom roles, opening the page depends on the permissions your role was given. Starting, resuming and aborting depend on whether the built-in role your custom role is based on can make changes. The discovered-agent review also needs permission to read the agent inventory, and a membership of Owner, Admin or AI admin; without them its button is greyed out and says why. The ad-hoc question needs permission to view controls.

## What it is for

Use the page to see what agent workflows have done and what they are doing now, to step in when a run is waiting for a person, and to stop a run that should not carry on. A run reads the workspace's compliance data and ends with a summary. When it wants to change a record in this workspace, it queues a proposal for a person to approve. A change it makes in an outside system follows that connection's own setting, which can allow it without a person approving each one.

## What you see

**{{ui:agents.runs.startWorkflow}}.** A row of buttons, one per workflow. Hover a button to read what the workflow does.

- **Start in one click:** the posture diagnostic and the two posture reviews, of compliance and of access.
- **Open a form first:** audit preparation and framework onboarding ask for a framework; the workpaper narrative asks for a period; the discovered-agent review asks you to choose the agent.
- **The ad-hoc question** is a link to the {{ui:agents.ask.title}} page, where questions are asked.
- **Greyed out, with the reason on hover:** the agent recertification pack, which an agent access review starts when it prepares its reviewer packs, and the SAP transaction review, which a connected host system starts with the document facts it reviews.
- **Greyed out for some custom roles:** audit preparation and framework onboarding when your role cannot view frameworks, and the discovered-agent review when it cannot read the agent inventory. The reason is shown on hover.

**The list.** The 50 most recent runs, newest first. When older runs exist, a notice above the list says so. Each run shows:

- **Its status:**

| Status | What it means |
| --- | --- |
| **{{ui:agents.runs.status.RUNNING}}** | The run is working now |
| **{{ui:agents.runs.status.AWAITING_APPROVAL}}** | The run has stopped for a person to review what it did. The date its approval window closes is shown beside it |
| **{{ui:agents.runs.status.PAUSED}}** | The run was interrupted when the service shut down. Nothing resumes it on its own |
| **{{ui:agents.runs.status.COMPLETED}}** | The run finished |
| **{{ui:agents.runs.status.ABORTED}}** | Somebody stopped it |
| **{{ui:agents.runs.status.FAILED}}** | It stopped on an error |
| **{{ui:agents.runs.status.EMPTY_CATALOGUE}}** | It could not start because its agent was given no tools |

- **The engine** that ran it: {{ui:agents.runs.driver.STATIC}}, {{ui:agents.runs.driver.FLUE}}, or {{ui:agents.runs.driver.UNRECOGNISED}} for an engine this version of Inflect does not know.
- **The workflow's name**, linked to the run's own page.
- **How many steps** it took, roughly how many tokens it used, and when it started.
- **A hint** under a run that is waiting for review. When it queued proposals, the hint links to the review queue and says to approve them, then resume. When it queued none, it reads **{{ui:agents.runs.awaitingApprovalNoProposals}}**
- **The run's summary**, once it has one.

**A run's own page.** Opening a run shows its status, engine, steps, tokens and start time, then every step in order: what kind of step it was, such as {{ui:agents.runs.detail.kind.READ}}, {{ui:agents.runs.detail.kind.PROPOSE}} or {{ui:agents.runs.detail.kind.HUMAN_CHECKPOINT}}, its {{ui:agents.runs.detail.inputLabel}} and {{ui:agents.runs.detail.outputLabel}}, the tokens it used and the proposals it queued. Each step's status reads **{{ui:agents.runs.detail.stepStatus.PENDING}}**, **{{ui:agents.runs.detail.stepStatus.RUNNING}}**, **{{ui:agents.runs.detail.stepStatus.DONE}}**, **{{ui:agents.runs.detail.stepStatus.FAILED}}** or **{{ui:agents.runs.detail.stepStatus.SKIPPED}}**, and each proposal names its kind and where its review stands, such as {{ui:agents.proposals.kind.RISK}} · {{ui:agents.runs.detail.proposalStatus.PENDING}}. It also lists **{{ui:agents.runs.detail.skillsTitle}}**. The run's page is for reading only: its buttons step through the timeline and change nothing.

## What you can do

### Start a workflow

Click the workflow's button under **{{ui:agents.runs.startWorkflow}}**. A workflow that needs details opens the **Start** form: fill in each field, using the hint under it, and click **{{ui:agents.runs.startForm.submit}}**. For the discovered-agent review, choose the agent from the list, newest seen first; each entry shows when it was last seen, by which source, and the register entry it is linked to, if any. When the list does not hold every agent, a note under it says so.

The new run appears at the top of the list. If it is refused, a red message gives the reason, for example that the workspace's monthly token budget or its cap on runs at once has been reached.

### Resume a run waiting for review

A run marked **{{ui:agents.runs.status.AWAITING_APPROVAL}}** offers **{{ui:agents.runs.resume}}**. First decide what it asked for: follow the hint to the review queue and approve or reject its proposals, or open the run to see why it stopped. Then click **{{ui:agents.runs.resume}}**. The run carries on from where it stopped.

Resume before the approval window closes. After that the run cannot be resumed, and you start the workflow again.

### Resume a paused run

A **{{ui:agents.runs.status.PAUSED}}** run also offers **{{ui:agents.runs.resume}}**, with a hint: {{ui:agents.runs.pausedHint}}

### Abort a run

A run that is **{{ui:agents.runs.status.RUNNING}}**, **{{ui:agents.runs.status.AWAITING_APPROVAL}}** or **{{ui:agents.runs.status.PAUSED}}** offers **{{ui:agents.runs.abort}}**. Click it, then confirm in the **{{ui:agents.runs.abortConfirmTitle}}** dialog. The run stops before its next step. Work it has already done is not undone, and an aborted run cannot be resumed: starting the workflow again begins a new run from the start.

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
| **{{ui:agents.runs.startForm.discoveredFailed}}** or **{{ui:agents.runs.startForm.frameworksFailed}}** in the start form | The list to choose from could not be loaded | Close the form and open it again |
| **{{ui:agents.runs.startForm.noDiscoveredAgents}}** in the start form | No harness scan has found an agent in this workspace yet | Nothing to review yet |
| A message starting **approval_window_closed** after **{{ui:agents.runs.resume}}** | The run's approval window has closed | Start the workflow again |
| **Run is COMPLETED, cannot resume**, or another status | The run is no longer waiting | Reload the page to see where it is |
| A message starting **monthly_token_budget_exceeded**, or one about the cap on agent runs | The workspace's monthly token budget or its cap on runs at once refused the run | Wait, or ask an Owner, Admin or AI admin to raise the limit on the {{ui:agents.register.title}} |
| **{{ui:agents.runs.startFailed}}**, **{{ui:agents.runs.resumeFailed}}** or **{{ui:agents.runs.abortFailed}}** | The action did not go through | Try again |


## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), where a run's proposals are approved or rejected.
- [{{ui:agents.register.title}}](agents.md), where the cap on runs at once and the monthly token budget are set.
- [{{ui:agents.reports.title}}](agent-reports.md), for the figures an assessor asks for.
