---
route: /t/[tenantSlug]/processes/governance
---

# {{ui:processes.governance.topologyHeading}}

The {{ui:processes.governance.topologyHeading}} page lists every automation map in the workspace with its number of rules and how reliably it has run over the last 30 days, and shows which maps call one another.

## Where to find it

Open **{{ui:nav.processes}}** under **{{ui:nav.manage}}** in the sidebar and click **{{ui:processes.governanceLink}}** at the right of the tabs. The page exists only while the process canvas module is on for the workspace. The breadcrumb reads **{{ui:processes.governance.crumbDashboard}}** › **{{ui:processes.governance.crumbProcesses}}** › **{{ui:processes.governance.crumbGraph}}**.

## Who can use it

Every role can open the page: Owner, Admin, Editor, Reader, Auditor and AI admin. It changes nothing.

## What it is for

Use it to see the automation estate as a whole: which maps carry the most rules, which are failing, and which depend on others, before you change one. {{ui:processes.governance.topologyDescription}}

## What you see

**The maps.** One card per automation map, with:

- its name and an **{{ui:processes.governance.canvasMode.AUTOMATION}}** badge;
- how many rules it holds;
- its success rate over the last 30 days, or **{{ui:processes.governance.noRuns}}** when it has not run;
- a coloured ring for its health: green at 90% success or more, amber from 70%, red below that, and grey when it has not run.

**{{ui:processes.governance.subflowCalls}}.** When maps are connected, a list of the connections, each as "source map → target map" with the kind of connection: a sub-flow call, where one map starts another, or a shared rule, where two maps use the same rule.

## What you can do

The page is for reading. To change a map or its rules, go back to **{{ui:nav.processes}}** and open the map on its canvas or the **{{ui:processes.tabRules}}** tab.

## What happens next

The figures update as the automations run. Reload the page to see the latest.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:processes.governance.building}}** | The page is still reading the maps | Wait a moment |
| **{{ui:processes.governance.empty}}** | The workspace has no automation maps | Create an automation workflow on the {{ui:nav.processes}} page |
| **{{ui:processes.governance.errorTitle}}** with **{{ui:processes.governance.retry}}** | The maps could not be read. The page shows nothing rather than an empty estate | Click **{{ui:processes.governance.retry}}** |

## Related

- [{{ui:nav.processes}}](processes.md), where the maps and their rules are built.
