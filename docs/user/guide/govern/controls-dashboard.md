---
route: /t/[tenantSlug]/controls/dashboard
---

# {{ui:controls.dashboard.title}}

The {{ui:controls.dashboard.title}} sums up the whole control register on one page: how much of it is implemented, what is due, which controls lack evidence, how healthy the controls are and which ones give the best return on their cost.

## Where to find it

Open **{{ui:nav.controls}}** under **{{ui:nav.govern}}** in the sidebar, then click the dashboard button beside **{{ui:common.ui.viewsMenu}}** in the toolbar. Its tooltip reads **{{ui:controls.list.controlsDashboard}}**. The back link returns you to the page you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the dashboard and follow its links | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Run the **{{ui:controls.dashboard.consistencyCheck}}** | Owner, Admin |

The **{{ui:controls.dashboard.consistencyCheck}}** button appears only for Owners and Admins.

## What it is for

Use the dashboard to see where the register stands before you open the list: how far implementation has got, what needs attention this month, and which controls to fix first.

## What you see

**The header.** The title and the number of controls in the register.

**The cards.** Five cards across the top. Except for **{{ui:controls.dashboard.overdueTasks}}**, a card whose number is above zero links to the list of exactly the items it counts.

| Card | What it counts | Where its link goes |
| --- | --- | --- |
| {{ui:controls.dashboard.implementationProgress}} | The share of applicable controls whose status is Implemented, with a bar that turns green at 80% and amber at 50% | The controls list, filtered to implemented controls that apply |
| {{ui:controls.dashboard.overdueTasks}} | Open tasks attached to a control whose due date has passed | None: no list holds exactly these tasks. Open a control to see its tasks |
| {{ui:controls.dashboard.controlsDueSoon}} | Applicable controls whose next due date falls within 30 days. A control that is already overdue counts too | The controls list, showing only those controls |
| {{ui:controls.dashboard.applicability}} | Controls that apply, with the number marked not applicable underneath | The controls list, filtered to controls that apply |
| {{ui:controls.dashboard.missingEvidence}} | Controls with no approved, unexpired evidence linked. Controls marked not applicable, by their status or their applicability, are left out | The controls list, showing only those controls |

**{{ui:controls.dashboard.controlHealthTitle}}.** Five tiles count the controls in each health verdict: **{{ui:controls.health.verdict.HEALTHY}}**, **{{ui:controls.health.verdict.DEGRADED}}**, **{{ui:controls.health.verdict.AT_RISK}}**, **{{ui:controls.health.verdict.NOT_APPLICABLE}}** and **{{ui:controls.health.verdict.UNKNOWN}}**. A tile above zero links to the controls list filtered to that verdict. The information icon beside the heading explains the rule: health comes from a control's status, its next test date and its test runs in the last 90 days. A declared effectiveness estimate does not change health. In a very large register, a notice says that the counts cover only the first controls. If health could not be read, the section says **{{ui:controls.dashboard.controlHealthLoadFailed}}** with **{{ui:controls.dashboard.retry}}** instead of showing tiles.

**{{ui:controls.dashboard.statusDistribution}}.** One bar per control status that has at least one control, sized by its share of the register.

**{{ui:controls.dashboard.topOwners}}.** The five control owners with the most open tasks on their controls, each with a count. **{{ui:controls.dashboard.ownersEmptyTitle}}** shows when no control has an owner.

**{{ui:controls.dashboard.bestValueTitle}}.** Up to ten controls ranked by return on investment: the expected annual loss they protect against divided by what they cost per year. Each row shows the control, the saving and the cost, the multiple, and a badge saying whether the effectiveness behind the figure is **{{ui:controls.roi.source.MEASURED}}** from tests or **{{ui:controls.roi.source.DECLARED}}** by someone. A control appears only once it has an annual cost, an effectiveness and at least one linked risk with a quantified loss. Until one does, the section explains that the list will appear. If the list could not be read, it says **{{ui:controls.bestValue.loadFailed}}**

## What you can do

### Run the consistency check

Owners and Admins can click **{{ui:controls.dashboard.consistencyCheck}}**. While it runs, the page shows **{{ui:controls.dashboard.consistencyChecking}}** Then a **{{ui:controls.dashboard.consistencyResults}}** card opens with three counts:

- **{{ui:controls.dashboard.missingCode}}**: controls with no code.
- **{{ui:controls.dashboard.duplicateCodes}}**: controls that share a code with another.
- **{{ui:controls.dashboard.overdueTasks}}**: controls with an overdue open task.

A count above zero links to the controls list showing just the controls it found, with a banner saying so. When all three are zero, the card reads **{{ui:controls.dashboard.allPassed}}**.

To run it again after fixing something, click **{{ui:controls.dashboard.consistencyCheck}}** again.

### Drill into a number

Click any card or tile whose number is above zero, except **{{ui:controls.dashboard.overdueTasks}}**, which links nowhere. The list it opens keeps your place: use its banner, or **{{ui:controls.list.drillDown.clear}}**, to return to the full list.

## What happens next

The dashboard is read-only. It changes as the register does: implementing a control, linking approved evidence, completing a test run or closing a task moves the matching figures the next time the page loads.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:controls.dashboard.loadFailed}}** with **{{ui:controls.dashboard.retry}}** | The dashboard could not be read | Click **{{ui:controls.dashboard.retry}}** |
| Every card at zero and no status bars | The register has no controls yet | Install a framework or add controls on the {{ui:controls.list.pageTitle}} page |
| **{{ui:controls.dashboard.ownersEmptyTitle}}** | No control has an owner | Assign owners on the controls list or a control's page |
| The best-value list explains it will appear later | No control has a cost, an effectiveness and a quantified linked risk yet | Add an annual cost and effectiveness on a control, and quantify a linked risk |
| **{{ui:controls.dashboard.consistencyFailed}}** | The check was refused or could not run | Check that you are an Owner or Admin, then click the button again |
| **{{ui:controls.dashboard.controlHealthLoadFailed}}** | Control health could not be read | Click **{{ui:controls.dashboard.retry}}** |

## Related

- [{{ui:controls.list.pageTitle}}](controls.md), where every drill-down lands.
- [{{ui:controls.sankey.title}}](controls-sankey.md) and [{{ui:controls.templates.title}}](control-templates.md), the other views on the controls list.
- [{{ui:controlTests.dashboard.title}}](../comply/tests-dashboard.md), for testing rates and trends.
