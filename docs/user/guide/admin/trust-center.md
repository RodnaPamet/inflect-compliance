---
route: /t/[tenantSlug]/admin/trust-center
---

# {{ui:admin.trustCenter.title}}

The {{ui:admin.trustCenter.title}} page is where you write and publish the workspace's public trust page: a page on the open internet that tells customers and prospects how you handle security, which frameworks you follow, and which documents they can read or ask for. This page edits it; [the public page](public-trust-center.md) is what visitors see.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.security}}, click **{{ui:admin.nav.trustCenter}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.trustCenter.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, edit and save the content | Owner, Admin |
| Add documents on request, approve access requests | Owner, Admin |
| Publish or unpublish the page | Owner |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin sees **{{ui:admin.trustCenter.publishRequiresOwner}}** where the publish button would be.

## What it is for

Prospects and customers ask for security information before they buy. A trust page answers the common questions once, publicly, and lets them ask for the documents you only share on request, such as a SOC 2 report.

Nothing on the trust page is drawn from the workspace's live data. Every word on it is something you typed here, so nothing private reaches it by accident. It stays unpublished until an Owner publishes it.

## What you see

Under the title, a badge reads **{{ui:admin.trustCenter.statusPublic}}** or **{{ui:admin.trustCenter.statusNotPublished}}**, followed by the page's public address.

**{{ui:admin.trustCenter.content}}.**

| Field | What it is |
| --- | --- |
| {{ui:admin.trustCenter.displayName}} | The organisation name shown at the top. Required |
| {{ui:admin.trustCenter.tagline}} | A short line under the name |
| {{ui:admin.trustCenter.postureSummary}} | A few paragraphs on how you approach security. {{ui:admin.trustCenter.postureSummaryDesc}} |
| {{ui:admin.trustCenter.securityContact}} | Where visitors report a security issue |
| {{ui:admin.trustCenter.frameworksToShow}} | Each framework's name and the status you choose to state, such as "Type II — current". {{ui:admin.trustCenter.frameworksDesc}} |
| {{ui:admin.trustCenter.publishedDocuments}} | Each document's label and its web address. {{ui:admin.trustCenter.publishedDocumentsDesc}} |
| {{ui:admin.trustCenter.searchIndexing}} | Whether search engines may list the page. Off by default |

**{{ui:admin.trustCenter.publicPreview}}.** Beside the form, the page as visitors would see it, drawn from what is in the form now, saved or not.

**{{ui:admin.trustCenter.gated.title}}.** {{ui:admin.trustCenter.gated.intro}} The documents added so far, and a form to add another.

**{{ui:admin.trustCenter.gated.requestsTitle}}.** {{ui:admin.trustCenter.gated.requestsIntro}} Each request shows who asked and for which document, its status (**{{ui:admin.trustCenter.gated.status.REQUESTED}}**, **{{ui:admin.trustCenter.gated.status.APPROVED}}** or **{{ui:admin.trustCenter.gated.status.DENIED}}**), when it was made, whether they accepted the non-disclosure terms, and when the document was downloaded or when the link expires.

## What you can do

### Edit the content

Fill in the fields. Click **{{ui:admin.trustCenter.framework}}** or **{{ui:admin.trustCenter.document}}** to add a row, and the bin icon to remove one. Click **{{ui:admin.trustCenter.save}}**; **{{ui:admin.trustCenter.toastSaved}}** confirms it. A framework or document row with an empty field is left out when you save. If the page is already published, saved changes appear on it at once.

### Publish the page

Save your content first: publishing makes the saved content public, not what is in the form. Then click **{{ui:admin.trustCenter.publish}}**. A dialog, **{{ui:admin.trustCenter.confirmTitle}}**, reminds you that anyone can open it with no sign-in. Click **{{ui:admin.trustCenter.confirmLabel}}**. The badge turns to **{{ui:admin.trustCenter.statusPublic}}**.

To take it down, click **{{ui:admin.trustCenter.unpublish}}**. Visitors then find nothing at the address. The content is kept.

### Offer a document on request

Under **{{ui:admin.trustCenter.gated.title}}**, give the document the name visitors will see, choose its file, and click **{{ui:admin.trustCenter.gated.upload}}**. The public page lists it by name, and a visitor must ask for it before they can open it.

### Approve a request

Click **{{ui:admin.trustCenter.gated.approve}}** on a request. A box appears with the download link, which is shown only this once: copy it with **{{ui:admin.trustCenter.gated.copyLink}}**, or click **{{ui:admin.trustCenter.gated.emailLink}}** to open an email to the requester with the link in it. Inflect does not send it for you. The link works once and expires after 7 days. Click **{{ui:admin.trustCenter.gated.dismissLink}}** when it is sent.

## What happens next

- Saving, publishing and unpublishing are each recorded in the workspace's audit log.
- When the requester opens the link, the request shows when the document was downloaded, and the link stops working.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.trustCenter.toastSaveFailed}}** | The content was not saved, for example because a document's address is not a valid web address | Check the fields and save again |
| **{{ui:admin.trustCenter.toastPublishFailed}}** | The page was not published or unpublished | Try again |
| **{{ui:admin.trustCenter.gated.emptyDocuments}}** | No document is offered on request | Add one, if you want visitors to ask for it |
| **{{ui:admin.trustCenter.gated.needLabelAndFile}}** | The name or the file is missing | Fill in both |
| **{{ui:admin.trustCenter.gated.emptyRequests}}** | Nobody has asked for a document | Nothing |
| **{{ui:admin.trustCenter.gated.loadFailed}}** or **{{ui:admin.trustCenter.gated.requestsLoadFailed}}** | That section did not load | Reload the page |

## Related

- [The public trust page](public-trust-center.md), what visitors see and how they ask for a document.
- [{{ui:admin.auditLog}}](audit-log.md), where publishing is recorded.
