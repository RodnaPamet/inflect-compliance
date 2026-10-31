---
route: /t/[tenantSlug]/audits/cycles/[cycleId]
---

# An audit cycle

An audit cycle's page is where you prepare one audit: you move the cycle through its stages, build the evidence pack you will hand to the auditor, and see the fieldwork audits and packs that belong to it.

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}**, click **{{ui:audits.hub.cycles}}**, and click **{{ui:audits.cycles.openCycle}}** on a cycle's card. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.crumb.cycles}}** › the cycle's name. Arrows beside the title step to the previous or next cycle in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the cycle, its packs and its fieldwork audits | Everyone who can see audits |
| Change the cycle's status | Owner, Admin, Editor |
| Create the default pack | Owner, Admin, Editor |
| Assemble the reliance pack | Owner, Admin |

If your workspace uses custom roles, these follow the built-in role your custom role is based on. The reliance pack also needs a role that can manage audits and administer the workspace.

## What it is for

Keep one audit's preparation in one place. The cycle names the framework and version being audited, and the packs you build here are what you give the auditor.

## What you see

**The header.** The cycle's name, its **{{ui:audits.cycleDetail.framework}}**, **{{ui:audits.cycleDetail.version}}** and **{{ui:audits.cycleDetail.status}}**: **{{ui:audits.cycleStatus.PLANNING}}**, **{{ui:audits.cycleStatus.IN_PROGRESS}}**, **{{ui:audits.cycleStatus.READY}}** or **{{ui:audits.cycleStatus.COMPLETE}}**. On the right, if you can change it, the status list, and **{{ui:audits.cycles.viewReadiness}}**.

**{{ui:audits.cycleDetail.defaultPackPreview}}.** What a default pack for this cycle would hold today: how many **{{ui:audits.cycleDetail.controls}}**, **{{ui:audits.cycleDetail.policies}}**, **{{ui:audits.cycleDetail.evidence}}** and **{{ui:audits.cycleDetail.issues}}**, and the total.

**{{ui:audits.cycleDetail.relianceTitle}}.** Shown to Owners and Admins only. {{ui:audits.cycleDetail.relianceHelp}}

**{{ui:audits.cycleDetail.fieldworkAudits}}.** The internal audits attached to this cycle, each with its status, and **{{ui:audits.cycleDetail.viewInHub}}**.

**{{ui:audits.cycleDetail.packs}}.** The cycle's evidence packs, each with its status: **{{ui:audits.packStatus.DRAFT}}**, **{{ui:audits.packStatus.FROZEN}}** or **{{ui:audits.packStatus.EXPORTED}}**. Shown once the cycle has a pack.

## What you can do

### Move the cycle on

Choose the new status from the list in the header. The change is saved straight away, and the cycles list shows it too. Any status can be chosen from any other.

### Create the default pack

Click **{{ui:audits.cycleDetail.pack}}** in **{{ui:audits.cycleDetail.defaultPackPreview}}**. A draft pack is created, named after the framework, and filled with:

- the controls mapped to the cycle's framework that are implemented or need review (every such control, if none is mapped);
- the workspace's published policies, preferring those about security or access control for ISO 27001, and about incidents, continuity, access control and suppliers for NIS2;
- the approved evidence linked to those controls;
- every open task in the workspace, shown as **{{ui:audits.cycleDetail.issues}}**.

The pack opens. Check its items, remove what the auditor should not see, then freeze it. See [An audit pack](audit-pack-detail.md).

### Assemble the reliance pack

Click **{{ui:audits.cycleDetail.reliancePack}}**. The pack is built and frozen in one step and opens when it is ready. It needs the cycle to have an audit period with at least one whole month or quarter in it, and workpapers from the auditor agent in that period.

### See how ready you are

Click **{{ui:audits.cycles.viewReadiness}}**. See [Audit cycle readiness](audit-cycle-readiness.md).

### Open a pack or the fieldwork audits

Click a pack to open it. Click a fieldwork audit, or **{{ui:audits.cycleDetail.viewInHub}}**, to open the audits page showing this cycle's audits.

## What happens next

- The pack you create starts as a draft. Nothing is shared with anyone until you freeze it and generate a share link.
- The preview counts change as your controls, policies, evidence and tasks change. A pack you have already created keeps the items it was given.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.cycleDetail.notFound}}** | The cycle does not exist or is in another workspace | Go back to the cycles list |
| **{{ui:audits.cycleDetail.loadError}}** | The cycle could not load | Click **{{ui:audits.cycleDetail.retry}}** |
| **{{ui:audits.cycleDetail.previewError}}** | The preview could not be worked out. **{{ui:audits.cycleDetail.pack}}** stays unavailable | Reload the page |
| **{{ui:audits.cycleDetail.noFieldwork}}** | No internal audit is attached to the cycle | Create one from the audits page, choosing this cycle |
| **{{ui:audits.cycleDetail.createPackError}}**, or a reason the pack was refused | No pack was created | Follow the reason given, then try again |
| **{{ui:audits.cycleDetail.addItemsError}}** | The pack exists, but not every item went in | Add the missing items on the pack's page |
| **{{ui:audits.cycleDetail.statusError}}**, or a reason the change was refused | The status did not change | Follow the reason given, then try again |
| **{{ui:audits.cycleDetail.relianceError}}**, or a reason in red under **{{ui:audits.cycleDetail.reliancePack}}** | No reliance pack was assembled | Follow the reason given |

## Related

- [{{ui:audits.cycles.title}}](audit-cycles.md), every audit cycle.
- [An audit pack](audit-pack-detail.md), the evidence you hand to the auditor.
- [{{ui:audits.title}}](audits.md), the fieldwork audits.
- [Build an audit pack](../../how-to/audits/build-an-audit-pack.md).
