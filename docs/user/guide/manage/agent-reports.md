---
route: /t/[tenantSlug]/agents/reports
---

# {{ui:agents.reports.title}}

The {{ui:agents.reports.title}} page answers "show me your agent governance". It has four tabs: an assessor pack of six reports built from the agent register, its assessments, its approvals and its stop control; a harness matrix built from the scans that look for agents outside the register; the third-party applications your directories have granted access to; and the days an agent behaved unlike itself. Every figure is worked out when the page opens; nothing on it is stored or cached.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.reports}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.reports.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the pack, the harness matrix and the integrations tab | Owner, Admin, AI admin, Auditor |
| Open the behaviour anomalies tab | Owner, Admin, AI admin |
| File the pack in the evidence library | Owner, Admin |
| Declare, edit or remove an estate | Owner, Admin, AI admin |
| See, register and revoke trusted scanner keys | Owner, Admin, AI admin |
| Register a shadow agent or an unregistered identity | Owner, Admin, AI admin |
| Accept or renew an agent's harness shortfall | The agent's accountable owner, when they are an Owner, Admin or AI admin |

Editors and Readers see **{{ui:agents.register.accessTitle}}** instead of the page. Auditors read the pack, the harness matrix and the integrations tab without any of their buttons, are not offered the behaviour anomalies tab, and without the approvals report's link to the review-quality page, which they cannot open.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. Filing the pack also needs permission to edit evidence.

## What it is for

Use the pack when an auditor or assessor asks how your agents are governed: what is registered, which risks your controls cover, whether approvals are checked, what went wrong and whether the stop control works. Use the harness tab to see agents a scanner found in your own environments, how well each one is controlled, and which ones nobody has registered. Use the integrations tab to see which outside applications hold access to your directories, and the behaviour anomalies tab to see which agents have recently acted unlike themselves.

## What you see

**The header.** The page title, **{{ui:agents.reports.exportAction}}** for roles that can file it, and the **{{ui:common.ui.viewsMenu}}** menu. Below it, **{{ui:agents.reports.tabPack}}**, **{{ui:agents.reports.tabHarness}}**, **{{ui:agents.reports.tabIntegrations}}** and, for roles that can open it, **{{ui:agents.reports.tabBehaviour}}** switch tabs. The page opens on the pack.

**Every figure has its definition.** Under each number a line says what it counts, and the information icon beside it says when it was measured, what counts in and what counts out. A figure that cannot be given shows the reason in its place, such as **{{ui:agents.reports.basis.NO_DRILLS_RUN}}**, never a zero. A report that reached its row limit says so beside its figures. Figures that count over time cover the last 90 days.

### {{ui:agents.reports.tabPack}}

- **A red notice**, **{{ui:agents.reports.notEnforcingTitle}}**, when the workspace does not enforce agent registration. Every figure is then true of what is recorded and says nothing about what is enforced.
- **The stamp**: {{ui:agents.reports.stampTenant}}, {{ui:agents.reports.stampGenerated}} and {{ui:agents.reports.stampPopulation}}, so a screenshot carries its own context.
- **{{ui:agents.reports.inventoryHeading}}.** Counts over the registered agents, including how many hold a declared spending authority and how many of those nobody but the declarer has reviewed. The document filed with **{{ui:agents.reports.exportAction}}** names each such agent, its payment rails and their review standing.
- **{{ui:agents.reports.asiHeading}}.** How far this workspace's own controls cover the OWASP risks for agents, and for each agent the risks **not covered** and those **claimed but unverified**. A note explains that this is not the product's own coverage figure. Without the OWASP agentic framework installed, a warning says nothing could be measured.
- **{{ui:agents.reports.approvalsHeading}}.** How agent proposals were decided and how often a second reviewer disagreed, with a list of what this report cannot see and, for roles that can open the review-quality page, the link **{{ui:agents.reports.approvalsDetailLink}}**.
- **{{ui:agents.reports.incidentsHeading}}.** Kill-switch drills and engagements, then each kill switch engaged in the window: the agent, or **{{ui:agents.reports.killScopeTenant}}**, when it was engaged, the reason given, and **{{ui:agents.reports.killStillInForce}}** where it applies.
- **{{ui:agents.reports.thirdPartyHeading}}.** Each third-party agent with its supplier, linked to the vendor, and the date of the supplier's last completed assessment, or **{{ui:agents.reports.thirdPartyUnassessed}}**. An agent with no supplier is flagged in red.
- **{{ui:agents.reports.workpaperReviewHeading}}.** How often internal audit agreed with the auditor agent's workpapers it re-performed. Only concluded reviews count.

### {{ui:agents.reports.tabHarness}}

A note at the top says the levels are reported, never enforced: an agent below its bar raises a finding and is never stopped by it. Then, in order:

- **{{ui:agents.harness.estates.heading}}.** Each estate is one of your environments that one scanner covers, on a schedule you declare. It reads **{{ui:agents.harness.estates.status.FRESH}}** while its last complete scan is younger than one and a half times that schedule, and **{{ui:agents.harness.estates.status.STALE}}** otherwise. Each source it reads is listed with the member who answers for it.
- **One section per scanner** that reported recently, headed with the scanner's name, whether its latest scan was **{{ui:agents.harness.completeness.COMPLETE}}**, **{{ui:agents.harness.completeness.INCOMPLETE}}** or **{{ui:agents.harness.completeness.EMPTY}}**, and when. A warning names any source the scan could not read in full. Below it, what changed since that scanner's previous scan, then the matrix.
- **The matrix.** One row per agent the scan found, worst first: agents that are not judged, then agents below their bar, then agents at it, and within each the lowest level first. {{ui:agents.harness.colAgent}} gives its name. One that is not in the register is marked **{{ui:agents.harness.shadowBadge}}**, or **{{ui:agents.harness.identityBadge}}** when nothing the scan read suggests it runs an AI model. {{ui:agents.harness.colLevel}} runs from **{{ui:agents.harness.level.H0}}** to **{{ui:agents.harness.level.H5}}**. {{ui:agents.harness.colReach}} is {{ui:agents.harness.reach.READ_ONLY}}, {{ui:agents.harness.reach.WRITE_OR_EXTERNAL}} or {{ui:agents.harness.reach.UNKNOWN}}. A read-only agent is held to H2 and any other to H3, and one below that bar is flagged. An unregistered identity keeps its level and reads **{{ui:agents.harness.identityNoBar}}**: it is never flagged as below one. An agent found through a source the scan did not read in full reads **{{ui:agents.harness.notJudged.badge}}**: no level is stated for it, and the reasons are listed under the badge. {{ui:agents.harness.colModels}} lists the model endpoints the scanner reported, and {{ui:agents.harness.colAcceptance}} the accepted shortfall, if any. One column per criterion follows. A cell reads **{{ui:agents.harness.cell.EVIDENCED}}** only when the scanner reported it met with evidence, and **{{ui:agents.harness.cell.DECLARED}}** when the estate's operator declared it rather than the scan observing it. **{{ui:agents.harness.cell.NOT_READABLE}}** means no source the scan read could answer it. Every other answer, including a claim of met with no evidence and no answer at all, reads as not met and says which.
- **{{ui:agents.harness.acceptancesHeading}}**, each with its level, end date and whether it is still in force.
- **{{ui:agents.harness.shadowHeading}}**, the agents a scan found with no live row in the register.
- **{{ui:agents.harness.identityHeading}}**, the automated accounts a scan found with no live row in the register and no sign that they run an AI model. A service account, a build workflow that holds a key and an application registered in a directory usually land here.
- **{{ui:agents.harness.scansHeading}}**, every recent scan with its scanner, completeness and sources.
- **{{ui:agents.harness.keys.heading}}**, for roles that can manage the register. Only a report signed by a key listed here counts.

Sources on this tab are named as the estate form names them, such as **{{ui:agents.harness.estates.form.kind.entra-sp}}** or **{{ui:agents.harness.estates.form.kind.okta-app}}**.

### {{ui:agents.reports.tabIntegrations}}

A note at the top says the tab is read-only: what the scan raised is in the findings register, and is shown here beside the application it is about. Then one section per scanner that sent a third-party application report, headed with the scanner's name and the date of its report, and whether the scan was **{{ui:agents.harness.completeness.COMPLETE}}**, **{{ui:agents.harness.completeness.INCOMPLETE}}** or **{{ui:agents.harness.completeness.EMPTY}}**.

- **{{ui:agents.reports.integrations.coverageHeading}}.** Each directory the scan read, such as Microsoft Entra, Okta or GitHub, whether it was read in full, and whether sign-in activity was read.
- **The table**, open findings and the highest privilege first:

| Column | What it shows |
| --- | --- |
| {{ui:agents.reports.integrations.colApplication}} | The application's name, or **{{ui:agents.reports.integrations.unnamed}}** |
| {{ui:agents.reports.integrations.colPrivilege}} | **{{ui:agents.reports.integrations.privilege.HIGH}}**, **{{ui:agents.reports.integrations.privilege.NOT_HIGH}}** or **{{ui:agents.reports.integrations.privilege.NOT_CONCLUDED}}**, with what the high-privilege permissions reach, such as mail, files or the directory |
| {{ui:agents.reports.integrations.colPublisher}} | **{{ui:agents.reports.integrations.publisherVerified}}** or **{{ui:agents.reports.integrations.publisherUnverified}}** |
| {{ui:agents.reports.integrations.colOwners}} | How many owners the application has in the directory, or **{{ui:agents.reports.integrations.noOwner}}** |
| {{ui:agents.reports.integrations.colSignIn}} | How long ago it last signed in, or **{{ui:agents.reports.integrations.noSignIn}}** |
| {{ui:agents.reports.integrations.colFindings}} | The open findings about it: **{{ui:agents.reports.integrations.findingCode.INTEGRATION_HIGH_PRIVILEGE_GRANT}}**, **{{ui:agents.reports.integrations.findingCode.INTEGRATION_UNVERIFIED_PUBLISHER}}**, **{{ui:agents.reports.integrations.findingCode.INTEGRATION_NO_OWNER}}** or **{{ui:agents.reports.integrations.findingCode.INTEGRATION_UNUSED}}**, or **{{ui:agents.reports.integrations.noOpenFindings}}** |
| {{ui:agents.reports.integrations.colVendor}} | **{{ui:agents.reports.integrations.aboutLink}}** and **{{ui:agents.reports.integrations.manageLink}}**, each opening the vendor's own site in a new tab |

Where a directory does not report a column, it reads **{{ui:agents.reports.integrations.notExposed}}**. A scan that read every source and found no application is shown as a finding, not as a clean result: a directory in use holds applications. Warnings say when a source was read only in part, when a trusted scanner has sent no such report, and when the page read fewer scans or findings than exist.

### {{ui:agents.reports.tabBehaviour}}

Every day in the last 30 days on which the nightly behaviour fingerprint judged an agent unlike its own usual pattern, newest first. Each entry names the agent, linked to its page, the day and the score, whether the score reached the finding or the latch threshold, and the counts that drove it. Only counts are compared, never content. When the detector is not switched on for the deployment or the workspace, a note says so: an empty list then means nobody looked.

## What you can do

### File the pack as evidence

Click **{{ui:agents.reports.exportAction}}**. The pack is saved as a document in the evidence library, in the Agent governance folder, kept for seven years, and a message confirms it. Nothing is downloaded. When registration is not enforced, the filed document says so at the top.

### Declare an estate

On the harness tab, click **{{ui:agents.harness.estates.declare}}**. Fill in **{{ui:agents.harness.estates.form.nameLabel}}**, choose the **{{ui:agents.harness.estates.form.scannerLabel}}** from the registered agents that cover no other estate, fill in **{{ui:agents.harness.estates.form.cadenceLabel}}**, and add at least one source with its owner, an active member. Click **{{ui:agents.harness.estates.form.submitDeclare}}**. **{{ui:agents.harness.estates.edit}}** changes everything but the scanner; **{{ui:agents.harness.estates.remove}}** takes the estate away after five seconds, during which **{{ui:agents.harness.estates.undo}}** keeps it.

### Register or revoke a scanner key

In **{{ui:agents.harness.keys.heading}}**, click **{{ui:agents.harness.keys.register}}**, choose the registered agent that runs the scanner, paste its public key and click **{{ui:agents.harness.keysModal.submit}}**. To stop trusting a key, click **{{ui:agents.harness.keys.revoke}}** and confirm with **{{ui:agents.harness.keys.revokeConfirm}}**. Reports signed by it are refused from then on, and the same key cannot be registered again.

### Register a shadow agent

In **{{ui:agents.harness.shadowHeading}}**, click **{{ui:agents.harness.register}}** on its row. In **{{ui:agents.harness.registerModal.title}}**, choose the accountable owner yourself and tick the box confirming them; any suggestion shown is never used as the owner. Answer how far the agent reaches, give our role for its AI system, and click **{{ui:agents.harness.registerModal.submit}}**. The agent joins the register as a draft, with an AI-system entry that has no tier. It cannot be activated until that entry is classified.

### Deactivate a third-party application

On **{{ui:agents.reports.tabIntegrations}}**, click **{{ui:agents.reports.integrations.manageLink}}** on the application's row. It opens the application in its vendor's own console, Microsoft Entra, Okta or GitHub, where an administrator removes or disables it. Inflect changes nothing itself; the next scan shows the result. **{{ui:agents.reports.integrations.aboutLink}}** opens the vendor's description of the application.

### Decide what an unregistered identity is

A scan lists an account under **{{ui:agents.harness.identityHeading}}** when it is on no list and the scan saw no sign of an AI model. The signs it goes by are these: the account was found in agent code, in a tracing system or on a tool server, or its report lists a tool or a model. The name of a key is not a sign. The scan cannot show that the account runs no model; it only saw no sign of one.

- **If it is an agent**, click **{{ui:agents.harness.register}}** on its row. The dialog is the one a shadow agent gets, headed **{{ui:agents.harness.registerModal.identityTitle}}**. Once registered it is treated as an agent and held to the bar from the next scan.
- **If it is ordinary automation**, do not register it here. Make sure it has an owner on record where your organisation keeps such accounts.
- **If nobody claims it**, disable it in the system it lives in, wait, and then remove it. The product does not do this for you.

An unregistered identity has one finding of medium severity. It has no shortfall finding and cannot have a shortfall accepted, because it is held to no bar.

### Accept a shortfall

When you own an agent that is below its bar, its row offers **{{ui:agents.harness.accept}}**, or **{{ui:agents.harness.renew}}** while an acceptance is in force. Write why the workspace carries the risk, choose the last day it holds, at most a year ahead, and save. Anyone else sees a note that only the agent's owner can accept.

## What happens next

- A filed pack is an ordinary evidence item, and its filing is recorded in the workspace's audit log.
- An accepted shortfall closes the shortfall finding. When the acceptance lapses, the finding reopens if the agent is still below its bar.
- A registered shadow agent leaves the shadow list at the next scan that sees it, and its finding closes at the next complete scan. A registered identity leaves its list the same way.
- An unregistered identity that a later scan sees a sign of a model for moves to the shadow list, and is held to the bar. It moves back only when a complete scan sees no sign: a scan that could not read every source moves nothing.
- An estate with no complete scan for too long turns **{{ui:agents.harness.estates.status.STALE}}**, and a daily check raises a finding for it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.register.accessTitle}}** | Your role cannot read the agent register | Ask an Owner or Admin |
| **{{ui:agents.reports.emptyTitle}}** | No agent is registered, so there is nothing to report | Register agents on the {{ui:agents.register.title}} |
| **{{ui:agents.harness.noScansTitle}}** | No scanner has sent a report, so nothing has looked for agents outside the register | Register a scanner key and run a scanner |
| **{{ui:agents.harness.emptyScanTitle}}** | A scan found nothing, which proves nothing | Check what the scanner reads |
| **{{ui:agents.harness.estates.none}}** | No estate is declared | Declare one per scanner |
| **{{ui:agents.reports.integrations.noScansTitle}}** | No scanner has sent a third-party application report | Have a trusted scanner send one |
| **{{ui:agents.reports.exportFailed}}** | The pack was not filed | Try again |
| **{{ui:agents.harness.acceptModal.failed}}**, **{{ui:agents.harness.registerModal.failed}}**, **{{ui:agents.harness.keysModal.failed}}** or **{{ui:agents.harness.estates.form.failed}}** | The change did not go through. A reason from the server is shown when there is one | Correct it and try again |

## Related

- [{{ui:agents.register.title}}](agents.md), for the agents these reports describe.
- [{{ui:agents.proposals.title}}](agent-proposals.md), whose decisions the approvals report measures.
- [{{ui:agents.runs.title}}](agent-runs.md), for what agents have done.
