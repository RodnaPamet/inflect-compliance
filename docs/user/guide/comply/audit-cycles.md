---
route: /t/[tenantSlug]/audits/cycles
---

# {{ui:audits.cycles.title}}

The {{ui:audits.cycles.title}} page lists your workspace's audit cycles. A cycle is one audit of one framework over one reporting period, such as an ISO 27001 recertification. {{ui:audits.cycles.subtitle}}

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** and click **{{ui:audits.hub.cycles}}** in the page's header. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.crumb.cycles}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the cycles, open one and see its readiness | Everyone who can see audits |
| Create a cycle | Owner, Admin, Editor |

## What it is for

Prepare for an audit before the auditor arrives. Each cycle tracks how ready you are for that audit, as a score, and holds the evidence pack you will hand over.

## What you see

**{{ui:audits.cycles.title}}**, the number of cycles, and **{{ui:audits.readinessLegend.title}}**:

- {{ui:audits.readinessLegend.green}}
- {{ui:audits.readinessLegend.amber}}
- {{ui:audits.readinessLegend.red}}

Then one card per cycle, with its readiness score in a ring, or **{{ui:audits.cycles.noScore}}**, its status, its name, its framework and version, and how many evidence packs it has. Each card has **{{ui:audits.cycles.openCycle}}** and **{{ui:audits.cycles.viewReadiness}}**.

A cycle's status is **{{ui:audits.cycleStatus.PLANNING}}**, **{{ui:audits.cycleStatus.IN_PROGRESS}}**, **{{ui:audits.cycleStatus.READY}}** or **{{ui:audits.cycleStatus.COMPLETE}}**.

## What you can do

### Create a cycle

1. Click **+ {{ui:audits.cycles.cycle}}**. The **{{ui:audits.cycles.newCycleTitle}}** window opens.
2. Choose the **{{ui:audits.cycles.frameworkLabel}}**. Only frameworks in use in the workspace are offered: a framework is in use once at least one control is mapped to it.
3. Give a **{{ui:audits.cycles.cycleName}}**.
4. Choose the **{{ui:audits.cycles.auditPeriod}}**: a preset such as a quarter or a year, or your own dates.
5. Click **{{ui:audits.cycles.createCycle}}**.

See [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md).

### Open a cycle

Click **{{ui:audits.cycles.openCycle}}** to work on the cycle and its evidence packs, or **{{ui:audits.cycles.viewReadiness}}** to see what is lowering its score.

## What happens next

- A new cycle starts in **{{ui:audits.cycleStatus.PLANNING}}**. Its score appears once it has been worked out from your controls and evidence.
- Each cycle's evidence pack is built and shared from the cycle. See [Build an audit pack](../../how-to/audits/build-an-audit-pack.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.cycles.emptyTitle}}** | The workspace has no audit cycles | Create one, or ask an Owner, Admin or Editor: {{ui:audits.cycles.emptyDescReadOnly}} |
| {{ui:audits.cycles.noFrameworkInUseHint}} | No framework has a control mapped to it yet | Install a framework first: {{ui:audits.cycles.openFrameworks}} |
| **{{ui:audits.cycles.frameworksLoadError}}** | The list of frameworks could not load | Close the window and open it again |
| **{{ui:audits.cycles.loadErrorTitle}}** | The cycles could not load | Click **{{ui:audits.cycles.retry}}** |
| **{{ui:audits.cycles.createError}}**, or the reason it was refused | The cycle was not created | Follow the reason given, then try again |

## Related

- [{{ui:audits.title}}](audits.md), the audits hub.
- [An audit pack](audit-pack-detail.md), the evidence you hand to the auditor.
- [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md).
