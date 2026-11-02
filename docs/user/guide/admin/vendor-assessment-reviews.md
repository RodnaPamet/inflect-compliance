---
route: /t/[tenantSlug]/admin/vendor-assessment-reviews
---

# {{ui:vendors.reviewQueue.title}}

The {{ui:vendors.reviewQueue.title}} page lists the questionnaires sent to vendors: those the vendor has answered and that wait for your review, and those already reviewed or closed. {{ui:vendors.reviewQueue.description}}

## Where to find it

Open [{{ui:admin.crumb.admin}}](administration.md) and click **{{ui:admin.nav.vendorReviews}}**. The breadcrumb reads **{{ui:vendors.reviewQueue.crumbDashboard}}** › **{{ui:vendors.reviewQueue.crumbAdmin}}** › **{{ui:vendors.reviewQueue.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Everyone else is refused the page.

## What you see

One row per assessment:

| Column | What it shows |
| --- | --- |
| {{ui:vendors.reviewQueue.colVendor}} | The vendor, linked to the assessment's review page |
| {{ui:vendors.reviewQueue.colStatus}} | **{{ui:vendors.statusLabel.SENT}}**, **{{ui:vendors.statusLabel.IN_PROGRESS}}**, **{{ui:vendors.statusLabel.SUBMITTED}}**, **{{ui:vendors.statusLabel.REVIEWED}}** or **{{ui:vendors.statusLabel.CLOSED}}** |
| {{ui:vendors.reviewQueue.colScore}} | The score the vendor's answers earned |
| {{ui:vendors.reviewQueue.colRisk}} | The risk rating, once one is set |
| {{ui:vendors.reviewQueue.colSubmitted}} | When the vendor submitted it |

## What you can do

Click a vendor to open [the assessment's review](vendor-assessment-review.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:vendors.reviewQueue.emptyTitle}}** | {{ui:vendors.reviewQueue.emptyDesc}} | Nothing to do |
| {{ui:vendors.reviewQueue.loadErrorNetwork}} | The list did not load | Reload the page |

## Related

- [An assessment review](vendor-assessment-review.md), where one assessment is reviewed and closed.
- [{{ui:admin.vendorTemplates.title}}](vendor-templates.md), the questionnaires sent.
- [Vendors](../manage/vendors.md), where an assessment is sent to a vendor.
