# Attach evidence to a control

Evidence shows that a control is in place, for example a signed policy, a screenshot of a setting or an export from another system. Attach it on the control's own page, by uploading a file or linking a web address. Evidence already in the workspace's library can be linked to the control from **{{ui:nav.evidence}}**.

## Before you start

- You need the Owner, Admin or Editor role. Readers, Auditors and AI admins can see a control's evidence but cannot add any. With a custom role, what you can do depends on the permissions your role was given.
- A file you upload and a link you add both become records in the evidence library, linked to the control. There they can be submitted for review and approved.
- The file picker offers PDF, Word (.doc, .docx), Excel (.xls, .xlsx), CSV, text, JSON, ZIP and image files (JPG, PNG, GIF, WebP).
- A link needs a full web address, such as one starting with https://, and a title.

## Steps

1. Click **{{ui:nav.controls}}** under {{ui:nav.govern}} in the sidebar.
2. Double-click the control's row. The control's page opens. A single click only ticks the row.
3. Click the **{{ui:controls.detailPage.tabEvidence}}** tab.
4. Click **{{ui:panels.evidenceForm.addTrigger}}**, the button with a plus sign. A form opens.
5. To upload a file:
    - Under {{ui:panels.evidenceForm.uploadFile}}, choose the file. Its name and size appear below the picker.
    - In {{ui:panels.evidenceForm.labelTitle}}, type a name for the evidence if you want one. Without it, the evidence is named after the file.
    - Once a file is chosen, the link fields below are greyed out.
6. To link a web address instead, leave the file picker empty. Type the address in {{ui:panels.evidenceForm.orLinkUrl}}, and a name for the link in {{ui:panels.evidenceForm.labelTitle}}. A link always needs a title, as the line under the address box says: {{ui:panels.evidenceForm.linkNeedsTitle}}
7. Click **{{ui:panels.evidenceForm.add}}**. It stays greyed out until you choose a file, or type both an address and a title. While it works it reads {{ui:panels.evidenceForm.uploading}} or {{ui:panels.evidenceForm.linking}}.
8. The form closes, and the evidence appears in the table and in {{ui:nav.evidence}}. The count on the {{ui:controls.detailPage.tabEvidence}} tab goes up by one.

Some links in the table may be plain links. A plain link was saved on the control only, as every link added to a control was before links became library records. It is not in the library and has no review status. The table shows the two apart:

| Column | A file or link you add | A plain link |
| --- | --- | --- |
| {{ui:sharedPanels.evidenceTab.colType}} | **{{ui:evidence.typeLabels.FILE}}** or **{{ui:evidence.typeLabels.LINK}}** | **{{ui:sharedPanels.evidenceTab.linkKinds.LINK}}** |
| {{ui:sharedPanels.evidenceTab.colTitle}} | The evidence's name. Click it to open the record in {{ui:nav.evidence}}. A link's address sits under the name; click the address to open the page in a new tab | The address, which opens the page in a new tab, with its note under it |
| {{ui:sharedPanels.evidenceTab.colAddedBy}} | The name of the person who added it to this control | The name of the person who added it |
| {{ui:sharedPanels.evidenceTab.colStatus}} | **{{ui:evidence.statusLabels.DRAFT}}** at first | {{ui:sharedPanels.evidenceTab.noReviewStatus}} |
| {{ui:sharedPanels.evidenceTab.colDate}} | When it was added | When it was linked |
| {{ui:sharedPanels.evidenceTab.colActions}} | Empty | **{{ui:sharedPanels.evidenceTab.remove}}** |

The {{ui:sharedPanels.evidenceTab.colActions}} column appears only for roles that can add evidence.

## Link evidence that is already in the library

One evidence record can support several controls.

1. Click **{{ui:nav.evidence}}** under {{ui:nav.comply}} in the sidebar. The {{ui:evidence.title}} opens.
2. Click the evidence. Its details open at the side of the page, with the list of controls it is used by.
3. Below that list, choose the control in **{{ui:evidence.detail.linkControlPlaceholder}}**, then click **{{ui:evidence.detail.linkControlButton}}**.

The control joins the list, and the evidence appears on the control's {{ui:controls.detailPage.tabEvidence}} tab with its current status.

When you add a file, a text note or a link on this page with **{{ui:evidence.addEvidence}}**, you can pick its control in **{{ui:evidence.upload.linkControlLabel}}** as you create it. A link added this way, with **{{ui:evidence.list.createLink}}**, is the same kind of library record as a link added on the control.

## Remove evidence from a control

- **A file, a link or other library record:** its row on the control has no remove button. Click its name to open it in {{ui:nav.evidence}}, then click the cross beside the control in its list of controls. For five seconds a message reads {{ui:evidence.detail.controlUnlinked}} and offers **{{ui:evidence.detail.undo}}**. The record stays in the library; only its link to the control goes.
- **A plain link:** on the control's {{ui:controls.detailPage.tabEvidence}} tab, click **{{ui:sharedPanels.evidenceTab.remove}}** on its row. For five seconds a message reads {{ui:controls.detailPage.evidenceUnlinked}} and offers **{{ui:controls.detailPage.undo}}**. The link is removed when the time runs out.

## What happens next

- A file or link you add starts as {{ui:evidence.statusLabels.DRAFT}}. Nobody has reviewed it yet.
- To have it reviewed, open it in {{ui:nav.evidence}} and click **{{ui:evidence.detail.submitForReview}}**. Owners, Admins and Editors can do this. Its status becomes {{ui:evidence.statusLabels.SUBMITTED}}.
- An Owner or Admin then opens it and clicks **{{ui:evidence.detail.approve}}** or **{{ui:evidence.detail.reject}}**. The person who submitted it for review cannot approve or reject it; someone else must.
    - Approved evidence reads {{ui:evidence.statusLabels.APPROVED}}.
    - To reject, the reviewer gives a reason in **{{ui:evidence.reject.reasonLabel}}**. The evidence reads {{ui:evidence.statusLabels.REJECTED}} and can be sent again with **{{ui:evidence.detail.resubmit}}**.
- The control's {{ui:controls.detailPage.tabEvidence}} tab shows the same status as the library.
- On the **{{ui:nav.controls}}** page, the {{ui:controls.colHeaders.evidence}} column counts each control's files and links together.
- Adding, linking and removing evidence is recorded in the workspace's audit log.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| There is no **{{ui:panels.evidenceForm.addTrigger}}** button on the tab | Your role cannot add evidence | Ask an Owner, Admin or Editor |
| **{{ui:panels.evidenceForm.add}}** stays greyed out | No file is chosen, or an address is typed without a title | Choose a file, or type both an address and a title |
| A red box appears in the form after you add a file, and the file is not in the table | The file was refused. The box gives the reason: its type may not be accepted, it may be too large, or the malware scan may have rejected it | Check the file type against the list above. Try a smaller file, or ask an Owner or Admin |
| A red box appears in the form after you add a link, and the link is not in the table | The link was refused. The box gives the reason, for example that your role cannot add evidence to the library | Follow the reason given. If your role is the cause, ask an Owner or Admin |
| {{ui:controls.detailPage.errors.linkEvidenceFailed}} | The link was not saved, and no reason came back | Check that the address is complete, then try again. If it keeps failing, reload the page |
| {{ui:controls.detailPage.couldntLoadEvidence}} | The control's evidence could not be loaded | Reload the page |
| A plain link you removed comes back in the table | The removal did not go through | Reload the page and remove it again |
| A red message under the control picker in the evidence's details panel, and the control is not linked | The link was refused. The message gives the reason, for example that the control was not found. {{ui:evidence.detail.linkControlFailed}} means no reason came back | Follow the reason given. Otherwise reload the page and try again |
| An error message when you approve or reject evidence | The review was refused. The message gives the reason: you submitted the evidence yourself, it was reviewed already, or a rejection has no reason. {{ui:evidence.list.reviewFailed}} means no answer came back | If you submitted it, ask another Owner or Admin to review it. Otherwise reload the page to see its current status |
