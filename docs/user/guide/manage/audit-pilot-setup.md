---
route: /t/[tenantSlug]/agents/audit-pilot
---

# {{ui:agents.auditPilot.title}}

The {{ui:agents.auditPilot.title}} page sets up the pilot auditor: a registered agent that runs the first five audit procedures on a schedule and reports what it finds as proposed findings for a person to review. You become the auditor's owner. The page shows a dry run first, so you can see every step before anything is written.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.auditPilot}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.auditPilot.crumbAgents}}** › **{{ui:agents.auditPilot.title}}**, and the page's own **{{ui:common.ui.viewsMenu}}** sits at the top right.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin, AI admin |
| See the dry run and set the pilot up | Owner or Admin whose line of defence is second line |

An AI admin can open the page but cannot set the pilot up, because the set-up also creates control test plans, which an AI admin cannot do.

Everyone else sees **{{ui:agents.auditPilot.accessTitle}}** instead of the page.

## Before you start

- Your membership must be marked as **second line**. An Owner sets each member's line of defence on the [Members](../admin/members.md) page, and nobody can set their own.
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

If you cannot set the pilot up, a notice says so before anything else: **{{ui:agents.auditPilot.readiness.heading}}**, followed by each permission your role is missing and, if it applies, that your membership is not marked second line. The page then runs no dry run, and its buttons stay greyed out.

Each step is named in words, such as **{{ui:agents.auditPilot.stepKind.REGISTER}}**, **{{ui:agents.auditPilot.stepKind.GRANT}}** or **{{ui:agents.auditPilot.stepKind.ACTIVATE}}**, and each plan by its procedure's name. A plan that already exists with other settings says: {{ui:agents.auditPilot.planDiffers}} Click **{{ui:agents.auditPilot.technicalDetail}}** under a step to see the exact detail the set-up recorded.

If the set-up cannot go ahead at all, the page says why in a sentence instead of listing steps, with the exact detail under **{{ui:agents.auditPilot.technicalDetail}}**.

## What you can do

### Set the pilot up

1. Open the page. It runs a dry run straight away.
2. Change the auditor's name if you want, and name a control for any procedure the dry run could not match.
3. Click **{{ui:agents.auditPilot.check}}** to run the dry run again.
4. When the steps look right, click **{{ui:agents.auditPilot.apply}}**. The button works only when the dry run has something to change.
5. Read the confirmation and click **{{ui:agents.auditPilot.confirmAction}}**. {{ui:agents.auditPilot.confirmBody}}

### Finish activation

The auditor is registered as a draft. If **{{ui:agents.auditPilot.stepKind.ACTIVATE}}** is waiting for a risk assessment, it says: {{ui:agents.auditPilot.waitingOn.UNSCORED}} Click **{{ui:agents.auditPilot.openAuditor}}** to go there, complete the assessment, then come back and click **{{ui:agents.auditPilot.check}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:agents.auditPilot.nameAControl}} | A procedure's control could not be matched, or matched more than one control | Name the control for that procedure |
| **{{ui:agents.auditPilot.readiness.heading}}** | Your role is missing a permission the set-up needs, or your membership is not marked second line | Ask an Owner for what the notice names |
| {{ui:agents.auditPilot.refusal.OWNER_NOT_INDEPENDENT}} | You own agents the auditor would audit | Move those agents to another owner, or have someone else own the auditor |
| {{ui:agents.auditPilot.refusal.AUDITOR_OWNED_BY_ANOTHER}} | Someone else already owns an auditor with this name | Choose another name |
| {{ui:agents.auditPilot.refusal.AUDITOR_RETIRED}} | An auditor with this name was retired | Choose another name |
| {{ui:agents.auditPilot.requestFailed}} | The dry run or set-up did not go through | Try again |
| **{{ui:agents.auditPilot.accessTitle}}** | {{ui:agents.auditPilot.accessMessage}} | Ask an Owner or Admin |

## Related

- [Agents](agents.md), the agent register, where the auditor appears once registered.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where the auditor's proposed findings are reviewed.
