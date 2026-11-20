---
route: /t/[tenantSlug]/access-reviews/[reviewId]
---

# An access review

An access review's page is where one campaign is worked: the reviewer decides, for each person or account in scope, whether their access stays, goes or changes, and an Owner or Admin closes the campaign to carry out those decisions and file the evidence.

## Where to find it

Open **{{ui:nav.tests}}** under **{{ui:nav.comply}}**, click **{{ui:controlTests.nav.accessReviews}}** in the toolbar, and click a campaign. The breadcrumb reads **{{ui:accessReviews.crumbDashboard}}** › **{{ui:accessReviews.crumbList}}** › the campaign's name.

## Who can use it

| Action | Roles |
| --- | --- |
| View the campaign and its decisions | Everyone who can see access reviews |
| Record a decision on a subject | The campaign's reviewer, and Owners and Admins |
| Discard a decision recorded by mistake | The campaign's reviewer, and Owners and Admins |
| Change the reviewer or the due date | Owners and Admins |
| Close the campaign and generate its evidence | Owners and Admins |
| Prepare the reviewer packs of a registered-agent review | Owners and Admins |
| Answer a second review of an agent decision | The campaign's reviewer, and members who can manage the agent register, unless they made that decision or own the agent |

Revoking or changing the access of an Owner or an AI admin needs a closer who is an Owner, because only an Owner can make that change on the members page.

If your workspace uses custom roles, the decision buttons show only when your role keeps the access-review permission to decide, and **{{ui:accessReviews.closeCampaign}}** only when it keeps the permission to close. In a review of registered agents, the agents are shown only to the campaign's reviewer and to members who can read the agent register; others see **{{ui:accessReviews.agentRestricted}}**. An agent's owner never decides that agent, its proposed narrowings, its proposed spending withdrawals or its second review: the row reads **{{ui:accessReviews.agentOwnerCannotDecide}}**.

## What it is for

Prove, periodically, that only the right people have access. Auditors ask for this under ISO 27001 and SOC 2: the evidence is the list of who was reviewed, who decided what, and that the decisions were carried out.

## What you see

**The header.** The campaign's name, its **{{ui:accessReviews.metaStatus}}**, which is **{{ui:accessReviews.statusLabels.OPEN}}**, **{{ui:accessReviews.statusLabels.IN_REVIEW}}** or **{{ui:accessReviews.statusLabels.CLOSED}}**, and how many subjects have been decided. On the right: **{{ui:accessReviews.downloadEvidence}}** once it exists, and **{{ui:accessReviews.closeCampaign}}** for Owners and Admins.

Under the header: **{{ui:accessReviews.dlReviewer}}**, **{{ui:accessReviews.dlScope}}**, the period, **{{ui:accessReviews.dlDue}}**, and **{{ui:accessReviews.dlClosed}}** once it is closed. Owners and Admins can click **{{ui:accessReviews.changeReviewer}}** and **{{ui:accessReviews.changeDueDate}}** while it is open.

**The subjects.** One row per person or account in scope. For a review of workspace members: **{{ui:accessReviews.colSubject}}**, **{{ui:accessReviews.colSnapshotRole}}** (their role when the campaign started), **{{ui:accessReviews.colLiveRole}}** (their role now), **{{ui:accessReviews.colLastSignIn}}** and **{{ui:accessReviews.colDecision}}**. {{ui:accessReviews.colLastSignIn}} is the most recent time the person signed in to Inflect, through any of their sessions, including sessions that have since been signed out or revoked. It is not limited to this workspace, so a person who works mostly in another workspace still shows their real last sign-in. A person who has never signed in reads **{{ui:accessReviews.never}}**. For a review of directory accounts: the **{{ui:accessReviews.colAccount}}**, whether it is a **{{ui:accessReviews.directoryAdmin}}** or **{{ui:accessReviews.directoryUser}}**, whether MFA is enrolled, and its **{{ui:accessReviews.colHrContext}}**: the worker it is linked to in your HR system, or **{{ui:accessReviews.hrUnlinked}}**.

For a review of registered agents: the **{{ui:accessReviews.colAgent}}**, its **{{ui:accessReviews.colAgentOwner}}**, its **{{ui:accessReviews.colAgentGrants}}**, its **{{ui:accessReviews.colAgentPack}}** and the decision. The pack column sums up the pack the agent is decided from: how many of its grants went unused in the review window, its harness level and drift, guard flags, kills and whether its breaker tripped, how many payment rails it holds a spending authority on and how many of those nobody else has reviewed, and who prepared the pack. When a section of a pack hit its size limit, a warning says so, for example **{{ui:accessReviews.agentPackGrantsTruncated}}**: that section does not list everything, so do not read it as complete. Below the subjects sit **{{ui:accessReviews.agentNarrowingsTitle}}**, **{{ui:accessReviews.agentWithdrawalsTitle}}** when a pack proposes one and, once the campaign is closed, **{{ui:accessReviews.agentSampleTitle}}**.

## What you can do

### Decide on a subject

Click **{{ui:accessReviews.decidePrompt}}** on a row and choose:

- **{{ui:accessReviews.confirmAccess}}**: the access stays as it is.
- **{{ui:accessReviews.revokeAccess}}**: the access is removed when the campaign closes.
- **{{ui:accessReviews.modifyRole}}**: the person moves to a **{{ui:accessReviews.targetRole}}** when the campaign closes.

Add a justification, then click **{{ui:accessReviews.submitDecision}}**. A justification is optional for a confirmation and recommended for anything else.

Nothing changes when you decide. Every revocation and role change is carried out together when the campaign closes.

### Review registered agents

1. While the campaign is open and has no packs, an Owner or Admin clicks **{{ui:accessReviews.agentPreparePacks}}**. The campaign's preparing agent builds a pack for every agent but itself; its own pack is built by a second preparing agent or, when there is none, by the person who pressed the button. A large campaign is prepared in the background: the page reads **{{ui:accessReviews.agentPacksQueued}}**, then shows how many agents are done with a progress bar, and updates by itself when the packs are ready.
2. Under **{{ui:accessReviews.agentNarrowingsTitle}}**, each pack proposes removing grants its agent held for the whole 90-day window before the campaign and never called. Click **{{ui:accessReviews.narrowingAccept}}** or **{{ui:accessReviews.narrowingReject}}**. Removing a grant takes effect at once. An agent's narrowings must all be decided before the agent can be.
3. Under **{{ui:accessReviews.agentWithdrawalsTitle}}**, a pack proposes withdrawing an agent's spending authority on a payment rail when it had expired by the end of the review window, when it is still waiting to be suspended after the agent's kill switch was used, when no second person has reviewed it, or when it expires before the campaign's due date. Each row says which of these apply. If you know an agent can no longer pay on a rail, for example because its payment code was removed, use the button beside the agent's decision that says it can no longer pay on that rail. That adds a proposed withdrawal in your name, which you then accept or reject like the others; a scan cannot tell Inflect this, so a person has to. Click **{{ui:accessReviews.withdrawalAccept}}** or **{{ui:accessReviews.withdrawalReject}}**. Withdrawing takes effect on the register at once, and the agent's owner gets a task to cancel the payment token with the agent platform, because Inflect cannot cancel it. If the spending authority was declared again after the pack was prepared, it is left as it is. An agent's spending withdrawals must all be decided before the agent can be.
4. Decide each agent: **{{ui:accessReviews.agentConfirm}}**, **{{ui:accessReviews.agentRevoke}}** or **{{ui:accessReviews.agentModify}}**. A pack never proposes a lower limit: to reduce a spending authority rather than withdraw it, change it on [the agent's page](../manage/agent-detail.md#record-what-it-may-spend).
5. When the campaign closes, some decisions are drawn for a second review. The campaign's reviewer, or a member who can manage the agent register, answers each with **{{ui:accessReviews.sampleConcur}}**, **{{ui:accessReviews.sampleIndeterminate}}** or a reason for dissent. Nobody answers a decision they made or an agent they own.

After closing, the page shows whether the evidence file still matches the campaign's stored decisions, with its SHA-256 fingerprint.

### Discard a decision

If a decision was recorded against the wrong person or with the wrong verdict, click **{{ui:accessReviews.undoVerdict}}** on it, say why, and click **{{ui:accessReviews.undoConfirm}}**. The subject is undecided again. The discarded decision and your reason stay on the record.

### Close the campaign

When every subject is decided, an Owner or Admin clicks **{{ui:accessReviews.closeCampaign}}**, reads what will happen, and clicks **{{ui:accessReviews.closeGenerate}}**. Closing carries out every **{{ui:accessReviews.verdictLabels.REVOKE}}** and **{{ui:accessReviews.verdictLabels.MODIFY}}** decision and generates the evidence PDF.

A campaign with no subjects, or with any subject still undecided, cannot be closed. In a review of registered agents, every proposed narrowing and spending withdrawal must be decided too.

### Download the evidence

**{{ui:accessReviews.downloadEvidence}}** downloads the PDF: every subject, the decision, who made it, when and why. If the PDF could not be made when the campaign closed, an Owner or Admin can click **{{ui:accessReviews.regenerateEvidence}}**.

## What happens next

- Revoked members lose access to the workspace, and members moved to another role have it, as soon as the campaign closes.
- For directory accounts, closing creates remediation tasks to remove or change the access in the directory itself.
- The evidence PDF stays with the closed campaign, ready for an auditor.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:accessReviews.rosterEmpty}}** | Nobody was in scope when the campaign started | Start a new campaign with a wider scope |
| **{{ui:accessReviews.truncatedTitle}}** | The scope held more subjects than one campaign can, and only part of it was taken | Split the review into several campaigns |
| **{{ui:accessReviews.coverageUnverifiedTitle}}** | The subjects came from an application's connector, and nothing checked the list was complete | Check the application's own user list against it |
| **{{ui:accessReviews.agentPacksPreparationFailed}}** | The background preparation of the reviewer packs stopped | Click **{{ui:accessReviews.agentPreparePacks}}** again |
| **{{ui:accessReviews.agentPacksPreparationUnknown}}** | The page could not read whether the packs are being prepared | Reload the page in a moment |
| **{{ui:accessReviews.submitFailed}}**, **{{ui:accessReviews.closeFailed}}**, or a reason the server gave | The decision was not recorded, or the campaign was not closed | Follow the reason given, then try again |

## Related

- [{{ui:accessReviews.title}}](access-reviews.md), every campaign in the workspace.
- [Run an access review](../../how-to/access-reviews/run-an-access-review.md).
- [Record access review decisions](../../how-to/access-reviews/record-access-review-decisions.md).
