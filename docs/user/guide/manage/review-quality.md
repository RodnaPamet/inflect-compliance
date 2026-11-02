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

Everyone else sees **{{ui:agents.reviewQuality.accessTitle}}** instead of the page. The page only reads; it changes nothing.

## What you see

**The period.** A line giving the window it covers, such as the last 30 days, and how many proposals were decided, approved and rejected in it. Under it: {{ui:admin.reviewQuality.upperTailNote}}

**{{ui:admin.reviewQuality.unobservableTitle}}.** Shown first, on purpose: {{ui:admin.reviewQuality.unobservable.DIFF_EXPANSION}}

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

Read it, and act elsewhere: talk to a reviewer whose decisions are implausibly fast, or tighten an agent's policy card from the agent's page. The agent proposals queue lists only proposals still waiting, so it cannot show a reviewer's past decisions. A fast decision is reported as fast, never as unread; the page cannot tell whether anyone looked.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:admin.reviewQuality.empty}} | No proposal was decided in the window | Nothing to do |
| {{ui:admin.reviewQuality.signalsNone}} | Nothing looked wrong | Nothing to do |
| A note that only the most recent decisions were read | There were more decisions than the page reads, so every figure covers the latest ones | Read the figures as covering only the most recent decisions |
| **{{ui:agents.reviewQuality.accessTitle}}** | Your role cannot read agent oversight | Ask an Owner or Admin |

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), the queue these figures measure.
- [Agents](agents.md), where an agent's policy card is set.
