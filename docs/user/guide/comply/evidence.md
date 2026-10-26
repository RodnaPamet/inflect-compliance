---
route: /t/[tenantSlug]/evidence
---

# {{ui:evidence.title}}

The {{ui:evidence.title}} holds the workspace's evidence: the files, text notes and links that show your controls work in practice. One record can support several controls, and each record goes through review before it counts as approved.

## Where to find it

Click **{{ui:nav.evidence}}** under {{ui:nav.comply}} in the sidebar. The breadcrumb reads **{{ui:evidence.list.crumbDashboard}}** › **{{ui:evidence.title}}**. Links from other pages, such as a control's {{ui:controls.detailPage.tabEvidence}} tab or the calendar, open this page with one record's details already showing.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, search and filter it, and open any record's details | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Download a file | Owner, Admin, Editor. Readers, Auditors and AI admins only when the evidence is linked to at least one control |
| Add files, text notes, links and ZIP imports | Owner, Admin, Editor |
| Edit evidence, replace a file, set a retention date, archive and unarchive | Owner, Admin, Editor |
| Link evidence to a control, or unlink it | Owner, Admin, Editor |
| Submit for review, re-submit and re-review | Owner, Admin, Editor |
| Approve or reject, one record at a time or in bulk | Owner, Admin |
| Assign an owner in bulk | Owner, Admin, Editor |
| Delete in bulk | Owner, Admin |

Readers, Auditors and AI admins see no **{{ui:evidence.addEvidence}}** button and no edit, archive or review buttons, and they cannot tick rows or cards. **{{ui:evidence.list.bulkDelete}}** is for Owners and Admins. Every role sees the download button on every file, but a Reader, Auditor or AI admin who downloads a file from evidence with no control gets no file.

Whatever your role, nobody can approve or reject evidence they submitted for review; another Owner or Admin must do it. Only {{ui:evidence.statusLabels.SUBMITTED}} evidence can be approved or rejected, and a rejection needs a reason. Nobody can download archived evidence.

If your workspace uses custom roles, the page decides which buttons to show by the built-in role your custom role is based on. Saving checks the permissions the custom role was given, so a button can appear and still be refused. A custom role that cannot view controls cannot open this page.

## What it is for

Use the library to collect proof for your audits and keep it current. Add a piece of evidence once and link it to every control it supports. Have it reviewed, and give it a retention date so that it leaves the active set when it stops being valid. Approved evidence linked to controls is what an audit pack takes in.

## What you see

**Summary cards.** Four cards sit above the list: {{ui:evidence.list.kpiTotal}}, {{ui:evidence.list.kpiDraft}}, {{ui:evidence.list.kpiSubmitted}} and {{ui:evidence.list.kpiApproved}}. Click a status card to filter the list to that status, and click it again to drop the filter; {{ui:evidence.list.kpiTotal}} clears every filter. **{{ui:common.table.editKpiCards}}** on the toolbar adds four cards that filter by review currency: {{ui:evidence.filterEnums.freshness.current}}, {{ui:evidence.filterEnums.freshness.expiring}}, {{ui:evidence.filterEnums.freshness.expired}} and {{ui:evidence.filterEnums.freshness.needsReview}}. The cards count all of the workspace's evidence, archived and expired evidence included, while the list shows only active evidence by default, so a card can count more than the list shows.

**The toolbar.**

- **{{ui:evidence.addEvidence}}** opens a menu: {{ui:evidence.list.createFileUpload}}, {{ui:evidence.list.createTextNote}}, {{ui:evidence.list.createLink}} and {{ui:evidence.list.createBulkImport}}. Only roles that can add evidence see it.
- **{{ui:common.ui.filter}}** holds the search and the filters. Its search box, **{{ui:evidence.list.searchPlaceholder}}**, filters as you type. It matches titles, note text, link addresses and file names, and also the stored location of each uploaded file, so a word such as "evidence" or a year finds every file. The filters are {{ui:evidence.filters.type}}, {{ui:evidence.filters.status}}, {{ui:evidence.filters.retention}}, {{ui:evidence.filters.freshness}}, {{ui:evidence.filters.controlId}}, {{ui:evidence.filters.folder}} and {{ui:evidence.filters.category}}. Each active filter shows as a pill beside the button.
- {{ui:evidence.filters.retention}} chooses which part of the library you see: {{ui:evidence.list.retentionActive}}, the default; {{ui:evidence.list.triageExpiring}}, evidence whose next review date, or failing that its retention date, falls in the next 30 days; or {{ui:evidence.list.retentionArchived}}, archived or expired evidence.
- **{{ui:evidence.list.viewList}}** and **{{ui:evidence.list.viewGallery}}** switch between the table and a grid of cards. **{{ui:common.table.toggleColumns}}**, in the list view only, chooses which columns are shown. The filters and the view are kept in the page address, so a filtered view can be bookmarked or shared.

**The table.** The newest evidence comes first. Click a heading to sort, and click a row to open its details.

| Column | What it shows |
| --- | --- |
| {{ui:evidence.evidenceTitle}} | The evidence's name. Hover a long name to read all of it |
| {{ui:evidence.type}} | The kind of file, such as PDF, image or spreadsheet, or Link or Text |
| {{ui:evidence.control}} | The first linked control's code, with +1, +2 and so on for more. Hover it to see them all |
| {{ui:evidence.colHeaders.category}} and {{ui:evidence.colHeaders.folder}} | The labels set when the evidence was added or edited, or a dash |
| {{ui:evidence.colHeaders.retention}} | {{ui:evidence.list.retentionActive}}, Expiring with the days left (within 30 days of the retention date), {{ui:evidence.list.retentionExpired}}, {{ui:evidence.list.retentionArchived}}, or {{ui:evidence.list.retentionNoPolicy}} when there is no retention date. The date sits under the badge |
| {{ui:evidence.colHeaders.freshness}} | A coloured dot and an age, read from the next review date, or from the expiry date when there is no review date. It reads "today" while that date is ahead. Once it has passed it shows how long ago, turning amber after 30 days and red after 90. A dash means there is no date |
| {{ui:evidence.status}} | {{ui:evidence.statusLabels.DRAFT}}, {{ui:evidence.statusLabels.SUBMITTED}}, {{ui:evidence.statusLabels.APPROVED}}, {{ui:evidence.statusLabels.REJECTED}} or {{ui:evidence.statusLabels.NEEDS_REVIEW}} |
| {{ui:evidence.ownerLabel}} | The member who owns it, or the name typed on a text note |
| {{ui:evidence.colHeaders.actions}} | Icon buttons, described below |

The {{ui:evidence.colHeaders.actions}} column holds **{{ui:evidence.list.editEvidence}}**, **{{ui:evidence.list.archiveEvidence}}** (or **{{ui:evidence.list.unarchiveEvidence}}** on archived evidence) and, on files, **{{ui:evidence.list.downloadFile}}**. It also holds the review step that applies: **{{ui:evidence.submitForReview}}** on {{ui:evidence.statusLabels.DRAFT}} and {{ui:evidence.statusLabels.REJECTED}} evidence, **{{ui:evidence.list.reReview}}** on {{ui:evidence.statusLabels.NEEDS_REVIEW}} evidence, and, for Owners and Admins, **{{ui:evidence.approveEvidence}}** and **{{ui:evidence.rejectEvidence}}** on {{ui:evidence.statusLabels.SUBMITTED}} evidence. Files are scanned for viruses when they are uploaded: a file still being scanned shows **{{ui:evidence.scan.pending}}** in place of the download button. A file the scanner flagged shows **{{ui:evidence.scan.infected}}** and can never be downloaded.

**The gallery.** One card per record, with its freshness, retention and status badges. An image shows a thumbnail, and a PDF card reads **{{ui:common.ui.openPdf}}** and opens in a new tab. Each file that has passed the scan has a download button. Click a card to open its details. Roles that can edit evidence can also tick cards, and the selection bar offers only the actions your role can apply.

**The details panel.** It opens at the side of the page and shows, from top to bottom:

- The status. For a file, a preview of an image or PDF, and a **{{ui:evidence.detail.download}}** button.
- The type, owner and category; the task, risk or asset a file was uploaded from; the next review date; and the date of the last change. Evidence imported from SharePoint has a **{{ui:evidence.detail.viewInSharePoint}}** link.
- The controls the evidence is used by, or **{{ui:evidence.detail.noControlsLinked}}**.
- **{{ui:evidence.detail.descriptionLabel}}**: a note's text, or a link's address. A link opens in a new tab only when its address is safe to follow. An address starting with javascript:, data:, vbscript: or file: is shown as plain text that cannot be clicked.
- **{{ui:evidence.detail.usedByLabel}}**, counting the controls, risks and assets it supports, and its **{{ui:evidence.detail.tagsLabel}}**.
- **{{ui:evidence.detail.fileMetaTitle}}**: the file's name, size and type, its **{{ui:evidence.detail.fileHash}}** fingerprint with a copy button, and its retention and expiry dates. For a file, **{{ui:evidence.detail.versionsLabel}}** follows, with a download button for each earlier version.
- **{{ui:evidence.detail.reviewHistoryTitle}}**: each submission, approval and rejection, who made it, when, and any reason given.
- The tasks linked to the evidence. Roles that can add evidence also get a **{{ui:panels.linkedTasks.task}}** button to raise one.

The footer holds the edit button and the review buttons that apply. The panel does not refresh after you review or edit from it, and keeps showing the old status and buttons. Close it and open it again to see the change.

## What you can do

### Upload files

Choose **{{ui:evidence.addEvidence}}** › **{{ui:evidence.list.createFileUpload}}**. In the **{{ui:evidence.upload.title}}** form, drop files under **{{ui:evidence.upload.filesLabel}}** or click to browse. It accepts PDF, Word, Excel, CSV, text, JSON, ZIP and image files (JPG, PNG, GIF, WebP), up to 25 MB each. A screenshot is uploaded as an image file; there is no separate screenshot type.

The other fields are optional, and all but the title apply to every file: **{{ui:evidence.upload.titleLabel}}** (a single file only; several files are each named after their file), **{{ui:evidence.upload.retainLabel}}** (today or later), **{{ui:evidence.upload.linkControlLabel}}** (one control), **{{ui:evidence.upload.categoryLabel}}** and **{{ui:evidence.upload.folderLabel}}**. Click **{{ui:evidence.upload.upload}}**; **{{ui:evidence.upload.stop}}** cancels the uploads still running. Each file becomes its own record, and the form closes once every file has uploaded. When the workspace has SharePoint connected, **{{ui:evidence.upload.importSharePoint}}** picks files from there instead.

### Add a text note or a link

- **{{ui:evidence.list.createTextNote}}** opens **{{ui:evidence.text.title}}**. **{{ui:evidence.text.titleLabel}}** is required. **{{ui:evidence.text.linkControlLabel}}**, **{{ui:evidence.text.ownerLabel}}**, **{{ui:evidence.text.categoryLabel}}**, **{{ui:evidence.text.folderLabel}}** and **{{ui:evidence.text.contentLabel}}** are optional. The owner here is a name you type, not a member of the workspace. Click **{{ui:evidence.text.submit}}**. A note's text is always shown as plain text, so a web address typed into a note does not open as a link.
- **{{ui:evidence.list.createLink}}** opens **{{ui:evidence.linkModal.title}}**. **{{ui:evidence.linkModal.titleLabel}}** and **{{ui:evidence.linkModal.urlLabel}}** are required, and the address must be a full one, such as one starting with https://. Click **{{ui:evidence.linkModal.submit}}**. The address keeps any query string after the ? exactly as typed. Only spaces and characters such as < and > are encoded, which does not change where it points.

When you save any form on this page, markup such as HTML tags is removed from the text you typed: the title, note, category, folder, owner name and any rejection reason. A note's or a link's title made of nothing but markup is refused; an uploaded file is named after the file instead.

### Import a ZIP file

Choose **{{ui:evidence.list.createBulkImport}}**. In **{{ui:evidence.bulkImport.title}}**, drop one .zip file of up to 100 MB. If you want, choose a **{{ui:evidence.bulkImport.defaultControlLabel}}** and type a **{{ui:evidence.bulkImport.folderLabel}}** for every record it creates. Click **{{ui:evidence.bulkImport.startImport}}**. Inflect unpacks the file in the background, and each PDF, Office, image, CSV or JSON file in it becomes its own record; other files are skipped. The form shows the progress and, at the end, how many files were extracted, skipped or failed.

### Edit evidence or replace a file

Click **{{ui:evidence.list.editEvidence}}** on a row, or the pencil in the details panel. The **{{ui:evidence.edit.title}}** form holds **{{ui:evidence.edit.titleLabel}}**, a note's **{{ui:evidence.edit.descriptionLabel}}** or a link's **{{ui:evidence.edit.addressLabel}}** (a file has neither), **{{ui:evidence.edit.tagsLabel}}** separated by commas, **{{ui:evidence.edit.ownerLabel}}**, **{{ui:evidence.edit.categoryLabel}}**, **{{ui:evidence.edit.controlsLabel}}**, **{{ui:evidence.edit.folderLabel}}** and **{{ui:evidence.edit.retentionLabel}}**. Click **{{ui:evidence.edit.save}}**.

- Empty the description box to clear a note. A link's address cannot be cleared: **{{ui:evidence.edit.linkNeedsUrl}}** appears and the save button is greyed out. Clear the retention date to remove it.
- In a workspace with more than 100 controls, **{{ui:evidence.edit.controlsLabel}}** and the add forms offer only the first 100. Link the others from the details panel.
- For a file, choose a new file under **{{ui:evidence.edit.replaceFileLabel}}**. It uploads at once and the form closes, without saving any other change you typed in the form. The record keeps its controls, retention and review history, and the earlier file stays under {{ui:evidence.detail.versionsLabel}}.

### Review evidence

1. An Owner, Admin or Editor clicks **{{ui:evidence.submitForReview}}** on the row, or **{{ui:evidence.detail.submitForReview}}** in the details panel, and the evidence becomes {{ui:evidence.statusLabels.SUBMITTED}}. Rejected evidence is sent again with **{{ui:evidence.detail.resubmit}}**, and {{ui:evidence.statusLabels.NEEDS_REVIEW}} evidence with **{{ui:evidence.list.reReview}}**.
2. An Owner or Admin who did not submit it clicks **{{ui:evidence.approveEvidence}}** or **{{ui:evidence.rejectEvidence}}**.
3. To reject, type a **{{ui:evidence.reject.reasonLabel}}** in the **{{ui:evidence.reject.title}}** dialog, then click **{{ui:evidence.reject.confirm}}**.

### Link evidence to controls

In the details panel, choose a control in **{{ui:evidence.detail.linkControlPlaceholder}}**, then click **{{ui:evidence.detail.linkControlButton}}**. To unlink one, click the cross beside it. For five seconds a message reads {{ui:evidence.detail.controlUnlinked}} and offers **{{ui:evidence.detail.undo}}**. The evidence stays in the library either way.

### Archive and unarchive

Click **{{ui:evidence.list.archiveEvidence}}** on a row, and it leaves the {{ui:evidence.list.retentionActive}} view. To bring it back, choose {{ui:evidence.list.retentionArchived}} under {{ui:evidence.filters.retention}} and click **{{ui:evidence.list.unarchiveEvidence}}**. Evidence archived because its retention date passed cannot be unarchived while that date is still past. The page says so and tells you to set a new retention date first. Open **{{ui:evidence.list.editEvidence}}**, set a retention date that has not passed or clear the date, and save. Then click **{{ui:evidence.list.unarchiveEvidence}}**, and the evidence returns to {{ui:evidence.list.retentionActive}}.

### Change many records at once

In the list view, tick up to 100 rows, choose an action from **{{ui:common.table.chooseAction}}** and click **{{ui:common.table.apply}}**:

- **{{ui:evidence.list.bulkApprove}}**, for Owners and Admins, approves only the {{ui:evidence.statusLabels.SUBMITTED}} evidence you did not submit yourself. A message says how many were approved and skipped.
- **{{ui:evidence.list.bulkAssign}}** gives them all one owner. Leave the owner empty to unassign them.
- **{{ui:evidence.list.bulkDelete}}** asks you to confirm, then removes them from the library. There is no undo.

### Download a file

Click **{{ui:evidence.list.downloadFile}}** on a row, the download button on a gallery card, or **{{ui:evidence.detail.download}}** in the details panel. When the same file is uploaded to several records, Inflect keeps one copy that they share, and it downloads through a record that is still live. Archiving or deleting one of those records does not block the others.

## What happens next

- **New evidence** starts as {{ui:evidence.statusLabels.DRAFT}}. Nobody has reviewed it yet.
- **Approval and rejection** send a notification to the evidence's owner, when a member is set as owner. A rejection's notification carries the reason.
- **Changing approved evidence**, by editing its note or link address or replacing its file, sends it back to {{ui:evidence.statusLabels.SUBMITTED}}. Other edits leave the approval in place.
- **Review dates.** Once a day, approved evidence whose next review date has passed becomes {{ui:evidence.statusLabels.NEEDS_REVIEW}}. This page has no field for the next review date; evidence that an integration collects automatically carries one.
- **Retention dates.** Once a day, evidence whose retention date has passed is archived and marked {{ui:evidence.list.retentionExpired}}. Evidence archived that way is deleted for good 365 days after it expired, unless you give it a retention date that has not passed or clear its date. Evidence you archive yourself is kept.
- **Deleted evidence** leaves the library at once and is removed for good after 90 days. Until then an Owner or Admin can restore it through the Inflect API; this page has no restore button.
- **The audit log** records adding, editing, uploading, replacing, reviewing, archiving, linking, retention changes, deleting and downloading. An image or PDF shown in the details panel or the gallery is loaded the way a download is, so it is recorded as one too.
- **Audit packs** take in approved evidence that is linked to controls and is neither expired nor archived.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:evidence.noEvidence}}** | No evidence is active. Archived or expired evidence may still exist | Add evidence, or choose {{ui:evidence.list.retentionArchived}} under {{ui:evidence.filters.retention}} |
| **{{ui:evidence.list.emptyFilterTitle}}**, **{{ui:evidence.list.emptyArchivedTitle}}** or **{{ui:evidence.list.emptyExpiringTitle}}** | Nothing matches the search, the filters or the retention view | Click **{{ui:evidence.list.clearFilters}}** |
| **{{ui:evidence.list.archivedNoticeTitle}}** above the list | You are looking at archived evidence, which should not go into active audit packs | Unarchive what you need |
| A banner saying only the first 5,000 results are shown | The view holds more evidence than the page loads at once | Narrow it with a filter or the search |
| **{{ui:evidence.list.reviewFailed}}** | The review did not go through: you submitted the evidence yourself, it was reviewed already, or your role cannot review | Ask another Owner or Admin. Reload the page to see the current status |
| **{{ui:evidence.list.bulkFailed}}** | A bulk action was refused, for example because more than 100 rows were selected | Select fewer rows and try again |
| A red box in a form, with a reason | Nothing was saved. A file can be refused for its type or size, or because the malware scanner rejected it | Follow the reason given |
| **{{ui:evidence.upload.spProbeErrorTitle}}** | Inflect could not check the SharePoint connection, so its import is hidden | Reopen the form later, or ask an Admin to check the integration |
| **{{ui:evidence.edit.retentionFailed}}** | Your other changes were saved, but the retention date was not | Click **{{ui:evidence.edit.save}}** again |
| **{{ui:evidence.edit.updateFailed}}**, **{{ui:evidence.edit.replaceFailed}}** or **{{ui:evidence.detail.linkControlFailed}}** | The change was not saved | Reload the page and try again |
| A control you unlinked comes back in the details panel | The unlink did not go through | Reload the page and try again |
| The details panel stays on **{{ui:evidence.detail.loadingBody}}** | The record could not be loaded, for example because it was deleted | Close the panel and reload the page |
| A download gives no file | The evidence is archived, or your role needs it linked to a control first | Unarchive it, or ask an Owner, Admin or Editor to link it to a control |

## Related

- [Attach evidence to a control](../../how-to/get-started/attach-evidence-to-a-control.md), step by step from the control's own page.
- [Build an audit pack](../../how-to/audits/build-an-audit-pack.md), which takes in approved evidence.
- [{{ui:controls.list.pageTitle}}](../govern/controls.md), whose Evidence column counts the evidence linked to each control.
