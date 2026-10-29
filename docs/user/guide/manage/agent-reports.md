---
route: /t/[tenantSlug]/agents/reports
---

# {{ui:agents.reports.title}}

The {{ui:agents.reports.title}} page answers "show me your agent governance". It has two tabs: an assessor pack of six reports built from the agent register, its assessments, its approvals and its stop control, and a harness matrix built from the scans that look for agents outside the register. Every figure is worked out when the page opens; nothing on it is stored or cached.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.reports}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.reports.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open both tabs | Owner, Admin, AI admin, Auditor |
| File the pack in the evidence library | Owner, Admin |
| Declare, edit or remove an estate | Owner, Admin, AI admin |
| See, register and revoke trusted scanner keys | Owner, Admin, AI admin |
| Register a shadow agent | Owner, Admin, AI admin |
| Accept or renew an agent's harness shortfall | The agent's accountable owner, when they are an Owner, Admin or AI admin |

Editors and Readers see **{{ui:agents.register.accessTitle}}** instead of the page. Auditors read both tabs without any of their buttons. The approvals report links to the review-quality page, which Auditors cannot open.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. Filing the pack also needs permission to edit evidence.

## What it is for

Use the pack when an auditor or assessor asks how your agents are governed: what is registered, which risks your controls cover, whether approvals are checked, what went wrong and whether the stop control works. Use the harness tab to see agents a scanner found in your own environments, how well each one is controlled, and which ones nobody has registered.

## What you see

**The header.** The page title, **{{ui:agents.reports.exportAction}}** for roles that can file it, and the **{{ui:common.ui.viewsMenu}}** menu. Below it, **{{ui:agents.reports.tabPack}}** and **{{ui:agents.reports.tabHarness}}** switch tabs. The page opens on the pack.

**Every figure has its definition.** Under each number a line says what it counts, and the information icon beside it says when it was measured, what counts in and what counts out. A figure that cannot be given shows the reason in its place, such as **{{ui:agents.reports.basis.NO_DRILLS_RUN}}**, never a zero. A report that reached its row limit says so beside its figures. Figures that count over time cover the last 90 days.

### {{ui:agents.reports.tabPack}}

- **A red notice**, **{{ui:agents.reports.notEnforcingTitle}}**, when the workspace does not enforce agent registration. Every figure is then true of what is recorded and says nothing about what is enforced.
- **The stamp**: {{ui:agents.reports.stampTenant}}, {{ui:agents.reports.stampGenerated}} and {{ui:agents.reports.stampPopulation}}, so a screenshot carries its own context.
- **{{ui:agents.reports.inventoryHeading}}.** Counts over the registered agents.
- **{{ui:agents.reports.asiHeading}}.** How far this workspace's own controls cover the OWASP risks for agents, and for each agent the risks **not covered** and those **claimed but unverified**. A note explains that this is not the product's own coverage figure. Without the OWASP agentic framework installed, a warning says nothing could be measured.
- **{{ui:agents.reports.approvalsHeading}}.** How agent proposals were decided and how often a second reviewer disagreed, with a list of what this report cannot see and the link **{{ui:agents.reports.approvalsDetailLink}}**.
- **{{ui:agents.reports.incidentsHeading}}.** Kill-switch drills and engagements, then each kill switch engaged in the window: the agent, or **{{ui:agents.reports.killScopeTenant}}**, when it was engaged, the reason given, and **{{ui:agents.reports.killStillInForce}}** where it applies.
- **{{ui:agents.reports.thirdPartyHeading}}.** Each third-party agent with its supplier, linked to the vendor, and the date of the supplier's last completed assessment, or **{{ui:agents.reports.thirdPartyUnassessed}}**. An agent with no supplier is flagged in red.
- **{{ui:agents.reports.workpaperReviewHeading}}.** How often internal audit agreed with the auditor agent's workpapers it re-performed. Only concluded reviews count.

### {{ui:agents.reports.tabHarness}}

A note at the top says the levels are reported, never enforced: an agent below its bar raises a finding and is never stopped by it. Then, in order:

- **{{ui:agents.harness.estates.heading}}.** Each estate is one of your environments that one scanner covers, on a schedule you declare. It reads **{{ui:agents.harness.estates.status.FRESH}}** while its last complete scan is younger than one and a half times that schedule, and **{{ui:agents.harness.estates.status.STALE}}** otherwise. Each source it reads is listed with the member who answers for it.
- **One section per scanner** that reported recently, headed with the scanner's name, whether its latest scan was **{{ui:agents.harness.completeness.COMPLETE}}**, **{{ui:agents.harness.completeness.INCOMPLETE}}** or **{{ui:agents.harness.completeness.EMPTY}}**, and when. A warning names any source the scan could not read in full. Below it, what changed since that scanner's previous scan, then the matrix.
- **The matrix.** One row per agent the scan found, worst first. {{ui:agents.harness.colAgent}} gives its name, marked **{{ui:agents.harness.shadowBadge}}** when it is not in the register. {{ui:agents.harness.colLevel}} runs from **{{ui:agents.harness.level.H0}}** to **{{ui:agents.harness.level.H5}}**. {{ui:agents.harness.colReach}} is {{ui:agents.harness.reach.READ_ONLY}}, {{ui:agents.harness.reach.WRITE_OR_EXTERNAL}} or {{ui:agents.harness.reach.UNKNOWN}}. A read-only agent is held to H2 and any other to H3, and one below that bar is flagged. {{ui:agents.harness.colModels}} lists the model endpoints the scanner reported, and {{ui:agents.harness.colAcceptance}} the accepted shortfall, if any. One column per criterion follows, each reading **{{ui:agents.harness.cell.EVIDENCED}}** only when the scanner reported it met with evidence.
- **{{ui:agents.harness.acceptancesHeading}}**, each with its level, end date and whether it is still in force.
- **{{ui:agents.harness.shadowHeading}}**, the agents a scan found with no live row in the register.
- **{{ui:agents.harness.scansHeading}}**, every recent scan with its scanner, completeness and sources.
- **{{ui:agents.harness.keys.heading}}**, for roles that can manage the register. Only a report signed by a key listed here counts.

Source names on this tab appear as short codes, such as entra-sp or okta-app.

## What you can do

### File the pack as evidence

Click **{{ui:agents.reports.exportAction}}**. The pack is saved as a document in the evidence library, in the Agent governance folder, kept for seven years, and a message confirms it. Nothing is downloaded. When registration is not enforced, the filed document says so at the top.

### Declare an estate

On the harness tab, click **{{ui:agents.harness.estates.declare}}**. Fill in **{{ui:agents.harness.estates.form.nameLabel}}**, choose the **{{ui:agents.harness.estates.form.scannerLabel}}** from the registered agents that cover no other estate, fill in **{{ui:agents.harness.estates.form.cadenceLabel}}**, and add at least one source with its owner, an active member. Click **{{ui:agents.harness.estates.form.submitDeclare}}**. **{{ui:agents.harness.estates.edit}}** changes everything but the scanner; **{{ui:agents.harness.estates.remove}}** takes the estate away after five seconds, during which **{{ui:agents.harness.estates.undo}}** keeps it.

### Register or revoke a scanner key

In **{{ui:agents.harness.keys.heading}}**, click **{{ui:agents.harness.keys.register}}**, choose the registered agent that runs the scanner, paste its public key and click **{{ui:agents.harness.keysModal.submit}}**. To stop trusting a key, click **{{ui:agents.harness.keys.revoke}}** and confirm with **{{ui:agents.harness.keys.revokeConfirm}}**. Reports signed by it are refused from then on, and the same key cannot be registered again.

### Register a shadow agent

In **{{ui:agents.harness.shadowHeading}}**, click **{{ui:agents.harness.register}}** on its row. In **{{ui:agents.harness.registerModal.title}}**, choose the accountable owner yourself and tick the box confirming them; any suggestion shown is never used as the owner. Answer how far the agent reaches, give our role for its AI system, and click **{{ui:agents.harness.registerModal.submit}}**. The agent joins the register as a draft, with an AI-system entry that has no tier. It cannot be activated until that entry is classified.

### Accept a shortfall

When you own an agent that is below its bar, its row offers **{{ui:agents.harness.accept}}**, or **{{ui:agents.harness.renew}}** while an acceptance is in force. Write why the workspace carries the risk, choose the last day it holds, at most a year ahead, and save. Anyone else sees a note that only the agent's owner can accept.

## What happens next

- A filed pack is an ordinary evidence item, and its filing is recorded in the workspace's audit log.
- An accepted shortfall closes the shortfall finding. When the acceptance lapses, the finding reopens if the agent is still below its bar.
- A registered shadow agent leaves the shadow list at the next scan that sees it, and its finding closes at the next complete scan.
- An estate with no complete scan for too long turns **{{ui:agents.harness.estates.status.STALE}}**, and a daily check raises a finding for it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.register.accessTitle}}** | Your role cannot read the agent register | Ask an Owner or Admin |
| **{{ui:agents.reports.emptyTitle}}** | No agent is registered, so there is nothing to report | Register agents on the {{ui:agents.register.title}} |
| **{{ui:agents.harness.noScansTitle}}** | No scanner has sent a report, so nothing has looked for agents outside the register | Register a scanner key and run a scanner |
| **{{ui:agents.harness.emptyScanTitle}}** | A scan found nothing, which proves nothing | Check what the scanner reads |
| **{{ui:agents.harness.estates.none}}** | No estate is declared | Declare one per scanner |
| **{{ui:agents.reports.exportFailed}}** | The pack was not filed | Try again |
| **{{ui:agents.harness.acceptModal.failed}}**, **{{ui:agents.harness.registerModal.failed}}**, **{{ui:agents.harness.keysModal.failed}}** or **{{ui:agents.harness.estates.form.failed}}** | The change did not go through. A reason from the server is shown when there is one | Correct it and try again |

## Related

- [{{ui:agents.register.title}}](agents.md), for the agents these reports describe.
- [{{ui:agents.proposals.title}}](agent-proposals.md), whose decisions the approvals report measures.
- [{{ui:agents.runs.title}}](agent-runs.md), for what agents have done.
