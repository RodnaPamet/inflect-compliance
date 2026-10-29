---
route: /t/[tenantSlug]/agents/proposals
---

# {{ui:agents.proposals.title}}

The {{ui:agents.proposals.title}} page is the review queue for changes that agents ask to make. An agent never writes a risk, control, policy or finding itself: it proposes the change, the proposal waits here, and only a person's approval turns it into a real record.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.proposals}}**. A number beside the entry counts the proposals waiting, when there are any. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.proposals.crumb}}**.

A waiting run on the [{{ui:agents.runs.title}}](agent-runs.md) page links here too. Older links to a separate agent-proposals page open this page.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the queue and read every proposal | Owner, Admin, AI admin, Auditor |
| Approve a proposal | Owner, Admin |
| Reject a proposal, alone or several at once | Owner, Admin |

AI admins and Auditors see the tick boxes and the buttons greyed out. Hovering a button explains that it needs write access to the workspace. Editors and Readers see **{{ui:agents.proposals.accessTitle}}** instead of the page.

If your workspace uses custom roles, opening the queue depends on the permissions your role was given. Approving and rejecting depend on whether the built-in role your custom role is based on can make changes.

Some rules hold whatever your role:

- **Whoever raised a dissent does not decide it.** When a member of internal audit disagrees with a sampled auditor workpaper, their dissent queues a finding proposal here. That person may not approve or reject it; somebody else must.
- **Two approvers means two different people.** Some proposals need a second approver, because of the agent's policy card, its risk tier or how freely it acts. You cannot sign the same proposal twice, and the agent's accountable owner cannot be one of the two.
- **Only a person decides.** A proposal cannot be approved with an API key.
- **A proposal has a review window.** Seven days from when it was proposed, or fourteen when the agent's policy card asks for a second approver. After that it can be neither approved nor rejected.

## What it is for

Use the queue to check what an agent wants to change before the change exists. Read each proposal's content and the reason the agent gave, follow it back to the run that produced it, and approve only what you would have made yourself.

## What you see

**The queue.** One card per waiting proposal, newest first. The page loads the 100 newest. Each card shows:

- **A tick box**, for rejecting several proposals at once.
- **What it would create or change**, as a code: **RISK**, **CONTROL**, **POLICY**, **FINDING**, or **EXTERNAL_WRITE** for a change to an outside system.
- **{{ui:agents.proposals.diff.operationCreate}}** or **{{ui:agents.proposals.diff.operationUpdate}}**.
- **The content check's verdict.** **{{ui:agents.proposals.guard.cleanBadge}}**; **{{ui:agents.proposals.guard.flaggedBadge}}**, when a rule matched the content, with the rules that fired; or **{{ui:agents.proposals.guard.unscannedBadge}}**, for a proposal made before the check existed. Content the check refuses outright never reaches this queue.
- **When it was proposed**, and, if it came through an API key, the first characters of that key's internal reference.
- **{{ui:agents.proposals.reject}}**.
- **The record an update would change**, by its reference.
- **{{ui:agents.proposals.fromRun}}**, or the number of the step, a link to the run that produced the proposal, when a run did.
- **The agent's rationale**, the reason it gave for the change, when it gave one.
- **The content.** For a new record, **{{ui:agents.proposals.diff.createHeading}}** lists every field and its value. For an update, **{{ui:agents.proposals.diff.updateHeading}}** sets each field's {{ui:agents.proposals.diff.beforeColumn}} beside its {{ui:agents.proposals.diff.afterColumn}}, and marks the fields that stay {{ui:agents.proposals.diff.unchanged}}. The comparison is made against the record as it stands when the page loads. Fields are named as Inflect stores them.
- **{{ui:agents.proposals.approve}}**, at the foot of the content.

An update that would change nothing is marked **{{ui:agents.proposals.diff.noChangesBadge}}**. One whose changes cannot be shown, because its record has been deleted or its content cannot be read, is marked **{{ui:agents.proposals.diff.blockedBadge}}** and offers no approval.

## What you can do

### Approve a proposal

Read the content and click **{{ui:agents.proposals.approve}}**. For a **{{ui:agents.proposals.guard.flaggedBadge}}** proposal, the **{{ui:agents.proposals.guard.confirmTitle}}** dialog repeats the rules that fired; click **{{ui:agents.proposals.guard.confirmApprove}}**, or **{{ui:agents.proposals.guard.confirmCancel}}** to step back. The page approves the content exactly as proposed; it offers no way to edit it first.

When the proposal needs one approver, the record is created and the card leaves the queue. When it needs two, your approval is recorded, a note says how many of the required approvals are in, and the card stays for a second reviewer.

### Reject a proposal

Click **{{ui:agents.proposals.reject}}** on its card. Nothing is created and the card leaves the queue at once, with no confirmation.

### Reject several proposals at once

Tick their boxes. A bar shows how many are selected. Click **{{ui:agents.proposals.bulk.reject}}**, or **{{ui:agents.proposals.bulk.clear}}** to untick them all. The cards leave the queue, and for five seconds a message offers **{{ui:agents.proposals.bulk.undo}}**. Nothing is rejected until that time runs out. A proposal that could not be rejected, for example because somebody else decided it first or its window had closed, returns to the queue and a message says how many.

## What happens next

- An approved proposal creates its record through the same checks as a record made by hand, and the content check reads it once more first. The record is made in the approver's name, and the audit log ties it to the proposal it came from.
- An approved **EXTERNAL_WRITE** is sent to the outside system within about ten minutes, after the connection's setting is checked again.
- Every approval, signature, rejection and refused attempt is recorded in the workspace's audit log, naming who made it.
- Some approved proposals are drawn at random for a second reviewer to re-check. How often they disagree is shown on the {{ui:agents.register.title}} and in the [{{ui:agents.reports.title}}](agent-reports.md).
- A proposal nobody decides leaves the queue overnight after its window closes. It is kept as a record that nobody agreed to it.
- A run waiting for review can be resumed on the [{{ui:agents.runs.title}}](agent-runs.md) page once its proposals are decided.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.proposals.accessTitle}}** | Your role cannot read the queue | Ask an Owner or Admin |
| **{{ui:agents.proposals.emptyTitle}}** | Nothing is waiting for review. The text below says whether you can approve | Nothing to do |
| **{{ui:agents.proposals.diff.approveBlocked}}** | The proposal's changes cannot be shown | Reject it |
| **agent_proposal_expired** | The proposal's review window has closed. It stays on the page until the overnight clean-up | Nothing; it cannot be decided |
| **agent_proposal_four_eyes** | You already approved it, or you own the agent and it needs two other people | Ask another Owner or Admin to approve it |
| **You raised this finding proposal by dissenting from a sampled workpaper. Somebody else decides it.** | The proposal came from your own dissent | Ask somebody else to decide it |
| **The record changed since this diff was reviewed - re-review before approving** | The record the update would change was edited after the page loaded | Reload the page and read the changes again |
| **Proposal is no longer pending**, or a message that it is already decided | Somebody else decided it first | Reload the page |
| **{{ui:agents.proposals.approveFailed}}**, **{{ui:agents.proposals.rejectFailed}}** or **{{ui:agents.proposals.bulk.failed}}** | The action did not go through | Try again |

The page shows the 100 newest waiting proposals and says nothing when more are waiting; the number in the **{{ui:common.ui.viewsMenu}}** menu counts them all. After a reload, a proposal with one of its two approvals recorded looks the same as one with none.

## Related

- [{{ui:agents.runs.title}}](agent-runs.md), for the runs that produce most proposals.
- [{{ui:agents.register.title}}](agents.md), for the agents themselves, their owners and their policy cards.
- [{{ui:agents.reports.title}}](agent-reports.md), whose approvals report measures whether reviews here mean anything.
