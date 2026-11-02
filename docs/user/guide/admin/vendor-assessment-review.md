---
route: /t/[tenantSlug]/admin/vendor-assessment-reviews/[assessmentId]
---

# An assessment review

An assessment's review page is where you read a vendor's answers to a questionnaire, check the score they produce, adjust it where the answers deserve it, set the vendor's risk rating, and close the assessment.

## Where to find it

On the [{{ui:vendors.reviewQueue.title}}](vendor-assessment-reviews.md) page, click the vendor. A vendor's own page also links to its assessments. The breadcrumb reads **{{ui:vendors.reviewQueue.crumbDashboard}}** › **{{ui:vendors.reviewQueue.crumbAdmin}}** › **{{ui:vendors.reviewQueue.title}}** › the vendor's name.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the review | Owner, Admin |
| Adjust points, set the rating, save the review, close the assessment, and pre-fill answers from a document | Owner, Admin |

Everyone else is refused the page.

## What you see

**The header.** The vendor, the questionnaire's name and version, and the assessment's status: **{{ui:vendors.statusLabel.SENT}}**, **{{ui:vendors.statusLabel.IN_PROGRESS}}**, **{{ui:vendors.statusLabel.SUBMITTED}}**, **{{ui:vendors.statusLabel.REVIEWED}}** or **{{ui:vendors.statusLabel.CLOSED}}**, with the date it was submitted.

**While the vendor is still answering**, **{{ui:vendors.statusLabel.SENT}}** or **{{ui:vendors.statusLabel.IN_PROGRESS}}**: **{{ui:admin.assessmentReview.awaitingTitle}}** The review controls open once the vendor submits.

**The scoring.** **{{ui:admin.assessmentReview.mode}}** (how the score is worked out: **{{ui:admin.assessmentReview.modeLabel.SIMPLE_SUM}}**, **{{ui:admin.assessmentReview.modeLabel.WEIGHTED_AVERAGE}}** or **{{ui:admin.assessmentReview.modeLabel.PASS_FAIL_THRESHOLD}}**), **{{ui:admin.assessmentReview.score}}**, **{{ui:admin.assessmentReview.autoSum}}** (the points the answers earned on their own), **{{ui:admin.assessmentReview.effectiveSum}}** (after your adjustments), and, where the scoring gives them, a **{{ui:admin.assessmentReview.verdict}}** (**{{ui:admin.assessmentReview.verdictLabel.PASS}}** or **{{ui:admin.assessmentReview.verdictLabel.FAIL}}**) and a **{{ui:admin.assessmentReview.suggestedRating}}**.

When the answers are high-risk enough, a risk is created in the register for you: {{ui:admin.assessmentReview.autoRiskCreated}} **{{ui:admin.assessmentReview.autoRiskView}}** opens it.

**The answers**, section by section. Each question shows its answer type, such as **{{ui:admin.vendorAnswerType.YES_NO}}**, whether it was **{{ui:admin.assessmentReview.required}}**, the **{{ui:admin.assessmentReview.submittedAnswer}}** (or **{{ui:admin.assessmentReview.noAnswer}}**), and the points it earned (**{{ui:admin.assessmentReview.auto}}**). While you review, each also has a box to override the points and **{{ui:admin.assessmentReview.notes}}**.

**{{ui:vendors.prefill.heading}}**, while the assessment is **{{ui:vendors.statusLabel.SUBMITTED}}**. {{ui:vendors.prefill.description}}

## What you can do

### Review the answers

When the assessment is **{{ui:vendors.statusLabel.SUBMITTED}}**:

1. Read each answer. Where an answer deserves more or fewer points than it earned, type the points in its override box, and say why in **{{ui:admin.assessmentReview.notes}}**.
2. Choose the **{{ui:admin.assessmentReview.finalRating}}**. The suggestion from the scoring is shown until you choose.
3. Add **{{ui:admin.assessmentReview.reviewerNotes}}** for the assessment as a whole.
4. Click **{{ui:admin.assessmentReview.saveReview}}**. The assessment becomes **{{ui:vendors.statusLabel.REVIEWED}}**.

### Pre-fill answers from a document

While the assessment is **{{ui:vendors.statusLabel.SUBMITTED}}**, and the vendor has given you a SOC 2, ISO or penetration-test report:

1. Under **{{ui:vendors.prefill.heading}}**, choose the **{{ui:vendors.prefill.document}}** and click **{{ui:vendors.prefill.prefillBtn}}**.
2. Each proposed answer appears with where in the document it came from and how confident the reading is. A report whose period has ended is flagged **{{ui:vendors.prefill.periodExpired}}**.
3. Click **{{ui:vendors.prefill.approve}}** or **{{ui:vendors.prefill.reject}}** on each. Only an approved answer is recorded and scored.

### Close the assessment

When it is **{{ui:vendors.statusLabel.REVIEWED}}**, click **{{ui:admin.assessmentReview.closeAssessment}}** and confirm **{{ui:admin.assessmentReview.closeConfirmTitle}}** {{ui:admin.assessmentReview.closeConfirmBody}} The page then shows when it was closed and the final rating.

Once an assessment is reviewed, its answers are the scored record: pre-filled answers can no longer be approved onto it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:admin.assessmentReview.notFound}} | The assessment does not exist in this workspace | Open it from the queue |
| {{ui:admin.assessmentReview.loadErrorNetwork}} | The assessment did not load | Reload the page |
| An error that saving failed, or {{ui:admin.assessmentReview.closeError}} | The review or the close did not go through | Read the reason, and try again |
| {{ui:vendors.prefill.proposalsFromDocMsg}} | The document gave no answers to propose | Answer from the document yourself, or choose another |
| {{ui:vendors.prefill.proposalsFailedMsg}} | The document could not be read | Try again, or review without it |

## Related

- [{{ui:vendors.reviewQueue.title}}](vendor-assessment-reviews.md), every assessment.
- [A vendor](../manage/vendor-detail.md), where an assessment is sent and its result is used.
- [Risks](../govern/risks.md), where an assessment's high-risk result appears.
