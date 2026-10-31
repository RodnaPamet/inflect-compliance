---
route: /t/[tenantSlug]/frameworks/[frameworkKey]
---

# A framework

A framework's page shows one framework, such as ISO 27001 or NIS2, as your workspace has it: its requirements, the packs you have installed from it, how much of it your controls cover, and the order its requirements are listed in.

## Where to find it

Open **{{ui:nav.frameworks}}** and click a framework. The breadcrumb reads **{{ui:frameworks.crumb.dashboard}}** › **{{ui:frameworks.crumb.frameworks}}** › the framework's name. Arrows beside the title step to the previous or next framework.

## Who can use it

| Action | Roles |
| --- | --- |
| View the requirements, packs and coverage | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Browse the framework's control templates | Every role |
| Install a pack, remove a pack, reorder requirements | Owner, Admin |

## What it is for

See how far your workspace is towards meeting a framework: which of its requirements have a control behind them and which are still gaps. A pack is a ready-made set of controls for the framework. Installing one creates those controls in your workspace and maps them to the requirements.

## What you see

**The header.** The framework's name, its **{{ui:frameworks.detail.version}}** and its **{{ui:frameworks.detail.kind}}**, and a short description. On the right: **{{ui:frameworks.detail.browseTemplates}}**, and, for Owners and Admins, **{{ui:frameworks.detail.installPack}}**.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:frameworks.detail.reqTab}}** | Every requirement, grouped into sections. Select one to see the controls mapped to it |
| **{{ui:frameworks.detail.packsTab}}** | The packs available for the framework, and which you have chosen |
| **{{ui:frameworks.detail.coverageTab}}** | How many requirements have a control mapped to them, overall and by section, and which do not |
| **{{ui:frameworks.detail.builderTab}}** | The order of sections and requirements, which Owners and Admins can change |

**The coverage.** Three cards: **{{ui:frameworks.detail.totalRequirements}}**, **{{ui:frameworks.detail.mapped}}** and **{{ui:frameworks.detail.unmapped}}**, and a fourth, **{{ui:frameworks.detail.outOfScope}}**, when some requirements belong to packs you did not choose. Then **{{ui:frameworks.detail.overallCoverage}}** as a percentage, **{{ui:frameworks.detail.coverageBySection}}**, and the list of requirements with no control. At the bottom, **{{ui:frameworks.detail.inherited.heading}}**: {{ui:frameworks.detail.inherited.description}}

## What you can do

### Find a requirement

On **{{ui:frameworks.detail.reqTab}}**, search by code or wording, or open a section. Selecting a requirement shows the controls mapped to it, or says no control is mapped yet.

### Install a pack

Click **{{ui:frameworks.detail.installPack}}**, in the header for the framework or on a pack's card. You see what the pack adds before anything is created. See [Add a framework](../../how-to/get-started/add-a-framework.md).

### Take a pack out of scope

When you have chosen more than one pack, **{{ui:frameworks.detail.removePack}}** on a pack's card takes it out of scope. Its controls stay in your workspace; only its requirements stop counting towards coverage. You have a few seconds to click **{{ui:frameworks.detail.undo}}**. The last chosen pack cannot be removed: {{ui:frameworks.detail.packRemoveLast}}

### Change the order of requirements

On **{{ui:frameworks.detail.builderTab}}**, drag sections and requirements into the order you want, and save. The order applies to this workspace only.

## What happens next

- Installing a pack creates its controls on the controls list, mapped to the framework's requirements, and raises the coverage here.
- A control you map to a requirement from the control's own page counts on this page's coverage straight away.
- A requirement whose only controls are out of scope shows under **{{ui:frameworks.detail.outOfScope}}** rather than as a gap.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworks.detail.notFound}}** | The framework does not exist, or is not available to the workspace | Go back to **{{ui:nav.frameworks}}** |
| **{{ui:frameworks.detail.loadFailed}}** | The page could not load | Reload the page |
| **{{ui:frameworks.detail.packsEmpty}}** | The framework has no packs | Nothing to do |
| **{{ui:frameworks.detail.treeLoadFailed}}**, **{{ui:frameworks.detail.packsLoadFailed}}** or **{{ui:frameworks.detail.coverageLoadFailed}}** | That part of the page could not load | Click **{{ui:frameworks.detail.retry}}** |
| **{{ui:frameworks.detail.reorderRestricted}}** | You are not an Owner or Admin | Ask one to change the order |
| **{{ui:frameworks.detail.reorderFailed}}** | The new order was not saved | Try again |
| **{{ui:frameworks.detail.packRemoveFailed}}** | The pack is still in scope | Reload the page and try again |
| **{{ui:frameworks.detail.inherited.emptyTitle}}** | No framework you hold controls on is mapped to this one | Nothing to do |
| **{{ui:frameworks.detail.inherited.errorTitle}}** | The inherited coverage could not load | Click **{{ui:frameworks.detail.inherited.retry}}** |

## Related

- [{{ui:frameworks.list.heading}}](frameworks.md), every framework available to the workspace.
- [A control](control-detail.md), where a control is mapped to requirements.
- [Add a framework](../../how-to/get-started/add-a-framework.md).
