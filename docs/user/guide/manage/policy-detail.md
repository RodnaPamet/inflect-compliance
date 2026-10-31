---
route: /t/[tenantSlug]/policies/[policyId]
---

# A policy

A policy's page is where you write, review, approve and publish one policy, and keep its versions, linked controls, acknowledgements and review schedule together.

## Where to find it

Open **{{ui:nav.policies}}** under **{{ui:nav.manage}}** and click a policy's title. The breadcrumb ends **{{ui:policies.detail.crumbPolicies}}** › the policy's title. Arrows beside the title step to the previous or next policy in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the policy, its versions and its activity, and export it as a PDF | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Write a new version, request approval, edit the review schedule, mark it reviewed | Owner, Admin, Editor |
| Approve or reject a version, publish, publish without approval, roll back | Owner, Admin |
| Archive and restore | Owner, Admin |
| See who has acknowledged the policy | Owner, Admin, Auditor |
| Ask people to acknowledge it | Owner, Admin |

Nobody can approve a version they requested or wrote themselves. The page shows the button greyed out with the reason: {{ui:policies.detail.sodApproveBlocked}}

## What it is for

Keep a policy's whole life in one place: every version anyone has written, who approved which, which version is live, which controls it supports, and whether people have read it.

## What you see

**The header.** The policy's title, its **{{ui:policies.detail.metaStatus}}**, its **{{ui:policies.detail.metaOwner}}** and its **{{ui:policies.detail.metaNextReview}}**, which turns red once it has passed. On the right, the buttons that move the policy on, shown only when they apply: **{{ui:policies.detail.exportPdf}}**, **{{ui:policies.detail.requestApproval}}**, **{{ui:policies.detail.publish}}**, **{{ui:policies.detail.publishWithoutApproval}}**, **+ {{ui:policies.detail.version}}** and **{{ui:policies.detail.archive}}**, or **{{ui:policies.detail.restoreFromArchive}}** on an archived policy.

When a version is waiting for approval, a banner above the page says so and names who asked. Owners and Admins approve or reject it from the banner, with an optional comment.

Under the header, the description, category, owner, review dates and number of versions, with **{{ui:policies.detail.editReviewSchedule}}** and **{{ui:policies.detail.markReviewed}}**.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:policies.detail.tabCurrent}}** | The version people should follow, with a guide to what to do next |
| **{{ui:policies.detail.tabVersions}}** | Every version, newest first, with its change summary and its approvals |
| **{{ui:policies.detail.tabMappings}}** | The framework requirements the policy supports, through its controls |
| **{{ui:policies.detail.tabTraceability}}** | The controls linked to the policy |
| **{{ui:policies.detail.tabAcknowledgements}}** | Who has acknowledged the published version, and who still has to |
| **{{ui:policies.detail.tabTasks}}** | The tasks linked to the policy |
| **{{ui:policies.detail.tabEditor}}** | Where you write a new version. Shown only if you can edit |
| **{{ui:policies.detail.tabActivity}}** | Everything that has happened to the policy |

## What you can do

### Write a new version

1. Click **+ {{ui:policies.detail.version}}**. The **{{ui:policies.detail.tabEditor}}** tab opens with the newest version's content.
2. Write in **{{ui:policies.detail.modeMarkdown}}**, or choose **{{ui:policies.detail.externalLink}}** and give the **{{ui:policies.detail.externalUrlLabel}}** of a document kept elsewhere.
3. Optionally fill in **{{ui:policies.detail.changeSummaryLabel}}**.
4. Save.

On a published policy, the new version is a proposed change: {{ui:policies.detail.versionProposedToast}}

### Approve and publish a version

1. Click **{{ui:policies.detail.requestApproval}}**. The policy goes to review.
2. An Owner or Admin who did not write or request it clicks **{{ui:policies.detail.approve}}** or **{{ui:policies.detail.reject}}**.
3. Once it is approved, an Owner or Admin clicks **{{ui:policies.detail.publish}}**. That version becomes the one in force.

See [Publish a policy](../../how-to/policies/publish-a-policy.md).

### Publish in an emergency

**{{ui:policies.detail.publishWithoutApproval}}** publishes the newest version straight away. You must give a reason, which is recorded in the policy's activity and the workspace's audit log.

### Roll back

On **{{ui:policies.detail.tabCurrent}}**, **{{ui:policies.detail.rollback}}** makes an earlier version the published one again.

### Keep the review schedule

Click **{{ui:policies.detail.editReviewSchedule}}** to set how often the policy is reviewed, in days, and the next review date. **{{ui:policies.detail.markReviewed}}** records that the policy has been reviewed today and moves the next review date on. It does not create a new version.

### Ask people to acknowledge it

On **{{ui:policies.detail.tabAcknowledgements}}**, once a version is published, an Owner or Admin can ask members to acknowledge it. See [Collect policy acknowledgements](../../how-to/policies/collect-policy-acknowledgements.md).

### Archive or restore

**{{ui:policies.detail.archive}}** asks you to confirm: {{ui:policies.detail.archiveConfirmBody}} **{{ui:policies.detail.restoreFromArchive}}** brings it back: {{ui:policies.detail.unarchivedToast}}

## What happens next

- Publishing a new version, or rolling back, carries the acknowledgement request over: everyone who had to acknowledge the previous version is asked again, by email, to acknowledge the one now in force, and counts as outstanding until they do.
- The next review date shows on the policies list and the calendar, and turns overdue once it passes.
- **{{ui:policies.detail.exportPdf}}** downloads the current version with a cover page and contents.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:policies.detail.notFoundEmpty}}** | The policy does not exist or is in another workspace | Go back to the list |
| **{{ui:policies.detail.versionEmpty}}** | Nothing has been published yet | Write a version and take it through approval |
| **{{ui:policies.detail.versionsEmpty}}** | The policy has no versions | Write one on **{{ui:policies.detail.tabEditor}}** |
| **{{ui:policies.detail.reviewOverdue}}** | The next review date has passed | Review the policy and click **{{ui:policies.detail.markReviewed}}** |
| **{{ui:policies.detail.approvalNoLongerCurrent}}** beside an approval | A newer version has replaced the one that was approved | Nothing to do |
| **{{ui:policies.detail.errCreateVersion}}**, or a reason in red | The version was not saved, or an action was refused | Follow the reason given, then try again |
| **{{ui:policies.detail.errSaveReview}}** | The review schedule was not saved | Try again |
| **{{ui:policies.detail.activityEmpty}}** | Nothing has been recorded yet | Nothing to do |

## Related

- [{{ui:policies.title}}](policies.md), every policy in the workspace.
- [Create a policy](../../how-to/policies/create-a-policy.md).
- [Publish a policy](../../how-to/policies/publish-a-policy.md).
- [Collect policy acknowledgements](../../how-to/policies/collect-policy-acknowledgements.md).
