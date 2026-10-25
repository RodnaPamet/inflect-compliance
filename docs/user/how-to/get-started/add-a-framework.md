# Add a framework

Add a framework, such as ISO 27001 or NIS2, when your organisation needs to meet it. Every framework's requirements can already be read in Inflect. Adding one installs its control pack: the controls the standard defines, starter tasks for each control, and the links that map each control to the requirements it covers.

## Before you start

- You need the Owner or Admin role. With a custom role, you can add a framework when your role was given permission to install frameworks, whatever its base role.
- Without that permission you see no button that adds a framework: no **{{ui:frameworks.list.importFramework}}**, no **{{ui:frameworks.detail.installPack}}** and no **{{ui:frameworks.templates.install}}**. Every role can still open a framework and read its requirements.
- Adding a framework never removes or overwrites controls you already have. If your workspace already holds a control with the same code as one in the pack, Inflect keeps your control as it is and maps it to the framework's requirements.
- A framework can offer more than one pack. If it does, decide which one you need.

## Steps

1. Click **{{ui:nav.audits}}** under {{ui:nav.comply}} in the sidebar. The {{ui:audits.title}} page opens. Frameworks have no sidebar entry of their own.
2. In the page header, beside {{ui:audits.hub.related}}, click **{{ui:audits.nav.frameworks}}**. The {{ui:frameworks.list.heading}} page opens. You can also click **{{ui:common.search}}** in the sidebar, or press Ctrl+K (⌘K on a Mac), and choose **Go to Frameworks**.
3. Find the framework. Each one is marked {{ui:frameworks.list.inUse}} or {{ui:frameworks.list.available}}, and shows its number of {{ui:frameworks.list.requirements}} and {{ui:frameworks.list.packs}} and its {{ui:frameworks.list.coverage}}. {{ui:frameworks.list.inUse}} means at least one of the framework's requirements has a control mapped to it; hold the pointer over the label to see this. Click the framework's name to open it.
4. Click **{{ui:frameworks.detail.installPack}}** at the top of the framework's page. To install a particular pack, open the **{{ui:frameworks.detail.packsTab}}** tab instead and click **{{ui:frameworks.detail.installPack}}** beside that pack.
5. If the framework has more than one pack, choose one under {{ui:frameworks.install.selectAPack}}. When there is only one, or you picked a pack in step 4, the page goes straight to the preview.
6. Check the preview. It counts the {{ui:frameworks.install.newControls}} the pack will create and the controls that {{ui:frameworks.install.alreadyExist}}, then lists each control with its number of tasks. A control your workspace already has is marked {{ui:frameworks.install.exists}}. To choose another pack, click **{{ui:frameworks.install.back}}**.
7. Click the install button below the preview. Its label says how many controls it will create. While it works it reads {{ui:frameworks.install.installing}}. A large framework can take a little while.
8. The page reads {{ui:frameworks.install.successHeading}} and shows the number of {{ui:frameworks.install.controlsCreated}}, {{ui:frameworks.install.tasksCreated}} and {{ui:frameworks.install.mappingsCreated}}. Click **{{ui:frameworks.install.viewControls}}** to see the new controls, or **{{ui:frameworks.install.backToFramework}}**.

**{{ui:frameworks.list.importFramework}}** on the {{ui:frameworks.list.heading}} page also opens this install page. It picks the first framework that is not in use yet, which may not be the one you want, so check the framework's name at the top of the page.

## Install only some controls

To add a few controls from a framework rather than its whole pack, click **{{ui:frameworks.detail.browseTemplates}}** on the framework's page. The template library lists each control with {{ui:frameworks.templates.installed}} or {{ui:frameworks.templates.available}}. Click a control's title to see the requirements it maps to, its default tasks and, when its tasks name them, the {{ui:frameworks.templates.suggestedEvidence}} those tasks produce. Click **{{ui:frameworks.templates.install}}** on one control, or tick several and click the install button that appears at the top. **{{ui:frameworks.templates.selectAllUninstalled}}** ticks every control you do not have yet.

If an install is refused or does not finish, the library shows the reason above the list. When several were ticked, they stay ticked, so you can try again.

## Use the setup wizard instead

A new workspace has a setup wizard, and its {{ui:onboarding.wizard.steps.frameworks}} step adds frameworks too.

1. On the {{ui:nav.dashboard}} page, find the **{{ui:onboarding.banner.title}}** card and click **{{ui:onboarding.banner.continue}}**. Only Owners and Admins see the card, and only until the wizard is complete.
2. If the wizard has not started yet, click **{{ui:onboarding.wizard.startSetup}}**.
3. Open the **{{ui:onboarding.wizard.steps.frameworks}}** step, from the list of steps on the left or by clicking **{{ui:onboarding.wizard.continue}}** through the steps before it.
4. Click each framework you need. A chosen framework reads {{ui:onboarding.wizard.frameworks.selected}}. **{{ui:onboarding.wizard.continue}}** stays greyed out until you choose at least one. The step has no skip.
5. Click **{{ui:onboarding.wizard.continue}}**. Inflect installs every pack of each framework you chose.

The wizard shows no preview and no count of what it created. If a framework could not be installed, the wizard says {{ui:onboarding.wizard.frameworks.installFailedTitle}} at the top and names each framework with the reason. Afterwards, open the {{ui:frameworks.list.heading}} page to check that each framework now reads {{ui:frameworks.list.inUse}}. Once the wizard reads {{ui:onboarding.wizard.completeTitle}}, add further frameworks from the {{ui:frameworks.list.heading}} page.

## What happens next

- The new controls appear on the **{{ui:nav.controls}}** page with the status {{ui:controls.statusLabels.NOT_STARTED}}. Each comes with its starter tasks, which are open and assigned to the person who installed the framework.
- If a new control's template names a policy your workspace already has, matched by title, Inflect links that policy to the control.
- On the framework's **{{ui:frameworks.detail.reqTab}}** tab, click a requirement to see the controls mapped to it. The **{{ui:frameworks.detail.coverageTab}}** tab counts {{ui:frameworks.detail.mapped}} and {{ui:frameworks.detail.unmapped}} requirements.
- The framework now reads {{ui:frameworks.list.inUse}}. That label, and the coverage figure, only mean that controls are mapped to the requirements. They do not show whether the controls work. Evidence and tests show that.
- You can run the install again later. It creates only the controls that are missing, and the controls you already have keep their details.
- The installation is recorded in the workspace's audit log, with the number of controls, tasks and mappings it created.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworks.detail.installPack}}** does not appear on the framework's page, or **{{ui:frameworks.list.importFramework}}** does not appear on the {{ui:frameworks.list.heading}} page | Your role cannot add frameworks | Ask an Owner or Admin |
| {{ui:frameworks.install.restrictedTitle}} on the install page | You opened the install page, but your role cannot add frameworks | Ask an Owner or Admin |
| **You do not have permission to install frameworks.** after you click an install button | Your role cannot add frameworks. It may have changed after you opened the page | Ask an Owner or Admin |
| The template library shows no **{{ui:frameworks.templates.install}}** buttons and no tick boxes | Your role cannot add controls from a framework | Ask an Owner or Admin |
| {{ui:frameworks.templates.installFailed}} in the template library | The install did not finish | Reload the page. Controls that now exist read {{ui:frameworks.templates.installed}}. Install the rest again |
| The install button reads {{ui:frameworks.install.allInstalled}} and is greyed out | Every control in the pack is already in your workspace | Nothing to do. The framework is already in place |
| {{ui:frameworks.install.packsEmpty}} | This framework has no pack to install | Its requirements can still be read. Map your own controls to them on each control's **{{ui:controls.detailPage.tabRequirements}}** tab |
| {{ui:frameworks.install.installFailed}} or {{ui:frameworks.install.networkError}} | The install did not finish | Reload the page. The preview shows which controls now exist. Install again to add any that are missing |
| {{ui:frameworks.install.notFound}} | The page could not find the framework | Go back to the {{ui:frameworks.list.heading}} page and open the framework from there |
| {{ui:frameworks.list.empty}} | No frameworks are loaded into this installation of Inflect | Ask whoever runs your Inflect installation to load them |
| A dash in place of a framework's {{ui:frameworks.list.coverage}} and its status, with the hint {{ui:frameworks.list.coverageError}} | Inflect could not work out that framework's coverage this time, so it cannot say whether the framework is in use | Reload the page |
| {{ui:onboarding.wizard.frameworks.installFailedTitle}} at the top of the setup wizard | Each framework it names was not installed, for the reason beside it | If the reason says you do not have permission, ask an Owner or Admin. Otherwise add the framework from the {{ui:frameworks.list.heading}} page |
