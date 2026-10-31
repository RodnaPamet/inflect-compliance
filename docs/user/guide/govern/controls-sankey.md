---
route: /t/[tenantSlug]/controls/sankey
---

# {{ui:controls.sankey.title}}

The {{ui:controls.sankey.title}} page draws the register as one flow diagram: which assets expose which risks, which controls mitigate those risks, and which framework requirements each control implements.

## Where to find it

Open **{{ui:nav.controls}}** under **{{ui:nav.govern}}** in the sidebar, open **{{ui:common.ui.viewsMenu}}** in the toolbar and choose **{{ui:controls.list.sankeyFlow}}**. The back link returns you to the page you came from.

## Who can use it

Every role can open the page: Owner, Admin, Editor, Reader, Auditor and AI admin. It changes nothing.

The diagram shows only the kinds of record your role can see. If your role cannot see risks, for example, the risk column is left out and so are the flows through it.

## What it is for

Use the diagram to see traceability at a glance: an asset with no flow onwards has risks nobody has treated, and a control with no flow to the right implements no requirement.

## What you see

**The columns.** Up to four, from left to right: assets, risks, controls and requirements. Each column's heading shows its colour and how many items it holds. Only active assets are drawn. Policies are not part of this diagram.

**The bars and bands.** Each item is a bar; the bands between bars are the links between records: an asset's risk, a risk's mitigating control, a control's requirement. A thicker band means more links. Point at a bar to see its name and weight, or at a band to see the kind of link and its weight.

**Size.** The diagram starts at full size, and the frame scrolls when it is taller than the window. **Fit to view** shrinks the whole diagram to fit the window; **Actual size** returns to full size.

In a very large workspace, the diagram draws up to 500 items of each kind and does not say when it has left some out.

## What you can do

- **Highlight one item's flows.** Point at a bar to highlight the bands that touch it. Click a requirement bar to keep its flows highlighted; click it again, click an empty part of the diagram or press Escape to let go.
- **Open a record.** Click an asset, risk or control bar to open that record's page.
- **Switch the size** with **Fit to view** and **Actual size**.

## What happens next

The page reads the register when it loads. To see a link you have just added, reload it.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **No mapping flows to display.** | There are no assets, risks, controls or requirements your role can see | Add records, or ask an admin what your role can see |
| **Nodes are present but no cross-tier mapping flows have been recorded yet.** | Records exist but none are linked to each other | Link risks to assets and controls to risks and requirements |
| An error page | The diagram could not be built | Reload the page |

## Related

- [{{ui:controls.list.pageTitle}}](controls.md), the list this view belongs to.
- [{{ui:controls.dashboard.title}}](controls-dashboard.md), for the register's figures.
- [{{ui:risks.title}}](risks.md) and [{{ui:assets.title}}](assets.md), where the links on the left are made.
