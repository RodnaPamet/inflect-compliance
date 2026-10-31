---
route: /t/[tenantSlug]/onboarding
---

# {{ui:onboarding.wizard.title}}

The {{ui:onboarding.wizard.title}} walks a new workspace through its first configuration: the frameworks you follow, your key assets, a baseline of controls, a starter risk register and a set of first tasks. Each step does its work when you continue from it, so by the end the workspace has something in every register to start from.

## Where to find it

On the **{{ui:nav.dashboard}}**, Owners and Admins see the **{{ui:onboarding.banner.title}}** card until the wizard is finished. Click **{{ui:onboarding.banner.continue}}** on it. The card disappears once you complete the setup.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the wizard, work through its steps and finish it | Owner, Admin |

Every other role sees **{{ui:onboarding.wizard.accessRestricted}}**: {{ui:onboarding.wizard.accessRestrictedBody}}

## What it is for

Get from an empty workspace to a working one in one sitting. You can stop at any step and come back: what you have done is kept.

## What you see

The first time, a welcome card: **{{ui:onboarding.wizard.welcome}}** Click **{{ui:onboarding.wizard.startSetup}}**.

Then the wizard itself. On the left, **{{ui:onboarding.wizard.progress}}**: how many steps are done, and the list of steps, each ticked once completed. Click a step to go to it. On the right, the current step, with **{{ui:onboarding.wizard.back}}** and **{{ui:onboarding.wizard.continue}}** at the bottom. **{{ui:onboarding.wizard.saveExit}}** at the top keeps your answers on the current step and takes you to the dashboard.

The steps are:

| Step | What you do | What happens when you continue |
| --- | --- | --- |
| **{{ui:onboarding.wizard.steps.companyProfile}}** | Give your organisation's name, industry, country and size, and tick **{{ui:onboarding.wizard.companyProfile.usesAiTitle}}** if it applies | Your answers are kept with the setup. They do not rename the workspace. The AI box adds the **{{ui:onboarding.wizard.steps.aiGovernance}}** step |
| **{{ui:onboarding.wizard.steps.frameworks}}** | Choose at least one framework. A framework split into packs also needs at least one pack | The frameworks and their baseline controls are installed |
| **{{ui:onboarding.wizard.steps.nis2Assessment}}** | Only if you chose NIS2. Answer the gap-assessment questions | Your answers become the first run of the NIS2 gap assessment |
| **{{ui:onboarding.wizard.steps.aiGovernance}}** | Only if you chose an AI framework or ticked the AI box. Answer the AI-governance questions | You can create findings for the gaps |
| **{{ui:onboarding.wizard.steps.digitalSovereignty}}** | Only if you chose NIS2, DORA or the EU AI Act. Score each sovereignty question | You can create the suggested risks and controls for weak areas |
| **{{ui:onboarding.wizard.steps.assets}}** | Type the names of your key systems and click **{{ui:onboarding.wizard.assets.add}}** for each | Each asset is created, classified as internal, unless one of that name already exists |
| **{{ui:onboarding.wizard.steps.controls}}** | Tick **{{ui:onboarding.wizard.controls.confirm}}** | Anything missing from the frameworks' baseline controls is installed |
| **{{ui:onboarding.wizard.steps.risks}}** | Leave **{{ui:onboarding.wizard.risks.generate}}** ticked, or untick it | Starter risks are added, chosen from your frameworks and the kinds of asset you listed |
| **{{ui:onboarding.wizard.steps.team}}** | Optionally list the colleagues you plan to invite: type an address and click **{{ui:onboarding.wizard.team.add}}** | Five starter tasks are created, such as assigning control owners. Nothing is sent from this step: invite each person from the members page, which the step links to, where you choose their role |
| **{{ui:onboarding.wizard.steps.reviewFinish}}** | Check the summary of each step | Click **{{ui:onboarding.wizard.completeSetup}}** to finish |

The three self-assessment steps have their own buttons in place of **{{ui:onboarding.wizard.continue}}**: complete the assessment, or skip it for now and return to it later.

The starter risks and tasks are written in the language you are using the app in when you continue from their step. They are ordinary records after that, so switching language later does not translate them.

## What you can do

### Leave and come back

Click **{{ui:onboarding.wizard.saveExit}}** at any point. **{{ui:onboarding.banner.continue}}** on the dashboard brings you back to where you were.

### Go back to a step

Click it in the list on the left, or click **{{ui:onboarding.wizard.back}}**. Continuing from a step again does not create its assets, risks or tasks twice.

### Finish

On **{{ui:onboarding.wizard.steps.reviewFinish}}**, click **{{ui:onboarding.wizard.completeSetup}}**. **{{ui:onboarding.wizard.completeExclaim}}** appears and you are taken to the dashboard. If you chose NIS2, the message also links to your NIS2 gap assessment.

## What happens next

- The frameworks, controls, assets, risks and tasks the wizard created are ordinary records. Change or delete them on their own pages.
- Opening the wizard after you have finished shows **{{ui:onboarding.wizard.completeTitle}}** and **{{ui:onboarding.wizard.goToDashboard}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:onboarding.wizard.accessRestricted}}** | Your role cannot set up the workspace | Ask an Owner or Admin |
| **{{ui:onboarding.wizard.frameworks.selectAtLeastOne}}** | No framework is chosen, so **{{ui:onboarding.wizard.continue}}** is disabled | Choose one |
| **{{ui:onboarding.wizard.frameworks.none}}** | No framework can be installed | Ask your administrator |
| **{{ui:onboarding.wizard.frameworks.installFailedTitle}}** | One or more frameworks did not install, each named with the reason | {{ui:onboarding.wizard.frameworks.installFailedHint}} |
| **{{ui:onboarding.wizard.controls.frameworksRequired}}** | The controls step has no framework to install from | Go back to **{{ui:onboarding.wizard.steps.frameworks}}** |
| **{{ui:onboarding.wizard.errors.completeStep}}**, **{{ui:onboarding.wizard.errors.save}}**, or a reason in red at the top | The step was not saved | Follow the reason given, then try again |
| **{{ui:onboarding.wizard.automationFailed.title}}** | The step was saved, but creating its assets, risks or tasks failed. The notice names each such step | {{ui:onboarding.wizard.automationFailed.hint}} |

## Related

- [{{ui:dashboard.title}}](dashboard.md), where the setup card appears.
- [{{ui:frameworks.list.heading}}](../govern/frameworks.md), to install a framework later.
