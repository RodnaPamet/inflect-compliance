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
| Add and remove documents on request; approve or deny access requests, and issue new links | Owner, Admin |
| Publish or unpublish the page | Owner |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin sees **{{ui:admin.trustCenter.publishRequiresOwner}}** where the publish button would be.

## What it is for

Prospects and customers ask for security information before they buy. A trust page answers the common questions once, publicly, and lets them ask for the documents you only share on request, such as a SOC 2 report.

Nothing on the trust page is drawn from the workspace's live data. Every word on it is something you typed here, so nothing private reaches it by accident. It stays unpublished until an Owner publishes it.

## What you see

Under the title, a badge reads **{{ui:admin.trustCenter.statusPublic}}** or **{{ui:admin.trustCenter.statusNotPublished}}**. Below it, **{{ui:admin.trustCenter.publicUrlLabel}}** gives the page's full web address, as a link that opens it and with a **{{ui:admin.trustCenter.copyAddress}}** button. Until the page is published, a note says: {{ui:admin.trustCenter.notPublishedNote}}

**{{ui:admin.trustCenter.content}}.**

| Field | What it is |
| --- | --- |
| {{ui:admin.trustCenter.displayName}} | The organisation name shown at the top. Required |
| {{ui:admin.trustCenter.tagline}} | A short line under the name |
| {{ui:admin.trustCenter.postureSummary}} | A few paragraphs on how you approach security. {{ui:admin.trustCenter.postureSummaryDesc}} |
| {{ui:admin.trustCenter.securityContact}} | Where visitors report a security issue |
| {{ui:admin.trustCenter.frameworksToShow}} | Each framework's name and the status you choose to state, such as "Type II — current". {{ui:admin.trustCenter.frameworksDesc}} |
| {{ui:admin.trustCenter.publishedDocuments}} | Each document's label and its web address. {{ui:admin.trustCenter.publishedDocumentsDesc}} |
| {{ui:admin.trustCenter.searchIndexing}} | A checkbox, **{{ui:admin.trustCenter.allowIndexing}}**. Off by default |

**{{ui:admin.trustCenter.publicPreview}}.** Beside the form, the page as visitors would see it, drawn from what is in the form now: {{ui:admin.trustCenter.previewDraftNote}}

While the form has edits that are not saved, a line under it says so: **{{ui:admin.trustCenter.unsavedPublished}}** on a published page, **{{ui:admin.trustCenter.unsavedDraft}}** on one that is not.

**{{ui:admin.trustCenter.gated.title}}.** {{ui:admin.trustCenter.gated.intro}} The documents added so far, each with a **{{ui:admin.trustCenter.gated.remove}}** button, and a form to add another.

**{{ui:admin.trustCenter.gated.requestsTitle}}.** {{ui:admin.trustCenter.gated.requestsIntro}} Each request shows who asked and for which document, its status (**{{ui:admin.trustCenter.gated.status.REQUESTED}}**, **{{ui:admin.trustCenter.gated.status.APPROVED}}** or **{{ui:admin.trustCenter.gated.status.DENIED}}**), when it was made, whether they accepted the non-disclosure terms, and when the document was downloaded, when the link expires, or that it has expired.

## What you can do

### Edit the content

Fill in the fields. Click **{{ui:admin.trustCenter.framework}}** or **{{ui:admin.trustCenter.document}}** to add a row, and the bin icon to remove one. Click **{{ui:admin.trustCenter.save}}**; **{{ui:admin.trustCenter.toastSaved}}** confirms it. If the page is already published, saved changes appear on it at once.

A row left wholly empty is simply not published. A row filled in halfway is marked in red (**{{ui:admin.trustCenter.rowIncompleteFramework}}** or **{{ui:admin.trustCenter.rowIncompleteDocument}}**), and so is a document address that is not a full web address (**{{ui:admin.trustCenter.rowBadUrl}}**). **{{ui:admin.trustCenter.save}}** stays greyed out until each one is fixed or removed.

### Publish the page

Click **{{ui:admin.trustCenter.publish}}**. A dialog, **{{ui:admin.trustCenter.confirmTitle}}**, gives the address and reminds you that anyone can open it with no sign-in. If you have unsaved edits, it adds: {{ui:admin.trustCenter.confirmSavesFirst}} Click **{{ui:admin.trustCenter.confirmLabel}}**. Your edits are saved, then the page is published, so what goes public is what you see; if the save is refused, nothing is published and the reason is shown. The badge turns to **{{ui:admin.trustCenter.statusPublic}}**.

To take it down, click **{{ui:admin.trustCenter.unpublish}}**. Visitors then find nothing at the address. The content is kept.

### Offer a document on request

Under **{{ui:admin.trustCenter.gated.title}}**, give the document the name visitors will see, choose its file, and click **{{ui:admin.trustCenter.gated.upload}}**. The public page lists it by name, and a visitor must ask for it before they can open it.

### Remove a document

Click **{{ui:admin.trustCenter.gated.remove}}** beside it. It leaves the list at once, and a message offers **{{ui:admin.trustCenter.gated.undo}}** for 5 seconds; after that it is removed from the trust page, with its access requests, and every link issued for it stops working. The uploaded file stays in the evidence library.

### Approve a request

Click **{{ui:admin.trustCenter.gated.approve}}** on a waiting request. A box appears with the download link, which is shown only this once: copy it with **{{ui:admin.trustCenter.gated.copyLink}}**, or click **{{ui:admin.trustCenter.gated.emailLink}}** to open an email to the requester with the link in it. Inflect does not send it for you. The link works once and expires after 7 days. Click **{{ui:admin.trustCenter.gated.dismissLink}}** when it is sent.

### Deny a request

Click **{{ui:admin.trustCenter.gated.deny}}** on a waiting request. **{{ui:admin.trustCenter.gated.denied}}** confirms it, and no link is issued. A denied request is final; the visitor can ask again from the public page, which makes a new request.

### Issue a new link

When an approved requester's link has expired, been used, or been lost, click **{{ui:admin.trustCenter.gated.reissue}}** on their request. A new link appears, as on approval, with the note: {{ui:admin.trustCenter.gated.linkReplaced}}

## What happens next

- Saving, publishing and unpublishing are each recorded in the workspace's audit log, and so are approving, denying, issuing a new link and removing a document.
- When the requester opens the link, the request shows when the document was downloaded, and the link stops working.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| A row marked in red | That framework or document is filled in halfway, or its address is not a full web address | Complete the row, or remove it |
| The reason the server gave, or **{{ui:admin.trustCenter.toastSaveFailed}}** | The content was not saved | Fix what it names and save again |
| The reason the server gave, or **{{ui:admin.trustCenter.toastPublishFailed}}** | The page was not published or unpublished | Try again |
| **{{ui:admin.trustCenter.gated.denyFailed}}** or **{{ui:admin.trustCenter.gated.removeFailed}}**, or the reason the server gave | The request was not denied, or the document not removed | Reload the page and try again |
| **{{ui:admin.trustCenter.gated.emptyDocuments}}** | No document is offered on request | Add one, if you want visitors to ask for it |
| **{{ui:admin.trustCenter.gated.needLabelAndFile}}** | The name or the file is missing | Fill in both |
| **{{ui:admin.trustCenter.gated.emptyRequests}}** | Nobody has asked for a document | Nothing |
| **{{ui:admin.trustCenter.gated.loadFailed}}** or **{{ui:admin.trustCenter.gated.requestsLoadFailed}}** | That section did not load | Reload the page |

## Related

- [The public trust page](public-trust-center.md), what visitors see and how they ask for a document.
- [{{ui:admin.auditLog}}](audit-log.md), where publishing is recorded.
