---
route: /vendor-assessment/[assessmentId]
---

# Vendor questionnaire

The vendor questionnaire is the page a vendor opens to answer your security assessment. It needs no account: the vendor's contact follows the personal link in their invitation email, answers the questions and submits. This guide is for both sides: the people who send questionnaires, and the vendors who answer them.

## Where to find it

A vendor reaches the page only from the link in their invitation email. The link is personal: it carries a key that lets that one questionnaire be opened, and nothing else in your workspace.

You send the invitation from the vendor's page in the [{{ui:vendors.title}}](vendors.md) register, by sending it an assessment.

A reminder email carries a fresh key, so its link opens the questionnaire. The new key replaces the old one: the link in the invitation, and in any earlier reminder, stops working, so the vendor should use the most recent email. The new link expires when the invitation's did.

## Who can use it

| Action | Who |
| --- | --- |
| Open and answer the questionnaire | Anyone holding the invitation link, until the questionnaire expires or is submitted |
| Send, remind about and review questionnaires | People in your workspace who can manage vendors; see [{{ui:vendors.title}}](vendors.md) |

## What it is for

It lets a vendor answer your due-diligence questions in one place, without an account, and lets you review the answers beside the vendor's record instead of in email threads.

## What you see

**The header.** A title naming the vendor being assessed, followed by the date to respond by, when one was set.

**The questions.** One per row, with a marker on the required ones. Each takes the kind of answer it was written for:

| Kind | How it is answered |
| --- | --- |
| Yes or no | Choose **{{ui:common.yes}}** or **{{ui:common.no}}** |
| Text | Type an answer |
| Number | Type a number |
| Scale | Choose a point on the scale, usually 1 to 5, with its end labels |
| One choice or several | Choose from the options |
| File | Files are not uploaded here. {{ui:external.vendorAssessment.fileUploadHint}} |

**{{ui:external.vendorAssessment.submit}}**, at the bottom.

## What you can do

### Answer and submit

Answer the questions and click **{{ui:external.vendorAssessment.submit}}**. Answers are not saved as you go: they stay only in the open browser tab, which warns before you close it, until you submit. If anything is missing or wrong, **{{ui:external.vendorAssessment.fixErrors}}** lists what to correct, and your answers stay on the page.

Once submitted, the page shows **{{ui:external.vendorAssessment.submittedTitle}}**, and the questionnaire cannot be opened again with the same link.

## What happens next

- The answers go to the workspace for review, on the vendor's assessment. Someone in the workspace reviews and scores them, and the review can move the vendor's next review date.
- To change answers after submitting, the vendor asks their contact for a new questionnaire.

## Empty and error states

| What the vendor sees | What it means | What to do |
| --- | --- | --- |
| **{{ui:external.vendorAssessment.loading}}** | The questionnaire is loading | Wait a moment |
| **{{ui:external.vendorAssessment.missingTokenTitle}}** | The page was opened without the personal key, for example from an address typed by hand | {{ui:external.vendorAssessment.errorMissingToken}} |
| **{{ui:external.vendorAssessment.errorTitle}}** with **{{ui:external.vendorAssessment.errorDefault}}** | The link is not the current one: a later reminder replaced it, or it was withdrawn | Use the link in your most recent email about the questionnaire, or ask your contact |
| **{{ui:external.vendorAssessment.errorTitle}}** with **{{ui:external.vendorAssessment.errorExpired}}** | The questionnaire has expired | Ask your contact for a new invitation |
| **{{ui:external.vendorAssessment.errorTitle}}** with **{{ui:external.vendorAssessment.errorWrongStatus}}** | It was already submitted or closed | Nothing more to do; ask your contact if you need to change something |
| **{{ui:external.vendorAssessment.networkTitle}}** | The page could not reach the server | Check your connection and click **{{ui:external.vendorAssessment.retry}}** |
| **{{ui:external.vendorAssessment.submitExpired}}** | It expired while you were answering | Copy what you need, then ask for a new link |
| **{{ui:external.vendorAssessment.submitRevoked}}** | The invitation was withdrawn while you were answering | Copy what you need, then contact the requester |
| **{{ui:external.vendorAssessment.submitNetworkFailed}}** | The answers did not reach the server | Check your connection and submit again |
| **{{ui:external.vendorAssessment.submitFailed}}** | The answers were not taken in | Try again in a moment |

## Related

- [{{ui:vendors.title}}](vendors.md), where assessments are sent and reviewed.
