---
route: /t/[tenantSlug]/processes
---

# {{ui:automation.documentBar.processes}}

The {{ui:automation.documentBar.processes}} page is a drawing canvas for your business processes. You map a process as steps and connections, and link its steps to the controls, risks and assets they involve. A map can also become an automation workflow, whose steps run as rules when something happens in the workspace. Beside the canvas, three tabs manage and watch those automation rules.

## Where to find it

Open **{{ui:nav.processes}}** under **{{ui:nav.manage}}** in the sidebar. The entry appears only when the process canvas module is on for the workspace. Only an Owner can turn it on, from the modules section of the admin settings. While the module is off, the page reports that it was not found.

On a narrow screen the page lists the process maps but does not show the canvas: {{ui:processes.mobileHint}}

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, the maps, the rules, the analytics and the monitor | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create, edit, save, duplicate and restore maps | Owner, Admin, Editor |
| Delete a map | Owner, Admin |
| Create, edit, enable, disable, reorder and archive automation rules | Owner, Admin |
| Cancel a stuck rule run | Owner, Admin, Editor |
| Approve or reject a run waiting at a human checkpoint | Owner, Admin |

The canvas and its buttons are offered to every role in full: anyone can draw on it, and **{{ui:automation.documentBar.newProcess}}**, **{{ui:automation.documentBar.save}}** and **{{ui:automation.documentBar.delete}}** are always there. For a role that cannot make the change, saving fails with **{{ui:automation.documentBar.saveFailed}}** and nothing is kept. The same goes for the rule buttons on **{{ui:processes.tabRules}}** and the cancel button on **{{ui:processes.tabMonitor}}**.

If your workspace uses custom roles, editing maps also needs your custom role's permission to edit processes.

## What it is for

Use the canvas to document how work flows through the business, in a form your auditors can follow, with each step tied to the controls and risks that cover it. Use automation workflows when you want the workspace to act on its own: notify someone, create a task, change a status, call another system or start an agent when an event happens.

## What you see

**The tabs.** **{{ui:processes.tabCanvas}}**, **{{ui:processes.tabRules}}**, **{{ui:processes.tabAnalytics}}** and **{{ui:processes.tabMonitor}}**, and on the right **{{ui:processes.governanceLink}}**, which opens a graph of how the workspace's automation workflows call one another.

**{{ui:processes.tabCanvas}}.** Across the top, the document bar:

- A list to choose which map to work on, and the map's name, which you can edit in place.
- **{{ui:automation.documentBar.newProcess}}** and **{{ui:automation.documentBar.duplicate}}**.
- The map's mode: **{{ui:automation.documentBar.modeProcessMap}}** or **{{ui:automation.documentBar.modeAutomation}}**, with a button to convert it to the other.
- **{{ui:automation.documentBar.undo}}**, **{{ui:automation.documentBar.redo}}** and **{{ui:automation.documentBar.snap}}** to snap to the grid.
- The map's status, **{{ui:automation.documentBar.statusDraft}}**, **{{ui:automation.documentBar.statusActive}}** or **{{ui:automation.documentBar.statusArchived}}**.
- Whether your changes are saved: **{{ui:automation.documentBar.unsaved}}**, **{{ui:automation.documentBar.saving}}**, **{{ui:automation.documentBar.saved}}** or **{{ui:automation.documentBar.saveFailed}}**. Then **{{ui:automation.documentBar.save}}** and **{{ui:automation.documentBar.delete}}**.

On the left, a palette of the kinds of step you can place. In the middle, the canvas. On the right, the inspector, which shows the properties of the step or connection you select. A side panel lists the map's saved versions.

**{{ui:processes.tabRules}}.** The workspace's automation rules, with their name, the event that triggers each, the action it takes, its status, when it last fired, how many times it has run, and its priority. Click a rule to open its details. Above the list, **{{ui:processes.rules.templates}}** and **{{ui:processes.rules.addRule}}**.

**{{ui:processes.tabAnalytics}}.** How the rules have performed: **{{ui:processes.analytics.enabledRules}}**, how many runs, **{{ui:processes.analytics.successRate}}**, **{{ui:processes.analytics.avgDuration}}**, **{{ui:processes.analytics.stuckExecutionBreaches}}** and **{{ui:processes.analytics.errorRate}}**, a chart of runs over time and the rules that fire most.

**{{ui:processes.tabMonitor}}.** **{{ui:processes.monitor.recentActivity}}**, the latest rule runs, and any runs stuck past their time limit.

## What you can do

### Map a process

Click **{{ui:automation.documentBar.newProcess}}**, give the map a name, and place steps from the palette onto the canvas. Drag between two steps to connect them. Select a step or a connection to edit its label and details in the inspector, including the controls, risks and assets it is linked to. Press **/** on the canvas for a list of every canvas action, such as arranging the map automatically or grouping steps.

Your changes save on their own after a pause, and **{{ui:automation.documentBar.save}}** saves at once. Each save keeps a version you can compare against the current map or restore from the version list. Restoring keeps the history: the restored map becomes a new version.

### Turn a map into an automation workflow

Use the mode button to convert the map. Its steps become triggers, conditions and actions, each linked to an automation rule, and the inspector shows the rule's settings for the selected step. The rule appears on **{{ui:processes.tabRules}}**.

### Manage rules

On **{{ui:processes.tabRules}}**, Owners and Admins create a rule with **{{ui:processes.rules.addRule}}**, or start from one of the **{{ui:processes.rules.templates}}**. In a rule's details they can switch it on or off, change its priority, edit it, or archive it. Archiving gives you a few seconds to undo it.

### Handle a run that needs a person

A workflow can stop at a human checkpoint and wait. Owners and Admins approve or reject it from the canvas, which uses the same approval as the agent proposals queue. On **{{ui:processes.tabMonitor}}**, Owners, Admins and Editors can cancel a run that is stuck past its time limit.

### Delete a map

Click **{{ui:automation.documentBar.delete}}**. You are asked to type the map's name to confirm, because deleting cannot be undone.

## What happens next

- An active automation workflow's rules run whenever their event happens, and each run shows on **{{ui:processes.tabMonitor}}** and counts on **{{ui:processes.tabAnalytics}}**.
- Creating, saving, restoring and deleting maps are recorded in the workspace's audit log, naming who made them.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| The page was not found | The process canvas module is off | Ask an Owner to turn it on |
| **{{ui:processes.mobileEmpty}}** | The workspace has no process maps | Open the page on a larger screen to create one |
| **{{ui:automation.documentBar.saveFailed}}** | The latest change was not kept. Your role may not edit maps | Check your role; reload the page to see the map as it is stored |
| **{{ui:automation.documentBar.deleteFailed}}** | The map was not deleted. Only Owners and Admins can delete maps | Ask an Owner or Admin |
| **{{ui:processes.rules.emptyTitle}}** | The workspace has no automation rules | Owners and Admins click **{{ui:processes.rules.addRule}}** |
| **{{ui:processes.rules.loadError}}** | The rules did not load | Reload the page |
| **{{ui:processes.rules.archiveFailed}}** | The rule was not archived | Check your role, then try again |
| **{{ui:processes.analytics.emptyTitle}}** | No rule has run in the period | Nothing, until rules start running |
| **{{ui:processes.monitor.cancelFailed}}** | The run was not cancelled | Check your role, then try again |

## Related

- [{{ui:controls.title}}](../govern/controls.md), [{{ui:risks.title}}](../govern/risks.md) and [{{ui:assets.title}}](../govern/assets.md), the records a process step links to.
- [{{ui:agents.proposals.title}}](agent-proposals.md), the queue a human checkpoint uses.
- [{{ui:audits.crumb.businessContinuity}}](../comply/business-continuity.md), where a business impact analysis can be attached to a process step.
