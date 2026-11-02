---
route: /t/[tenantSlug]/audits/workpaper-reviews
---

# {{ui:audits.workpaperReviews.title}}

The workspace's auditor agent writes a workpaper each time it runs an audit procedure. Every day some of those workpapers are drawn for internal audit, and each is given to a member of internal audit who does not own the auditor agent. That person re-performs the work and records whether they agree. This page is where they do it. It is the check on the auditor agent, so the agent's own owner can never be the one asked.

## Where to find it

On the [{{ui:nav.audits}}](audits.md) page, click **{{ui:audits.hub.workpaperReviews}}**. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.workpaperReviews.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Every role |
| Be assigned a workpaper, and answer it | An active member whose line of defence is third (internal audit), and who does not own the auditor agent |
| See every assignment in the workspace | Internal audit, as above |
| Change the sampling rate | Internal audit, as above, signed in as a person |

An Owner sets each member's line of defence on the [{{ui:admin.members.title}}](../admin/members.md) page. Anyone else sees only the workpapers assigned to them, which for most people is none.

## What you see

A note at the top: {{ui:audits.workpaperReviews.about}}

When you cannot be assigned workpapers, a second note says why:

| Note | What it means |
| --- | --- |
| {{ui:audits.workpaperReviews.notEligible.REVIEWER_LINE_NOT_THIRD}} | You are not in internal audit |
| {{ui:audits.workpaperReviews.notEligible.REVIEWER_NOT_ACTIVE_MEMBER}} | Your membership is not active |

If you are in internal audit, a third note says: {{ui:audits.workpaperReviews.overview}}

The table:

| Column | What it shows |
| --- | --- |
| {{ui:audits.workpaperReviews.colProcedure}} | The audit procedure the auditor agent ran, by name |
| {{ui:audits.workpaperReviews.colPeriod}} | The period the workpaper covers |
| {{ui:audits.workpaperReviews.colConclusion}} | What the agent concluded, and on what basis, in words such as {{ui:audits.workpaperReviews.conclusionLabel.PASS}} |
| {{ui:audits.workpaperReviews.colAssignee}} | Internal audit only: who must answer it, **{{ui:audits.workpaperReviews.assigneeYou}}**, or **{{ui:audits.workpaperReviews.assigneeNobody}}** |
| {{ui:audits.workpaperReviews.colDrawn}} | When it was drawn for review |
| {{ui:audits.workpaperReviews.colAnswer}} | Where it stands (see below) |

The answer column shows **{{ui:audits.workpaperReviews.outcome.PENDING}}**, **{{ui:audits.workpaperReviews.awaitingReviewer}}** (someone else must answer), the answer once given (**{{ui:audits.workpaperReviews.outcome.CONCURRED}}**, **{{ui:audits.workpaperReviews.outcome.DISSENTED}}** or **{{ui:audits.workpaperReviews.outcome.INDETERMINATE}}**), or why it cannot be answered, such as **{{ui:audits.workpaperReviews.refusal.UNASSIGNED}}** or **{{ui:audits.workpaperReviews.refusal.REVIEWER_OWNS_AUDITOR}}**.

## What you can do

### Review a workpaper

1. Click a row. **{{ui:audits.workpaperReviews.sheetTitle}}** opens at the side.
2. Read **{{ui:audits.workpaperReviews.sectionRecord}}**: the auditor agent that wrote it (linked to its page), the procedure and its catalogue version, the period, the population and its definition, the sample and how it was drawn, the attributes tested, the parameters, the conclusion, the evidence, and when it was written and drawn. Below it, the outcome of each sampled unit and each exception, in words. An exception links to the finding proposal it raised.
3. If the agent wrote one, **{{ui:audits.workpaperReviews.sectionNarrative}}** summarises the workpaper. {{ui:audits.workpaperReviews.narrativeNotice}}
4. Re-perform the work, then under **{{ui:audits.workpaperReviews.sectionAnswer}}** choose an answer:

   | Answer | When to choose it |
   | --- | --- |
   | **{{ui:audits.workpaperReviews.outcome.CONCURRED}}** | {{ui:audits.workpaperReviews.outcomeHint.CONCURRED}} |
   | **{{ui:audits.workpaperReviews.outcome.DISSENTED}}** | {{ui:audits.workpaperReviews.outcomeHint.DISSENTED}} |
   | **{{ui:audits.workpaperReviews.outcome.INDETERMINATE}}** | {{ui:audits.workpaperReviews.outcomeHint.INDETERMINATE}} |

5. For a dissent, choose every reason under **{{ui:audits.workpaperReviews.fieldDissentCodes}}**. There is no free text.
6. Click **{{ui:audits.workpaperReviews.recordAnswer}}**. {{ui:audits.workpaperReviews.answerOnce}}

A dissent queues one finding proposal for a person to decide on the agent proposals page. You cannot decide your own dissent's proposal.

### Read someone else's assignment

Internal audit can open any row. A workpaper assigned to someone else opens read-only: {{ui:audits.workpaperReviews.readOnlyOther}}

### Change the sampling rate

Internal audit sees **{{ui:audits.workpaperReviews.rateLabel}}** above the table. Set a percentage and click **{{ui:audits.workpaperReviews.rateSave}}**. It applies from the next daily draw; a workpaper already drawn stays drawn. The second line runs the auditor agent, so it cannot change how closely the agent is checked.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.workpaperReviews.emptyTitle}}** | {{ui:audits.workpaperReviews.emptyDesc}} | Nothing to do |
| **{{ui:audits.workpaperReviews.emptyTitleOverview}}** | {{ui:audits.workpaperReviews.emptyDescOverview}} | Nothing to do |
| **{{ui:audits.workpaperReviews.refusal.UNASSIGNED}}** on a row | Nobody can be asked yet, because no third-line member who does not own the auditor agent exists | An Owner declares someone's line of defence on the Members page |
| A note that more reviews exist and are not shown | The list is capped | Answer the oldest first |
| {{ui:audits.workpaperReviews.answerFailed}} | The answer was not recorded | Read the reason, and try again |
| **{{ui:audits.workpaperReviews.accessTitle}}** | {{ui:audits.workpaperReviews.accessMessage}} | Ask an Owner or Admin |

## Related

- [{{ui:nav.audits}}](audits.md), where the page is reached.
- [{{ui:admin.members.title}}](../admin/members.md), where an Owner declares each member's line of defence.
- [{{ui:agents.proposals.title}}](../manage/agent-proposals.md), where a dissent's finding proposal is decided.
