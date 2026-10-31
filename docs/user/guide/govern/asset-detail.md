---
route: /t/[tenantSlug]/assets/[id]
---

# An asset

An asset's page is where you work on one asset: what it is, who owns it, how critical it is, which vulnerabilities affect it, and the risks, controls, tasks and evidence linked to it.

## Where to find it

Open **{{ui:nav.assets}}** under **{{ui:nav.govern}}** and click an asset's name. The breadcrumb reads **{{ui:assets.detail.crumbDashboard}}** › **{{ui:assets.detail.crumbAssets}}** › the asset's name. Arrows beside the title step to the previous or next asset in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the asset and every tab | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Change the status, edit the asset, link risks, controls, tasks and evidence | Owner, Admin, Editor |
| Update a vulnerability's status, owner, due date or note | Owner, Admin, Editor |
| Turn a vulnerability into a risk or a finding | Owner, Admin, Editor |
| Delete the asset | Owner, Admin |

If your workspace uses custom roles, the page offers only what your role's permissions allow.

## What it is for

Keep an asset's record accurate and see at a glance what puts it at risk: open vulnerabilities, linked risks, the controls that protect it and the work still open on it.

## What you see

**The header.** The asset's name, its **{{ui:assets.detail.type}}**, its criticality and its **{{ui:assets.detail.status}}**. On the right: **Where used**, which lists the process maps that refer to the asset, and, if you can edit, the status picker and the bin to delete it.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:assets.detail.tabs.overview}}** | Counts of linked risks, controls, open vulnerabilities and open tasks, then the asset's fields |
| **{{ui:assets.detail.tabs.vulnerabilities}}** | Known vulnerabilities (CVEs) matched to the asset, and findings from security scanners |
| **{{ui:assets.detail.tabs.tasks}}** | The tasks linked to the asset |
| **{{ui:assets.detail.tabs.evidence}}** | **{{ui:assets.detail.attachedEvidence}}**, and the evidence **{{ui:assets.detail.inheritedFromControls}}** |
| **{{ui:assets.detail.tabs.mappings}}** | The framework requirements the asset reaches through its controls |
| **{{ui:assets.detail.tabs.traceability}}** | The risks and controls linked to the asset, and linked vendors |
| **{{ui:assets.detail.tabs.activity}}** | Everything that has happened to the asset |
| **{{ui:assets.detail.tabs.tests}}** | The test plans of the controls linked to the asset |

**The overview.** **{{ui:assets.detail.classification}}**, **{{ui:assets.detail.owner}}**, **{{ui:assets.detail.location}}**, **{{ui:assets.detail.externalRef}}** (click it to copy), **{{ui:assets.detail.dataResidency}}** and retention. Then the context notes: **{{ui:assets.detail.dependencies}}**, **{{ui:assets.detail.businessProcesses}}** and **{{ui:assets.detail.retention}}**. Then **{{ui:assets.detail.identityHeading}}**: **{{ui:assets.detail.cpe}}**, **{{ui:assets.detail.vendor}}**, **{{ui:assets.detail.product}}** and **{{ui:assets.detail.version}}**. Last, **{{ui:assets.detail.criticalityHeading}}**: the asset's **{{ui:assets.detail.confidentiality}}**, **{{ui:assets.detail.integrity}}** and **{{ui:assets.detail.availability}}**, each rated 1 to 5, and the criticality they give.

When an asset has no product identity, a box offers **{{ui:assets.detail.identityHintAction}}**: {{ui:assets.detail.identityHintBody}}

## What you can do

### Change the status

Choose **{{ui:assets.detail.statusActive}}** or **{{ui:assets.detail.statusRetired}}** from the picker in the header.

### Edit the asset

Click the pencil at the top of the overview. You can change every field, including the product identity and the confidentiality, integrity and availability ratings.

### Work through its vulnerabilities

On **{{ui:assets.detail.tabs.vulnerabilities}}**, each matched vulnerability shows its CVE, severity, score and how it was matched. For each one you can:

- set its status, owner and remediation due date, and add a note;
- turn it into a risk, so it is assessed and treated on the risk register;
- turn it into a finding, so it is tracked with your other findings.

Resolved vulnerabilities are hidden until you click **{{ui:assets.detail.vuln.showResolved}}**. **{{ui:assets.detail.vuln.seeAll}}** opens the workspace's vulnerability page filtered to this asset. Below the CVEs, **{{ui:assets.detail.vuln.scannerTitle}}** lists what your security scanners reported for the asset.

### Link risks, controls, tasks and evidence

On **{{ui:assets.detail.tabs.traceability}}**, link the risks that affect the asset and the controls that protect it. On **{{ui:assets.detail.tabs.tasks}}**, create or link tasks. On **{{ui:assets.detail.tabs.evidence}}**, attach evidence to the asset itself.

### Delete the asset

Click the bin in the header. You go back to the asset list, with a few seconds to click **{{ui:assets.detail.undo}}**. A deleted asset can be restored from the list's deleted view by an Owner or Admin.

## What happens next

- The asset's criticality feeds the risk register and the vulnerability page's priorities.
- With a product identity set, newly published vulnerabilities are matched to the asset as they arrive.
- A vulnerability turned into a risk or a finding stays linked to the asset.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:assets.detail.notFound}}** | The asset does not exist, was deleted, or is in another workspace | Go back to the list |
| **{{ui:assets.detail.vuln.emptyTitle}}** | No known vulnerability matches the asset | Set its product identity so new ones can be matched |
| **{{ui:assets.detail.vuln.scannerEmptyTitle}}** | No scanner has reported anything for the asset | Nothing to do |
| **{{ui:assets.detail.changeStatusFailedGeneric}}**, or a reason in red above the tabs | The status change was refused | Follow the reason given, then try again |
| **{{ui:assets.detail.vuln.updateFailed}}** | A vulnerability's change was not saved | Try again |
| **{{ui:assets.detail.deleteFailed}}** | The asset was not deleted, and you are back on its page | Try again |

## Related

- [{{ui:assets.title}}](assets.md), the list of every asset.
- [Vulnerabilities](vulnerabilities.md), every vulnerability in the workspace.
- [A risk](risk-detail.md), where a vulnerability turned into a risk is worked on.
