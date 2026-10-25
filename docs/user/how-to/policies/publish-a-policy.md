# Publish a policy

Publishing makes a policy live: it becomes the version staff are asked to follow and acknowledge. It takes three moves. Someone asks for approval of a version, an Owner or Admin approves it, and an Owner or Admin publishes it. The same three moves revise a policy that is already published, while the published version stays live.

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
2. Click **{{ui:policies.detail.requestApproval}}** at the top of the page. It asks for approval of the newest version.
    - To ask about a different version, open the **{{ui:policies.detail.tabVersions}}** tab, where versions are listed newest first, and click **{{ui:policies.detail.requestApproval}}** on that version.

The policy's status becomes {{ui:policies.filterEnums.status.inReview}}. A **{{ui:approval.pendingReview}}** banner appears at the top of the policy's page, naming who asked and which version, and reading {{ui:approval.awaitingReviewer}}. Inflect emails every active Owner and Admin to say a review is waiting.

### Approve or reject

3. As an Owner or Admin, open the policy. To explain your decision, click **+ {{ui:approval.comment}}** in the **{{ui:approval.pendingReview}}** banner and type it. Then click **{{ui:approval.approve}}** or **{{ui:approval.reject}}**. The same two buttons, without the comment box, are on the version's card in the **{{ui:policies.detail.tabVersions}}** tab, under {{ui:policies.detail.approvalsLabel}}.
    - **Approve:** the status becomes {{ui:policies.filterEnums.status.approved}}. Owners and Admins see {{ui:policies.detail.guideApprovedTitle}} on the {{ui:policies.detail.tabCurrent}} tab.
    - **Reject:** the status goes back to {{ui:policies.filterEnums.status.draft}}. Change the policy if needed, then ask for approval again.

Either way, Inflect emails the person who asked for approval with the decision and your comment. The comment is also shown with the decision on the version's card.

### Publish

4. As an Owner or Admin, click **{{ui:policies.detail.publish}}** at the top of the policy's page. The same button is on the approved version's card in the **{{ui:policies.detail.tabVersions}}** tab. Both publish the version that was approved.

The status becomes {{ui:policies.filterEnums.status.published}}, and the version's card is marked {{ui:policies.detail.published}}. The {{ui:policies.detail.tabCurrent}} tab now shows the published text.

## Revise a published policy

You change a published policy by writing a new version and taking it through approval and publication. The policy stays {{ui:policies.filterEnums.status.published}} the whole time: staff keep following, and acknowledging, the published version until the new one replaces it.

1. On the policy's page, click **{{ui:policies.detail.version}}**, the button with a plus sign at the top. The editor opens with the newest version's content, and a notice reads {{ui:policies.detail.liveEditProposalNotice}}
2. Make your changes, then click **{{ui:policies.detail.version}}** below the form. A message reads {{ui:policies.detail.versionProposedToast}}
3. Click **{{ui:policies.detail.requestApproval}}** at the top of the page. It asks for approval of the new version. Until you do, the {{ui:policies.detail.tabCurrent}} tab shows {{ui:policies.detail.guideRevisionTitle}}.
4. An Owner or Admin approves or rejects it in the **{{ui:approval.pendingReview}}** banner, as above, and the same rule applies: they must not have asked for the approval or written the version. The status stays {{ui:policies.filterEnums.status.published}} either way. After a rejection the published version stays as it was; change the new version and ask again.
5. Once it is approved, an Owner or Admin clicks **{{ui:policies.detail.publish}}** at the top of the page.

The new version becomes the published one, and the {{ui:policies.detail.tabCurrent}} tab shows it. The version it replaced is kept, so an Owner or Admin can return to it with **{{ui:policies.detail.rollback}}** on the {{ui:policies.detail.tabVersions}} tab. Everyone who was asked to acknowledge the policy is asked again for the new version. See [Collect policy acknowledgements](collect-policy-acknowledgements.md).

While a policy is published, only a version newer than the published one can be sent for approval.

## Publish without approval

For an emergency, such as a security fix during an incident, an Owner or Admin can publish a version that has not been approved.

1. On the policy's page, click **{{ui:policies.detail.publishWithoutApproval}}** at the top.
2. Read the warning. It names the version it will publish, which is always the newest one, for example v3. Then type the reason in the box. The reason is required.
3. Click **{{ui:policies.detail.publishWithoutApproval}}** in the dialog. It stays greyed out until you type a reason.

The bypass and your reason are recorded in the policy's history. Any approval request still open is closed.

The button is not offered when the newest version is already published, when it is the approved version (click **{{ui:policies.detail.publish}}** instead), or while the policy is {{ui:policies.filterEnums.status.approved}}: then only the approved version can be published.

## What happens next

- Staff can now acknowledge the policy on its **{{ui:policies.detail.tabAcknowledgements}}** tab. To ask particular people and track who has, see [Collect policy acknowledgements](collect-policy-acknowledgements.md).
- Publishing closes any approval request still open on the policy.
- Each request, decision and publication is listed on the policy's **{{ui:policies.detail.tabActivity}}** tab and recorded in the workspace's audit log, naming who did it.
- To take a policy out of use, an Owner or Admin clicks **{{ui:policies.detail.archive}}**, then **{{ui:policies.detail.archiveConfirmLabel}}**. **{{ui:policies.detail.restoreFromArchive}}** brings it back as a draft, which must be approved and published again.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| A version has no **{{ui:policies.detail.requestApproval}}** button | The policy already has a request open, the version is approved or published, the policy is published and the version is older than the published one, or your role cannot ask | Wait for the open request to be decided, or ask an Owner, Admin or Editor |
| The {{ui:policies.detail.tabVersions}} tab reads {{ui:policies.detail.versionsEmpty}} | The policy has no content yet | Add a version first. See [Create a policy](create-a-policy.md) |
| **{{ui:policies.detail.approve}}** is greyed out, with the hint {{ui:policies.detail.sodApproveBlocked}} | You asked for this approval or wrote this version | Ask another Owner or Admin to approve it. You can still reject your own request to withdraw it |
| The banner says {{ui:approval.cannotApproveOwn}} | The same rule, shown in the banner | Ask another Owner or Admin |
| The banner shows no **{{ui:approval.approve}}** or **{{ui:approval.reject}}** | Your role cannot decide approvals | Ask an Owner or Admin |
| {{ui:policies.detail.approvalNoLongerCurrent}} beside a request | The policy has moved on since that request, so it can no longer be decided | Nothing to do on that request. Ask for approval again if you still need it |
| The policy is approved, but there is no **{{ui:policies.detail.publish}}** button | Your role cannot publish | Ask an Owner or Admin to publish it |
| A red box near the top of the policy's page after you click a button | Inflect refused the action. The box says why | Do what the message says, or reload the page to see the policy's current status and check the rules under "Before you start" |
