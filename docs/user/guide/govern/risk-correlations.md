---
route: /t/[tenantSlug]/risks/correlations
---

# Risk correlations

Some risks tend to happen together: a ransomware attack and a long outage, say. The {{ui:risks.correlations.title}} records how strongly each pair of risks moves together, so the portfolio simulation does not treat bad years as rarer than they are.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.correlations}}**. The breadcrumb reads **{{ui:risks.breadcrumbRoot}}** › **{{ui:risks.correlations.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the matrix and ask for suggestions | Every role |
| Change a pair, or apply a suggestion | Owner, Admin, Editor |

Changing a pair also needs the permission to edit risks, which a custom role can take away.

## What it is for

Make the simulation's worst years realistic. A positive figure means two risks rise and fall together, which makes bad years worse. A negative figure means one offsets the other.

## What you see

**The check.** A badge says whether the figures fit together. If they contradict each other, a warning says the simulation will ignore them and treat every risk as independent until they are fixed.

**The matrix.** Every risk against every other, each cell holding a figure from −1 to 1 to two decimals, coloured by strength. Hover over a row or column heading to see the full risk title.

**{{ui:risks.correlations.suggested}}**, after you ask for suggestions: pairs the product thinks are related, each naming its two risks, with the reason and a proposed figure.

## What you can do

### Change a pair

Click a cell above the diagonal, or move to it with Tab and press Enter. Enter a figure from −1 to 1 under **{{ui:risks.correlations.coefficient}}** and save. A figure outside that range is refused with **{{ui:risks.correlations.coefficientRange}}**, and a refused save shows the reason.

### Ask for suggestions

Click **{{ui:risks.correlations.autoSuggest}}**; it reads **{{ui:risks.correlations.suggesting}}** while it works. Suggestions are based on what the risks share, such as a category or an asset. Click **{{ui:risks.correlations.apply}}** to use one. If nothing is related closely enough, it says **{{ui:risks.correlations.noSuggestions}}**.

## What happens next

The next simulation uses the figures, as long as they fit together.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.correlations.emptyMatrix}}** | There are no risks to pair | Add risks first |
| **{{ui:risks.correlations.notPsd}}** | The figures contradict each other, so the simulation ignores them | Lower the strongest figures until the badge changes |
| **{{ui:risks.correlations.borderlinePd}}** | The figures only just fit, and the simulation still ignores them | Move a figure of 1 or −1 slightly towards 0 |
| **{{ui:risks.correlations.loadError}}** | The matrix could not load | Reload the page |
| **{{ui:risks.correlations.suggestError}}** | Suggestions could not be worked out | Try again |
| **{{ui:risks.correlations.saveError}}** | The figure was not saved | Try again |

## Related

- [{{ui:risks.viewLinks.dashboard}}](risk-dashboard.md), where the simulation runs.
- [{{ui:risks.scenarios.title}}](risk-scenarios.md), which use the same figures.
