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

Revoking or changing the access of an Owner or an AI admin needs a closer who is an Owner, because only an Owner can make that change on the members page.

## What it is for

Prove, periodically, that only the right people have access. Auditors ask for this under ISO 27001 and SOC 2: the evidence is the list of who was reviewed, who decided what, and that the decisions were carried out.

## What you see

**The header.** The campaign's name, its **{{ui:accessReviews.metaStatus}}**, which is **{{ui:accessReviews.statusLabels.OPEN}}**, **{{ui:accessReviews.statusLabels.IN_REVIEW}}** or **{{ui:accessReviews.statusLabels.CLOSED}}**, and how many subjects have been decided. On the right: **{{ui:accessReviews.downloadEvidence}}** once it exists, and **{{ui:accessReviews.closeCampaign}}** for Owners and Admins.

Under the header: **{{ui:accessReviews.dlReviewer}}**, **{{ui:accessReviews.dlScope}}**, the period, **{{ui:accessReviews.dlDue}}**, and **{{ui:accessReviews.dlClosed}}** once it is closed. Owners and Admins can click **{{ui:accessReviews.changeReviewer}}** and **{{ui:accessReviews.changeDueDate}}** while it is open.

**The subjects.** One row per person or account in scope. For a review of workspace members: **{{ui:accessReviews.colSubject}}**, **{{ui:accessReviews.colSnapshotRole}}** (their role when the campaign started), **{{ui:accessReviews.colLiveRole}}** (their role now), **{{ui:accessReviews.colLastActive}}** and **{{ui:accessReviews.colDecision}}**. For a review of directory accounts: the **{{ui:accessReviews.colAccount}}**, whether it is a **{{ui:accessReviews.directoryAdmin}}** or **{{ui:accessReviews.directoryUser}}**, whether MFA is enrolled, and its **{{ui:accessReviews.colHrContext}}**: the worker it is linked to in your HR system, or **{{ui:accessReviews.hrUnlinked}}**.

## What you can do

### Decide on a subject

Click **{{ui:accessReviews.decidePrompt}}** on a row and choose:

- **{{ui:accessReviews.confirmAccess}}**: the access stays as it is.
- **{{ui:accessReviews.revokeAccess}}**: the access is removed when the campaign closes.
- **{{ui:accessReviews.modifyRole}}**: the person moves to a **{{ui:accessReviews.targetRole}}** when the campaign closes.

Add a justification, then click **{{ui:accessReviews.submitDecision}}**. A justification is optional for a confirmation and recommended for anything else.

Nothing changes when you decide. Every revocation and role change is carried out together when the campaign closes.

### Discard a decision

If a decision was recorded against the wrong person or with the wrong verdict, click **{{ui:accessReviews.undoVerdict}}** on it, say why, and click **{{ui:accessReviews.undoConfirm}}**. The subject is undecided again. The discarded decision and your reason stay on the record.

### Close the campaign

When every subject is decided, an Owner or Admin clicks **{{ui:accessReviews.closeCampaign}}**, reads what will happen, and clicks **{{ui:accessReviews.closeGenerate}}**. Closing carries out every **{{ui:accessReviews.verdictLabels.REVOKE}}** and **{{ui:accessReviews.verdictLabels.MODIFY}}** decision and generates the evidence PDF.

A campaign with no subjects, or with any subject still undecided, cannot be closed.

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
| **{{ui:accessReviews.submitFailed}}**, **{{ui:accessReviews.closeFailed}}**, or a reason the server gave | The decision was not recorded, or the campaign was not closed | Follow the reason given, then try again |
| "HTTP" and a number | A request failed and the server gave no reason | Reload the page and try again |

## Related

- [{{ui:accessReviews.title}}](access-reviews.md), every campaign in the workspace.
- [Run an access review](../../how-to/access-reviews/run-an-access-review.md).
- [Record access review decisions](../../how-to/access-reviews/record-access-review-decisions.md).
