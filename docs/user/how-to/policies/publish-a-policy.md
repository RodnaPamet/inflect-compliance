# Publish a policy

Publishing makes a policy live: it becomes the version staff are asked to follow and acknowledge. It takes three moves. Someone asks for approval of a version, an Owner or Admin approves it, and an Owner or Admin publishes it. This guide covers publishing a policy that is not live yet.

## Before you start

| Step | Who can do it |
| --- | --- |
| Ask for approval | Owner, Admin, Editor |
| Approve or reject | Owner, Admin |
| Publish, with or without approval | Owner, Admin |

- With a custom role, what you can do depends on the permissions your role was given.
- The person who approves must not be the person who asked for approval, nor the person who wrote the version. Plan for two people. If you are the only Owner or Admin and you write your policies yourself, invite a second Owner or Admin first.
- The policy needs a version with content. See [Create a policy](create-a-policy.md).
- A policy can have only one approval request open at a time.

## Steps

### Ask for approval

1. Click **{{ui:nav.policies}}** under {{ui:nav.manage}} in the sidebar, then click the policy's title.
2. Open the **{{ui:policies.detail.tabVersions}}** tab. Versions are listed newest first.
3. On the version you want approved, usually the newest, click **{{ui:policies.detail.requestApproval}}**.
    - Use the button on the version itself. The **{{ui:policies.detail.requestApproval}}** button at the top of the page can pick an older version.

The policy's status becomes {{ui:policies.filterEnums.status.inReview}}. A **{{ui:approval.pendingReview}}** banner appears at the top of the policy's page, naming who asked and reading {{ui:approval.awaitingReviewer}}. Inflect emails each member with the Admin role to say a review is waiting.

### Approve or reject

4. As an Owner or Admin, open the policy. In the **{{ui:approval.pendingReview}}** banner, click **{{ui:approval.approve}}** or **{{ui:approval.reject}}**. The same two buttons are on the version's card in the **{{ui:policies.detail.tabVersions}}** tab, under {{ui:policies.detail.approvalsLabel}}.
    - **Approve:** the status becomes {{ui:policies.filterEnums.status.approved}}. The {{ui:policies.detail.tabCurrent}} tab shows {{ui:policies.detail.guideApprovedTitle}}.
    - **Reject:** the status goes back to {{ui:policies.filterEnums.status.draft}}. Change the policy if needed, then ask for approval again.

Either way, Inflect emails the person who asked for approval with the decision.

### Publish

5. As an Owner or Admin, click **{{ui:policies.detail.publish}}** at the top of the policy's page. The same button is on the approved version's card in the **{{ui:policies.detail.tabVersions}}** tab.

The status becomes {{ui:policies.filterEnums.status.published}}, and the version's card is marked {{ui:policies.detail.published}}. The {{ui:policies.detail.tabCurrent}} tab now shows the published text.

The policy's page header shows the status in capitals, for example **IN_REVIEW**, **APPROVED** or **PUBLISHED**.

## Publish without approval

For an emergency, such as a security fix during an incident, an Owner or Admin can publish a version that has not been approved.

1. On the policy's page, click **{{ui:policies.detail.publishWithoutApproval}}** at the top.
2. Read the warning, then type the reason in the box. The reason is required.
3. Click **{{ui:policies.detail.publishWithoutApproval}}** in the dialog. It stays greyed out until you type a reason.

This publishes the version marked {{ui:policies.detail.current}} on the {{ui:policies.detail.tabVersions}} tab, or the newest version when none is marked. Check which one that is before you confirm. The bypass and your reason are recorded in the policy's history. Any approval request still open is closed.

## What happens next

- Staff can now acknowledge the policy on its **{{ui:policies.detail.tabAcknowledgements}}** tab. To ask particular people and track who has, see [Collect policy acknowledgements](collect-policy-acknowledgements.md).
- Publishing closes any approval request still open on the policy.
- Each request, decision and publication is listed on the policy's **{{ui:policies.detail.tabActivity}}** tab and recorded in the workspace's audit log, naming who did it.
- To take a policy out of use, an Owner or Admin clicks **{{ui:policies.detail.archive}}**, then **{{ui:policies.detail.archiveConfirmLabel}}**. **{{ui:policies.detail.restoreFromArchive}}** brings it back as a draft, which must be approved and published again.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| A version has no **{{ui:policies.detail.requestApproval}}** button | The policy already has a request open, the version is approved or published, or your role cannot ask | Wait for the open request to be decided, or ask an Owner, Admin or Editor |
| The {{ui:policies.detail.tabVersions}} tab reads {{ui:policies.detail.versionsEmpty}} | The policy has no content yet | Add a version first. See [Create a policy](create-a-policy.md) |
| **{{ui:policies.detail.approve}}** is greyed out, with the hint {{ui:policies.detail.sodApproveBlocked}} | You asked for this approval or wrote this version | Ask another Owner or Admin to approve it. You can still reject your own request to withdraw it |
| The banner says {{ui:approval.cannotApproveOwn}} | The same rule, shown in the banner | Ask another Owner or Admin |
| The banner shows no **{{ui:approval.approve}}** or **{{ui:approval.reject}}** | Your role cannot decide approvals | Ask an Owner or Admin |
| {{ui:policies.detail.approvalNoLongerCurrent}} beside a request | The policy has moved on since that request, so it can no longer be decided | Nothing to do on that request. Ask for approval again if you still need it |
| {{ui:policies.detail.guideApprovedTitle}}, but no **{{ui:policies.detail.publish}}** button | Your role cannot publish | Ask an Owner or Admin to publish it |
| A red box near the top of the policy's page after you click a button | Inflect refused the action. The box's text may not say why | Reload the page to see the policy's current status, then check the rules under "Before you start" |
