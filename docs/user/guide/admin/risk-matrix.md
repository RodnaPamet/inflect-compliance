---
route: /t/[tenantSlug]/admin/risk-matrix
---

# {{ui:admin.riskMatrix.title}}

The {{ui:admin.riskMatrix.title}} page sets the grid this workspace scores risks on: how many likelihood and impact levels there are, what each level and axis is called, and the severity bands a score falls into, with their colours. Every risk page in the workspace uses it.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.risk}}, click **{{ui:admin.nav.riskMatrix}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.riskMatrix.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Save changes | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can open the page only if that role can view risks, and save only if it can manage the workspace's settings.

## What it is for

A risk's score is its likelihood level multiplied by its impact level. On the standard 5 × 5 grid that gives scores from 1 to 25, which fall into four bands: Low (1–4), Medium (5–9), High (10–14) and Critical (15–25). Many organisations already have a risk methodology with a different grid, other level names or other bands. This page lets the workspace use its own, so that risk scores and heat maps here match the organisation's policy.

## What you see

**The header.** The title, and two buttons: **{{ui:admin.riskMatrix.restoreDefaults}}** and **{{ui:admin.riskMatrix.saveChanges}}**.

**{{ui:admin.riskMatrix.dimensions}}.** **{{ui:admin.riskMatrix.likelihoodLevels}}** and **{{ui:admin.riskMatrix.impactLevels}}**, each from 2 to 10, and the total number of cells they make.

**{{ui:admin.riskMatrix.axisTitles}}.** What the two axes are called on every heat map: **{{ui:admin.riskMatrix.likelihoodAxisTitle}}** and **{{ui:admin.riskMatrix.impactAxisTitle}}**.

**{{ui:admin.riskMatrix.perLevelLabels}}.** A name for each level of **{{ui:admin.riskMatrix.likelihood}}** and **{{ui:admin.riskMatrix.impact}}**, lowest first, such as Rare to Almost Certain.

**{{ui:admin.riskMatrix.severityBands}}.** One row per band: its name, its lowest and highest score, and its colour, with a **{{ui:admin.riskMatrix.remove}}** button. Between them, the bands must cover every score from 1 to the highest score, with no gaps and no overlaps.

**{{ui:admin.riskMatrix.preview}}.** A heat map drawn from your draft, one cell per score, coloured by band, so you can see the result before saving.

When the draft breaks a rule, a list of what is wrong appears and **{{ui:admin.riskMatrix.saveChanges}}** is greyed out until it is fixed.

## What you can do

### Change the grid

1. Change the number of levels. Adding a level adds a label to fill in; removing one removes its label.
2. Name the axes and the levels.
3. Adjust the bands so that, between them, they cover every score from 1 to the highest score exactly once. Click **{{ui:admin.riskMatrix.band}}** to add a band covering the scores no band covers yet, and **{{ui:admin.riskMatrix.remove}}** to delete one. The last band cannot be removed.
4. Check the preview, then click **{{ui:admin.riskMatrix.saveChanges}}**. **{{ui:admin.riskMatrix.toastSaved}}** confirms it.

Nothing changes until you save. Saving applies the grid to every risk page in the workspace straight away. Existing risks keep the likelihood and impact they were given.

### Go back to the standard grid

Click **{{ui:admin.riskMatrix.restoreDefaults}}**. The draft returns to the 5 × 5 grid with its standard names and four bands. Click **{{ui:admin.riskMatrix.saveChanges}}** to keep it, or reload the page to discard it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| A list of problems above the form | The draft breaks a rule: a band leaves a gap, overlaps another, or does not start at 1 | Fix each one; **{{ui:admin.riskMatrix.saveChanges}}** comes back |
| **{{ui:admin.riskMatrix.toastNoRange}}** | Every score already has a band | Shorten an existing band first |
| **{{ui:admin.riskMatrix.saveFailedGeneric}}**, or the reason the server gave | The grid was not saved | Try again |

## Related

- [{{ui:admin.nav.riskAppetite}}](risk-appetite.md), whose score limit is measured on this grid.
- [{{ui:nav.risks}}](../govern/risks.md) and the [risk dashboard](../govern/risk-dashboard.md), which draw their heat maps from it.
