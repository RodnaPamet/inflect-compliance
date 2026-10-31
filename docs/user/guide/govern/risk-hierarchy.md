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

Renaming, deleting, attaching and detaching also need the permission to edit risks, which a custom role can take away.

## What it is for

Answer "which part of the organisation carries the most risk?" in money, not in counts.

## What you see

**The four trees.** **{{ui:risks.hierarchy.typeBusinessUnit}}**, **{{ui:risks.hierarchy.typeGeography}}**, **{{ui:risks.hierarchy.typeAssetClass}}** and **{{ui:risks.hierarchy.typeCustom}}**, under **{{ui:risks.hierarchy.typeLabel}}**. Choose one to show it. Each is a separate tree.

**Adding nodes**, for roles that can: **{{ui:risks.hierarchy.newNodeName}}**, **{{ui:risks.hierarchy.parentLabel}}** (or **{{ui:risks.hierarchy.parentNone}}** for the top level), and **{{ui:risks.hierarchy.addNode}}**.

**Attaching risks**, for roles that can: **{{ui:risks.hierarchy.linkRiskLabel}}**, **{{ui:risks.hierarchy.linkNodeLabel}}**, and **{{ui:risks.hierarchy.linkRisk}}** or **{{ui:risks.hierarchy.unlinkRisk}}**.

**{{ui:risks.hierarchy.rollup}}.** The total expected yearly loss of the tree, then each node, indented under its parent, with its **{{ui:risks.hierarchy.colAleShare}}** as a bar, its **{{ui:risks.hierarchy.colTotalAle}}** and its number of **{{ui:risks.hierarchy.colRisks}}**. A node's total includes everything under it. A node with risks of its own has a button that lists them; **{{ui:risks.hierarchy.hideRisks}}** closes the list.

## What you can do

### Build a tree

Pick the tree, type a node's name, choose its parent and click **{{ui:risks.hierarchy.addNode}}**. Start with the top level and work down.

### Attach a risk

Choose the risk and the node, then click **{{ui:risks.hierarchy.linkRisk}}**. To detach a risk, open the node's list of risks and click **{{ui:risks.hierarchy.unlinkRisk}}** beside it. If the change is refused, the message says why, for example that the risk is already attached.

### Rename or delete a node

Each node has **{{ui:risks.hierarchy.rename}}** and **{{ui:risks.hierarchy.deleteNode}}**. If a rename is refused, the editor stays open with your text and the reason. Deleting a node also removes the nodes under it and their risk attachments, and cannot be undone. The risks themselves are kept.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.hierarchy.empty}}** | This tree has no nodes | Add the top-level nodes |
| **{{ui:risks.hierarchy.loadError}}** | The tree could not load | Reload the page |
| **{{ui:risks.hierarchy.nodeSaveError}}** | A node was not added, renamed or deleted | Try again |
| **{{ui:risks.hierarchy.linkFailed}}** | The risk was not attached | Try again |
| **{{ui:risks.hierarchy.unlinkFailed}}** | The risk was not detached | Try again |

## Related

- [{{ui:risks.title}}](risks.md), where the risks live.
- [A risk](risk-detail.md), whose money estimate is what the tree adds up.
