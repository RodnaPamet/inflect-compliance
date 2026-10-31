---
route: /t/[tenantSlug]/coverage
---

# {{ui:coverage.title}}

The {{ui:coverage.title}} shows how your assets, risks and controls are linked to each other: which assets no control protects, which risks no control mitigates, and which controls carry the most risks. {{ui:coverage.description}}

## Where to find it

On the [{{ui:nav.assets}}](assets.md) page, open **{{ui:common.ui.viewsMenu}}** and choose **{{ui:assets.coverageTooltip}}**. The breadcrumb reads **{{ui:coverage.crumbDashboard}}** › **{{ui:coverage.crumbCoverage}}**, and a back link returns to **{{ui:coverage.backAssets}}**.

## Who can use it

Every role. The page only reads.

## What it is for

Find the gaps in your risk treatment: a critical system nothing protects, or a risk you have recorded but not treated. This is not test coverage: {{ui:coverage.vsTestCoverage}} **{{ui:coverage.testCoverageLink}}**

## What you see

**Three figures**, each with a ring:

| Figure | Counts |
| --- | --- |
| **{{ui:coverage.kpiAssets}}** | Active assets linked to at least one control |
| **{{ui:coverage.kpiRisks}}** | Risks linked to at least one control |
| **{{ui:coverage.kpiControls}}** | Controls linked to at least one risk |

**{{ui:coverage.overall}}.** The same three as bars, and **{{ui:coverage.barProcess}}**: the controls placed in one of your process maps.

**{{ui:coverage.uncoveredAssets}}.** Active assets of high or critical criticality that no control is linked to, with their type and criticality. The badge counts them all; the table lists the first ten, and when there are more a line says how many it shows and links to the assets.

**{{ui:coverage.unmappedRisks}}.** Risks no control is linked to, highest score first, with their status. The badge counts them all; the table lists the ten highest, and when there are more a line says how many it shows and links to the risks.

**{{ui:coverage.topControls}}.** The five controls linked to the most risks, each with how many it mitigates.

A figure is green from 80%, amber from 50%, and red below. A figure with nothing to count, such as risks in a workspace that has none, shows a dash and **{{ui:coverage.nothingToCover}}** instead of a red 0%.

## What you can do

### Close a gap

Click an asset or a risk in either table to open it, and link a control to it there. Click a control in **{{ui:coverage.topControls}}** to open the control.

## What happens next

- The figures change as soon as you link or unlink a control. Reload the page to see the new figures.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:coverage.emptyAssets}}** | No high or critical active asset is without a control | Nothing to do |
| **{{ui:coverage.emptyAssetsNone}}** | The workspace has no active asset of high or critical criticality | Record your critical assets on the assets page |
| **{{ui:coverage.emptyRisks}}** | Every risk has a control | Nothing to do |
| **{{ui:coverage.emptyRisksNone}}** | The workspace has no risks yet | Record risks on the risks page |
| No **{{ui:coverage.topControls}}** | No control is linked to a risk | Link controls on the risks' pages |

## Related

- [{{ui:nav.assets}}](assets.md), where the page is opened from.
- [{{ui:nav.risks}}](risks.md), every risk.
- [{{ui:controls.list.pageTitle}}](controls.md), every control.
