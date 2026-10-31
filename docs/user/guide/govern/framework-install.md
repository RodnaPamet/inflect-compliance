---
route: /t/[tenantSlug]/frameworks/[frameworkKey]/install
---

# Install a framework pack

The install page adds a framework's controls to your workspace from one of its packs. A pack is a ready-made set of controls, each with its starter tasks and its mappings to the framework's requirements. You see what it will add before anything is created.

## Where to find it

On a framework's page, click **{{ui:frameworks.detail.installPack}}**, in the header or on a pack's card. **{{ui:frameworks.list.importFramework}}** on the frameworks list also opens it. The page has a back link and no breadcrumb.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Everyone who can see frameworks |
| Install a pack | Owner, Admin |

If your workspace uses custom roles, installing needs permission to install frameworks. Anyone else sees **{{ui:frameworks.install.restrictedTitle}}**: {{ui:frameworks.install.restricted}}

## What it is for

Start on a framework without writing its controls yourself. {{ui:frameworks.install.description}}

## What you see

The heading names the framework. Below it, three steps: **{{ui:frameworks.install.stepSelect}}**, **{{ui:frameworks.install.stepPreview}}** and **{{ui:frameworks.install.stepInstall}}**.

**Choosing the pack.** A framework with one pack chooses it for you and goes straight to the preview. A framework with one pack per kind of use, such as an operating category, lists them under **{{ui:frameworks.install.choosePacks}}**: {{ui:frameworks.install.choosePacksHint}} Each pack shows how many control templates it holds and its version.

**{{ui:frameworks.install.installPreview}}.** How many **{{ui:frameworks.install.newControls}}** would be created, how many **{{ui:frameworks.install.alreadyExist}}** in your workspace, and the **{{ui:frameworks.install.totalTemplates}}**. Below, every control in the pack by code and title: one you already have is marked **{{ui:frameworks.install.exists}}**, and a new one shows how many tasks it brings.

## What you can do

### Install a pack

1. If the framework has several packs, tick each one that applies to you and click the preview button, which names how many you ticked.
2. Check the preview.
3. Click the install button, which names how many controls it will create.

When it is done, **{{ui:frameworks.install.successHeading}}** shows how many **{{ui:frameworks.install.controlsCreated}}**, **{{ui:frameworks.install.tasksCreated}}** and **{{ui:frameworks.install.mappingsCreated}}**, with **{{ui:frameworks.install.viewControls}}** and **{{ui:frameworks.install.backToFramework}}**.

See [Add a framework](../../how-to/get-started/add-a-framework.md).

### Choose a different pack

Click **{{ui:frameworks.install.back}}** on the preview.

## What happens next

- Each new control starts with the status **{{ui:controls.statusLabels.NOT_STARTED}}**, with its starter tasks, and is mapped to the requirements it covers. Work on them on the [{{ui:controls.list.pageTitle}}](controls.md) page.
- A control you already have, by its code, is not created twice. Installing a pack that shares controls with one you installed earlier adds only the controls you do not have yet.
- The framework counts as in use once a control is mapped to it, so you can then create audit cycles for it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworks.install.notFound}}** | The framework does not exist, or could not load | Go back to the frameworks list |
| **{{ui:frameworks.install.packsEmpty}}** | The framework has no pack to install | Map your own controls to its requirements instead |
| **{{ui:frameworks.install.choosePacksRequired}}** | No pack is ticked | Tick at least one |
| **{{ui:frameworks.install.allInstalled}}** | You already have every control in the pack | Nothing to install |
| **{{ui:frameworks.install.installFailed}}**, or a reason the install was refused | Nothing was installed | Follow the reason given, then try again |

## Related

- [A framework](framework-detail.md), the framework's requirements and packs.
- [{{ui:frameworks.list.heading}}](frameworks.md), every framework.
- [Add a framework](../../how-to/get-started/add-a-framework.md).
