---
route: /t/[tenantSlug]/risks/hierarchy
---

# The risk hierarchy

The {{ui:risks.hierarchy.title}} arranges your risks under the parts of your organisation they belong to: business units, geographies, kinds of asset, or groupings of your own. Each part shows the expected yearly loss of its risks, added up through the tree, so you can see where the money sits.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.hierarchy}}**. The breadcrumb reads **{{ui:risks.breadcrumbRoot}}** › **{{ui:risks.hierarchy.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the hierarchy | Every role |
| Add, rename or delete a node; attach or detach a risk | Owner, Admin, Editor |

## What it is for

Answer "which part of the organisation carries the most risk?" in money, not in counts.

## What you see

**The four trees.** **{{ui:risks.hierarchy.typeBusinessUnit}}**, **{{ui:risks.hierarchy.typeGeography}}**, **{{ui:risks.hierarchy.typeAssetClass}}** and **{{ui:risks.hierarchy.typeCustom}}**. Click one to show it. Each is a separate tree.

**Adding nodes**, for roles that can: **{{ui:risks.hierarchy.newNodeName}}**, **{{ui:risks.hierarchy.parentLabel}}** (or **{{ui:risks.hierarchy.parentNone}}** for the top level), and **{{ui:risks.hierarchy.addNode}}**.

**Attaching risks**, for roles that can: **{{ui:risks.hierarchy.linkRiskLabel}}**, **{{ui:risks.hierarchy.linkNodeLabel}}**, and **{{ui:risks.hierarchy.linkRisk}}** or **{{ui:risks.hierarchy.unlinkRisk}}**.

**{{ui:risks.hierarchy.rollup}}.** The total expected yearly loss of the tree, then each node, indented under its parent, with a bar, its **{{ui:risks.hierarchy.colTotalAle}}** and its number of **{{ui:risks.hierarchy.colRisks}}**. A node's total includes everything under it.

## What you can do

### Build a tree

Pick the tree, type a node's name, choose its parent and click **{{ui:risks.hierarchy.addNode}}**. Start with the top level and work down.

### Attach a risk

Choose the risk and the node, then click **{{ui:risks.hierarchy.linkRisk}}**. To detach it, choose the same risk and node and click **{{ui:risks.hierarchy.unlinkRisk}}**.

### Rename or delete a node

Hover over a node to show **{{ui:risks.hierarchy.rename}}** and **{{ui:risks.hierarchy.deleteNode}}**. Deleting a node also removes the nodes under it and their risk attachments, and cannot be undone. The risks themselves are kept.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.hierarchy.empty}}** | This tree has no nodes | Add the top-level nodes |
| **{{ui:risks.hierarchy.loadError}}** | The tree could not load | Reload the page |
| **{{ui:risks.hierarchy.nodeSaveError}}** | A node was not added, renamed or deleted | Try again |
| **{{ui:risks.hierarchy.linkFailed}}** | The risk was not attached or detached | Try again |

## Related

- [{{ui:risks.title}}](risks.md), where the risks live.
- [A risk](risk-detail.md), whose money estimate is what the tree adds up.
