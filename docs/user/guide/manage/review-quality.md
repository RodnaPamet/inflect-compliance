---
route: /t/[tenantSlug]/agents/review-quality
---

# {{ui:admin.reviewQuality.title}}

The {{ui:admin.reviewQuality.title}} page asks whether approvals in the [agent proposals](agent-proposals.md) queue mean anything: whether reviewers take time over what agents propose, or approve it on sight. {{ui:admin.reviewQuality.pageDesc}}

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.reviewQuality}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:admin.crumb.reviewQuality}}**, and the same **{{ui:common.ui.viewsMenu}}** menu sits in the page header.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin, AI admin |
| Answer a retrospective sample audit | Owner, Admin, except for an approval they signed themselves |

Everyone else sees **{{ui:agents.reviewQuality.accessTitle}}** instead of the page. An AI admin reads the sample-audit queue but is not offered **{{ui:agents.sampleAudit.answer}}**; the row says so instead. Apart from answering a sample audit, the page only reads.

## What you see

**The period.** A line giving the window it covers, such as the last 30 days, and how many proposals were decided, approved and rejected in it. Under it: {{ui:admin.reviewQuality.upperTailNote}}

**{{ui:admin.reviewQuality.unobservableTitle}}.** Shown first, on purpose: {{ui:admin.reviewQuality.unobservable.DIFF_EXPANSION}}

**{{ui:agents.sampleAudit.title}}.** {{ui:agents.sampleAudit.intro}} This section is shown even when no proposal was decided in the period, because a drawn audit stays open until somebody answers it.

- **The disagreement rate**, over every approval ever drawn rather than over the period above: the share of answers that disagreed with the approval, always beside how many were answered and how many were drawn, and a line counting the answers that agreed, disagreed or could not tell and the audits still waiting. A "could not tell" answer counts in the rate and lowers it; an audit still waiting counts in neither. When nothing has been drawn, or nothing drawn has been answered, the rate is not reported and the sentence says which.
- **The queue**, one row per drawn approval still waiting for an answer: the kind of proposal, the agent, when it was approved and when it was drawn, who was asked to answer it, or **{{ui:agents.sampleAudit.notAssigned}}**, and the link **{{ui:agents.sampleAudit.readTheProposal}}**, which opens the proposal on the agent proposals page. Anyone who may answer can answer any row; the name only says whose it is.

**{{ui:admin.reviewQuality.signalsTitle}}.** Each pattern that crossed its threshold, with who or which agent it is about, what was observed, the threshold and how many decisions it rests on. An agent is named and linked to its page; a reviewer is named. A member or agent removed since is said to be removed:

| Pattern | What it means |
| --- | --- |
| {{ui:admin.reviewQuality.signal.BULK_APPROVAL_BURST}} | Many proposals approved together in a short burst |
| {{ui:admin.reviewQuality.signal.IMPLAUSIBLY_FAST_DECISION}} | A decision came faster than anyone could read the proposal |
| {{ui:admin.reviewQuality.signal.FAST_MEDIAN_REVIEW}} | A reviewer's typical decision is quicker than the reading floor |
| {{ui:admin.reviewQuality.signal.NEVER_REJECTED}} | A reviewer approved everything they decided |
| {{ui:admin.reviewQuality.signal.SECOND_APPROVER_UNRECORDED}} | An agent's policy card asks for a second approver, but the queue records one per proposal |

**{{ui:admin.reviewQuality.reviewersTitle}}.** For each person who decided proposals, by name: how often they approve, how many they decided, their median time to decide and the fastest tenth, their single fastest decision, and how many bulk-approval bursts they made. With too few decisions, the rate and median are withheld and the line says how many more are needed.

**{{ui:admin.reviewQuality.agentsTitle}}.** The same figures for each agent's proposals, with the agent's name linked to its page, and how many were decided under each kind of policy card, such as **{{ui:admin.reviewQuality.rungName.SECOND_APPROVER}}** or **{{ui:admin.reviewQuality.rungName.SINGLE_APPROVER}}**.

## What you can do

### Answer a sample audit

Read the approval through **{{ui:agents.sampleAudit.readTheProposal}}**, then click **{{ui:agents.sampleAudit.answer}}** on its row. Choose **{{ui:agents.sampleAudit.outcome.CONCURRED}}**, **{{ui:agents.sampleAudit.outcome.DISSENTED}}** or **{{ui:agents.sampleAudit.outcome.INDETERMINATE}}**. When you disagree, tick every reason that applies under **{{ui:agents.sampleAudit.codesLabel}}**, such as **{{ui:agents.sampleAudit.code.SHOULD_HAVE_BEEN_REJECTED}}** or **{{ui:agents.sampleAudit.code.OUTSIDE_AGENT_REMIT}}**. Click **{{ui:agents.sampleAudit.submit}}**. The row leaves the queue and the answer counts in the disagreement rate. An answer cannot be changed.

You cannot answer an approval you signed, including as the first of two approvers: the row shows **{{ui:agents.sampleAudit.refusal.SELF_REVIEW}}** instead of the button.

### Act on the figures

Read them, and act elsewhere: talk to a reviewer whose decisions are implausibly fast, or tighten an agent's policy card from the agent's page. The agent proposals queue lists only proposals still waiting, so it cannot show a reviewer's past decisions. A fast decision is reported as fast, never as unread; the page cannot tell whether anyone looked.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:admin.reviewQuality.empty}} | No proposal was decided in the window | Nothing to do |
| {{ui:agents.sampleAudit.empty}} | Every drawn approval has been answered, or none has been drawn | Nothing to do |
| **{{ui:agents.sampleAudit.answerFailed}}** | The answer was not saved; a reason from the server is shown when there is one | Try again |
| {{ui:agents.sampleAudit.refusal.ALREADY_ANSWERED}} | Somebody answered the audit while you had the page open | Nothing to do |
| {{ui:admin.reviewQuality.signalsNone}} | Nothing looked wrong | Nothing to do |
| A note that only the most recent decisions were read | There were more decisions than the page reads, so every figure covers the latest ones | Read the figures as covering only the most recent decisions |
| **{{ui:agents.reviewQuality.accessTitle}}** | Your role cannot read agent oversight | Ask an Owner or Admin |

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), the queue these figures measure.
- [Agents](agents.md), where an agent's policy card is set.
