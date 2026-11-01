---
route: /t/[tenantSlug]/agents/audit-pilot
---

# {{ui:agents.auditPilot.title}}

The {{ui:agents.auditPilot.title}} page sets up the pilot auditor: a registered agent that runs the first five audit procedures on a schedule and reports what it finds as proposed findings for a person to review. You become the auditor's owner. The page shows a dry run first, so you can see every step before anything is written.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.auditPilot}}**. The breadcrumb reads **{{ui:agents.auditPilot.crumbAgents}}** › **{{ui:agents.auditPilot.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see the dry run | Owner, Admin, AI admin |
| Set the pilot up | Owner or Admin whose line of defence is second line |

Everyone else sees **{{ui:agents.auditPilot.accessTitle}}** instead of the page.

## Before you start

- Your membership must be marked as **second line**. An Owner sets each member's line of defence on the [Members](../admin/members.md) page.
- The auditor must stay independent of what it audits, so its owner must not be one of the people it would be auditing. If you are not independent, the dry run says why.

## What it sets up

{{ui:agents.auditPilot.intro}}

Each procedure's plan runs on the control it audits, matched by its ISO/IEC 27001 reference. Running the set-up again changes nothing that is already in place.

## What you see

**{{ui:agents.auditPilot.inputsHeading}}**:

- **{{ui:agents.auditPilot.nameLabel}}**. {{ui:agents.auditPilot.nameHint}}
- **{{ui:agents.auditPilot.controlsLabel}}**, one row for each of the five procedures. {{ui:agents.auditPilot.controlsHint}}

**{{ui:agents.auditPilot.dryRunHeading}}**, or **{{ui:agents.auditPilot.appliedHeading}}** after you set it up. Each step shows what it is, and its outcome:

| Outcome | What it means |
| --- | --- |
| **{{ui:agents.auditPilot.outcome.UNCHANGED}}** | Already set up; nothing to do |
| **{{ui:agents.auditPilot.outcome.WOULD_CHANGE}}** | The set-up would make this change |
| **{{ui:agents.auditPilot.outcome.CHANGED}}** | The set-up made this change |
| **{{ui:agents.auditPilot.outcome.PENDING}}** | Waiting for something else first, such as the auditor's risk assessment |
| **{{ui:agents.auditPilot.outcome.DIFFERS}}** | Something already exists but differs from the pilot's set-up. It is reported, not changed |

If the set-up cannot go ahead at all, the page says why instead of listing steps.

## What you can do

### Set the pilot up

1. Open the page. It runs a dry run straight away.
2. Change the auditor's name if you want, and name a control for any procedure the dry run could not match.
3. Click **{{ui:agents.auditPilot.check}}** to run the dry run again.
4. When the steps look right, click **{{ui:agents.auditPilot.apply}}**. The button works only when the dry run has something to change.
5. Read the confirmation and click **{{ui:agents.auditPilot.confirmAction}}**. {{ui:agents.auditPilot.confirmBody}}

### Finish activation

The auditor is registered as a draft. If the step **activate** says it is waiting for a risk assessment, complete the auditor's risk assessment on its page, then come back and run the set-up again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:agents.auditPilot.nameAControl}} | A procedure's control could not be matched, or matched more than one control | Name the control for that procedure |
| A reason saying your line of defence is not second line | Your membership is not marked second line | Ask an Owner to set it on the Members page |
| A reason naming permissions you do not hold | Your role cannot register the auditor or schedule its plans | Ask an Owner |
| {{ui:agents.auditPilot.requestFailed}} | The dry run or set-up did not go through | Try again |
| **{{ui:agents.auditPilot.accessTitle}}** | {{ui:agents.auditPilot.accessMessage}} | Ask an Owner or Admin |

## Related

- [Agents](agents.md), the agent register, where the auditor appears once registered.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where the auditor's proposed findings are reviewed.
