---
route: /t/[tenantSlug]/vendors/dashboard
---

# {{ui:vendors.dashboard.title}}

The {{ui:vendors.dashboard.title}} sums up third-party risk across the vendor register: which reviews and renewals are due, which important vendors have never been assessed, what the monitoring has picked up, and how the register breaks down by criticality, status and assessed risk.

## Where to find it

Open **{{ui:nav.vendors}}** under **{{ui:nav.manage}}** in the sidebar and click the dashboard button in the toolbar. Its hint reads **{{ui:vendors.dashboardTooltip}}**. The back link returns you to the page you came from, and the button in the header, whose hint reads **{{ui:vendors.dashboard.registerTooltip}}**, opens the register.

## Who can use it

Every role can open the dashboard: Owner, Admin, Editor, Reader, Auditor and AI admin. It changes nothing.

## What it is for

Use it at the start of a vendor review cycle to see what is overdue or coming up, and which vendors carry risk nobody has assessed.

## What you see

**The header.** The title and the number of vendors in the register.

**The cards.**

| Card | What it counts | Link |
| --- | --- | --- |
| {{ui:vendors.dashboard.kpiTotal}} | Every vendor | None |
| {{ui:vendors.dashboard.kpiOverdueReviews}} | Vendors whose next review date has passed | The register, filtered to overdue reviews |
| {{ui:vendors.dashboard.kpiUpcomingReviews}} | Vendors whose next review falls within 30 days | The register, filtered to reviews due in 30 days |
| {{ui:vendors.dashboard.kpiOverdueRenewals}} | Vendors whose contract renewal date has passed | None |
| {{ui:vendors.dashboard.kpiUpcomingRenewals}} | Vendors whose contract renews within 30 days | None |
| {{ui:vendors.dashboard.kpiHighRisk}} | High and critical vendors whose latest assessment is not complete, or who have none | None |

These counts include every vendor in the register, offboarded ones too.

**{{ui:vendors.dashboard.continuousAssurance}}.** Three signals from the vendor monitoring:

- **{{ui:vendors.dashboard.kpiExpiredAttestations}}**: vendors whose SOC 2 report or certification, as read from their documents, has expired.
- **{{ui:vendors.dashboard.kpiRecentBreach}}**: vendors the monitoring linked to a breach in the last 90 days.
- **{{ui:vendors.dashboard.kpiOverdueReassessment}}**: active vendors whose assessment has not been reviewed for over a year. This is a different date from the next review date on the cards above, so the two numbers can differ.

**The breakdowns.**

- **{{ui:vendors.dashboard.byCriticality}}**: vendors by the business criticality your team assigned: {{ui:vendors.criticalityLabel.LOW}}, {{ui:vendors.criticalityLabel.MEDIUM}}, {{ui:vendors.criticalityLabel.HIGH}} or {{ui:vendors.criticalityLabel.CRITICAL}}.
- **{{ui:vendors.dashboard.byStatus}}**: {{ui:vendors.statusOption.ONBOARDING}}, {{ui:vendors.statusOption.ACTIVE}}, {{ui:vendors.statusOption.OFFBOARDING}} and {{ui:vendors.statusOption.OFFBOARDED}}.
- **{{ui:vendors.dashboard.byRiskRating}}**: vendors by the risk rating on their most recent assessment. A vendor whose most recent assessment has no rating yet is not counted.

**Expiring documents.** When any vendor document's validity ends within 30 days, a notice counts them and points you to the vendors' documents tabs.

## What you can do

- **Open overdue or upcoming reviews** from their cards.
- **Open the register** from the header button.

## What happens next

The dashboard is read-only. It catches up with changes in the register within about a minute: completing an assessment, setting a review date or offboarding a vendor moves the matching figures.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:vendors.dashboard.loadFailed}}** | The figures could not be read | Reload the page |
| **{{ui:vendors.dashboard.riskRatingEmpty}}** | No vendor has a rated assessment | Complete an assessment on a vendor's page |
| Every card at zero and empty breakdowns | The register has no vendors yet | Add vendors on the {{ui:nav.vendors}} page |

## Related

- [{{ui:nav.vendors}}](vendors.md), the register the cards link into.
- [A vendor](vendor-detail.md), where assessments, documents and review dates are kept.
