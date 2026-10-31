---
route: /t/[tenantSlug]/vendors/[vendorId]
---

# A vendor

A vendor's page is where you manage one supplier: who they are, how much access they have to your data, how risky they are, the documents and assessments that prove it, and the subprocessors they rely on.

## Where to find it

Open **{{ui:nav.vendors}}** under **{{ui:nav.manage}}** and click a vendor's name. The breadcrumb ends **{{ui:vendors.detail.crumbVendors}}** › the vendor's name. Arrows beside the title step to the previous or next vendor in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the vendor and every tab | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Edit the vendor, fill it in from its website, add documents, links and subprocessors | Owner, Admin, Editor |
| Send or resend a questionnaire, create and freeze evidence bundles | Owner, Admin, Editor |

If your workspace uses custom roles, the page offers only what your role's permissions allow.

## What it is for

Keep each supplier's risk on record and up to date: what they do for you, what they can reach, how they answered your questionnaire, which certificates they hold and when their contract and review fall due.

## What you see

**The header.** The vendor's name, its **{{ui:vendors.detail.status}}** and **{{ui:vendors.detail.criticality}}**. On the right, if you can edit, **{{ui:vendors.detail.autofill}}** when the vendor has a domain or website, and the pencil to edit.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:vendors.detail.tabs.overview}}** | The vendor's details, its risk and its key dates |
| **{{ui:vendors.detail.tabs.documents}}** | Contracts, certificates, reports and other files or links, sorted into folders |
| **{{ui:vendors.detail.tabs.assessments}}** | Questionnaires sent to the vendor, their answers and scores |
| **{{ui:vendors.detail.tabs.monitoring}}** | Signals collected about the vendor, such as breaches or certificate changes |
| **{{ui:vendors.detail.tabs.links}}** | The controls, risks, assets and other records the vendor is linked to |
| **{{ui:vendors.detail.tabs.bundles}}** | Evidence bundles: a set of the vendor's documents and answers, frozen at a point in time |
| **{{ui:vendors.detail.tabs.subprocessors}}** | The vendors this vendor passes your data on to, and their own subprocessors |
| **{{ui:vendors.detail.tabs.tasks}}** | The tasks linked to the vendor |

**The overview.** **{{ui:vendors.detail.legalName}}**, **{{ui:vendors.detail.domain}}**, **{{ui:vendors.detail.website}}**, **{{ui:vendors.detail.country}}**, **{{ui:vendors.detail.owner}}**, **{{ui:vendors.detail.dataAccess}}**, **{{ui:vendors.detail.subprocessor}}**, **{{ui:vendors.detail.inherentRisk}}**, **{{ui:vendors.detail.nextReview}}** and **{{ui:vendors.detail.contractRenewal}}**. When the vendor has been filled in from its website, **{{ui:vendors.detail.enrichmentData}}** adds its **{{ui:vendors.detail.privacyPolicy}}**, **{{ui:vendors.detail.securityPage}}** and **{{ui:vendors.detail.certifications}}**.

## What you can do

### Edit the vendor

Click the pencil in the header, change the fields and click **{{ui:vendors.detail.save}}**.

### Fill it in from its website

Click **{{ui:vendors.detail.autofill}}**. The app reads the vendor's public website and adds what it finds, such as its privacy policy and security page.

### Add a document

On **{{ui:vendors.detail.tabs.documents}}**, click **{{ui:vendors.detail.addDocument}}**, choose a **{{ui:vendors.detail.type}}**, give a **{{ui:vendors.detail.title}}** and the document's **{{ui:vendors.detail.externalUrl}}**, and optionally a **{{ui:vendors.detail.folder}}** and **{{ui:vendors.detail.notes}}**. Removing a document gives you a few seconds to click **{{ui:vendors.detail.undo}}**.

### Send a questionnaire

1. On **{{ui:vendors.detail.tabs.assessments}}**, click **{{ui:vendors.detail.sendAssessment}}**.
2. Choose a **{{ui:vendors.detail.template}}**, and give the **{{ui:vendors.detail.respondentEmail}}** and, optionally, their name and how many days the link lasts.
3. Send it.

The respondent gets an email with a link to answer, without an account. The page also shows the link once, so you can send it another way: {{ui:vendors.detail.linkOneTimeWarning}}

Questionnaires waiting for an answer are listed under **{{ui:vendors.detail.outstandingTitle}}**. **{{ui:vendors.detail.resendInvite}}** sends a reminder with a fresh link. Answered questionnaires show their score and risk rating, and open for review.

### Link the vendor to other records

On **{{ui:vendors.detail.tabs.links}}**, choose an **{{ui:vendors.detail.entity}}**, pick the record and say how it relates to the vendor, then click **{{ui:vendors.detail.add}}**.

### Freeze an evidence bundle

On **{{ui:vendors.detail.tabs.bundles}}**, name a bundle and click **{{ui:vendors.detail.createBundle}}**. Add the documents and answers that show the vendor's position, then click **{{ui:vendors.detail.freeze}}**. A frozen bundle cannot change, so it shows an auditor exactly what you relied on at that date.

### Record subprocessors

On **{{ui:vendors.detail.tabs.subprocessors}}**, pick the vendor that acts as a subprocessor and give its **{{ui:vendors.detail.purpose}}**, the data it handles and its country.

## What happens next

- The next review and contract renewal dates appear on the calendar and on the vendors list.
- Answered questionnaires stay on **{{ui:vendors.detail.tabs.assessments}}** with their score, so the vendor's history of answers is kept.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:vendors.detail.notFound}}** | The vendor does not exist or is in another workspace | Go back to the list |
| **{{ui:vendors.detail.docsEmpty}}** | No document has been added | Add one |
| **{{ui:vendors.detail.assessEmptyTitle}}** | No questionnaire has been sent | Send one |
| **{{ui:vendors.detail.linksEmptyTitle}}**, **{{ui:vendors.detail.bundlesEmptyTitle}}** or **{{ui:vendors.detail.subsEmptyTitle}}** | That tab has nothing yet | Add what is missing |
| **{{ui:vendors.detail.templatesNonePublished}}** | There is no published questionnaire template to send | Publish one first: {{ui:vendors.detail.templatesNoneHint}} |
| **{{ui:vendors.detail.inviteExpired}}** or **{{ui:vendors.detail.inviteRevoked}}** | The respondent's link no longer works | Click **{{ui:vendors.detail.resendInvite}}** |
| **{{ui:vendors.detail.sendRefused.SEND_RESPONDENT_EMAIL_INVALID}}** | The respondent's email address is not valid | Correct it and send again |
| **{{ui:vendors.detail.sendRefused.SEND_TEMPLATE_DRAFT}}** | The template chosen is still a draft | Publish the template, or choose a published one |
| **{{ui:vendors.detail.sendRefused.SEND_ALREADY_IN_FLIGHT}}** | The respondent already has this questionnaire to answer | Click **{{ui:vendors.detail.resendInvite}}** on the waiting questionnaire |
| **{{ui:vendors.detail.sendFailed}}** | The questionnaire was not sent, for another reason | Try again |
| **{{ui:vendors.detail.loadDocsFailed}}**, **{{ui:vendors.detail.loadLinksFailed}}**, **{{ui:vendors.detail.loadBundlesFailed}}** or **{{ui:vendors.detail.loadSubsFailed}}** | That tab could not load | Reload the page |

## Related

- [{{ui:vendors.title}}](vendors.md), every vendor in the workspace.
- [Vendor questionnaire](vendor-questionnaire.md), what the respondent sees.
