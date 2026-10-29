---
route: /t/[tenantSlug]/vulnerabilities
---

# {{ui:vulnerabilities.title}}

The {{ui:vulnerabilities.title}} page lists the published security flaws, known as CVEs, that match the workspace's assets. Owners, Admins and Editors triage them here: they set a status, an owner, a due date and a note, create a remediation task, and turn a vulnerability into a risk or a finding.

## Where to find it

The page is not in the sidebar. Open it from any of these:

- The {{ui:assets.title}}: **{{ui:common.ui.viewsMenu}}** › **{{ui:assets.viewVulnerabilities}}**.
- The {{ui:risks.title}}: **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewsTools}}** › **{{ui:risks.viewVulnerabilities}}**.
- The {{ui:securityTesting.title}} page: **{{ui:securityTesting.viewAllVulnerabilities}}** in its header.
- An asset's own page: its **{{ui:assets.detail.tabs.vulnerabilities}}** tab, then **{{ui:assets.detail.vuln.seeAll}}**. This opens the page showing that asset's vulnerabilities only. Nothing on the page says so, and clearing the filters does not widen it; open the page from the {{ui:assets.title}} or the {{ui:risks.title}} to see every asset.

The breadcrumb reads **{{ui:vulnerabilities.crumbDashboard}}** › **{{ui:vulnerabilities.crumbRisk}}** › **{{ui:vulnerabilities.crumbTitle}}**, and a back link above the title returns you to the page you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the list and the CVE sync status | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Change a vulnerability's status, owner, due date or note | Owner, Admin, Editor |
| Create a remediation task, and turn a vulnerability into a risk or a finding | Owner, Admin, Editor |
| Link a CVE to an asset by hand | Owner, Admin, Editor |

Readers, Auditors and AI admins see every value as plain text, with no buttons.

If your workspace uses custom roles, the page follows the built-in role your custom role is based on. Creating a remediation task also needs your custom role's permission to create and to edit tasks.

## What it is for

Use the page to see which known vulnerabilities affect what you run, and to make sure each is dealt with: fixed, accepted or dismissed as a false positive. Turning one into a risk or a finding brings it into the rest of your compliance work, so it is assessed, owned and tracked alongside everything else.

Inflect matches CVEs to an asset automatically when the asset carries product identity: a {{ui:assets.form.cpe}} value, or a {{ui:assets.form.vendor}} and a {{ui:assets.form.product}}, set under {{ui:assets.form.identityHeading}} on the asset. The match compares vendor and product only. The asset's {{ui:assets.form.version}} is not compared, so a CVE that affects only other versions of the product still matches; mark it {{ui:vulnerabilities.filterEnums.status.FALSE_POSITIVE}}.

## What you see

**The header.** The page title, the line {{ui:vulnerabilities.description}} Beside it, the CVE sync status: **{{ui:vulnerabilities.cveSyncLabel}}** with **{{ui:vulnerabilities.cveSyncOn}}** or **{{ui:vulnerabilities.cveSyncDisabled}}**. When it is on, the date shown is that of the newest CVE record in Inflect's catalogue, not the time the sync last ran. Owners, Admins and Editors also get **{{ui:vulnerabilities.linkCve}}**.

**Filters.** The **{{ui:common.ui.filter}}** button offers {{ui:vulnerabilities.filters.status}} and {{ui:vulnerabilities.filters.severity}}, and you can pick several values in each. The page has no search box. Filters are kept in the page address.

**The table.** Vulnerabilities are listed from the highest CVSS score down. CVEs that carry no score come before all the others.

| Column | What it shows |
| --- | --- |
| {{ui:vulnerabilities.colCve}} | The CVE's identifier, such as CVE-2024-12345. It opens the CVE's first published reference, or its entry in the US National Vulnerability Database, in a new tab |
| {{ui:vulnerabilities.colAsset}} | The asset's code and name |
| {{ui:vulnerabilities.colSeverity}} | The CVE's published severity, shown in capitals as CRITICAL, HIGH, MEDIUM or LOW, or a dash |
| {{ui:vulnerabilities.colCvss}} | The CVE's CVSS score, from 0.0 to 10.0, or a dash |
| {{ui:vulnerabilities.colMatched}} | How the CVE was matched: CPE for an automatic match on product identity, MANUAL for a CVE linked by hand |
| {{ui:vulnerabilities.colStatus}} | {{ui:vulnerabilities.filterEnums.status.OPEN}}, {{ui:vulnerabilities.filterEnums.status.MITIGATING}}, {{ui:vulnerabilities.filterEnums.status.MITIGATED}}, {{ui:vulnerabilities.filterEnums.status.ACCEPTED}} or {{ui:vulnerabilities.filterEnums.status.FALSE_POSITIVE}} |
| {{ui:vulnerabilities.colOwner}} | The member responsible for it, or {{ui:vulnerabilities.unassigned}} |
| {{ui:vulnerabilities.colDue}} | The date it should be remediated by |
| {{ui:vulnerabilities.colRemediation}} | The remediation task's key, linked to the task, or **{{ui:vulnerabilities.createTask}}** |
| {{ui:vulnerabilities.colNote}} | A note on the vulnerability |
| The last column | **{{ui:vulnerabilities.toRisk}}** and **{{ui:vulnerabilities.toFinding}}**, for Owners, Admins and Editors |

The page shows at most 500 vulnerabilities and does not say when there are more. A vulnerability has no page of its own; the asset it sits on is reached from the {{ui:assets.title}}. Vulnerabilities on an asset that has been deleted stay in the list.

## What you can do

### Triage a vulnerability

Each change saves as soon as you make it.

- **Status.** Choose another status from the list in the {{ui:vulnerabilities.colStatus}} column.
- **Owner.** Choose a member, starting from **{{ui:vulnerabilities.assignOwner}}**. To unassign them, click the selected member again.
- **Due date.** Click **{{ui:vulnerabilities.setDue}}** and pick a day. Clear the date to remove it.
- **Note.** Click **{{ui:vulnerabilities.addNote}}**, or the note itself. Type, then press Enter or click elsewhere to save. Press Escape to leave the note as it was.

If a change does not save, the message **{{ui:vulnerabilities.updateFailed}}** appears and the row goes back to what is saved.

### Create a remediation task

Click **{{ui:vulnerabilities.createTask}}**. Inflect creates a task named after the CVE and the asset, with the CVE's summary as its description, and links it to the asset. It has no assignee or due date; set them on the task. The message reads **{{ui:vulnerabilities.taskCreated}}**, and the {{ui:vulnerabilities.colRemediation}} column then shows the task's key. A vulnerability has one remediation task at most.

### Turn a vulnerability into a risk or a finding

- **{{ui:vulnerabilities.toRisk}}** adds a risk to the {{ui:risks.title}}, named after the CVE and the asset, in the category Vulnerability, with the CVE's summary as its description and the asset linked. Its starting likelihood and impact follow the CVE's severity: 4 and 5 for critical, 3 and 4 for high, 3 and 3 for medium, and 2 and 2 otherwise. The message reads **{{ui:vulnerabilities.riskCreated}}**.
- **{{ui:vulnerabilities.toFinding}}** adds a {{ui:findings.nonconformity}} to the {{ui:findings.title}}, with the CVE's severity, or medium when it has none, and the asset linked. For a high or critical CVE the message reads **{{ui:vulnerabilities.elevateNudge}}** and offers **{{ui:vulnerabilities.elevateAction}}**. Otherwise it reads **{{ui:vulnerabilities.findingCreated}}**.

The row does not change afterwards, and both buttons stay. Each click creates another risk or finding, so check the {{ui:risks.title}} or the {{ui:findings.title}} before converting a vulnerability a second time.

### Link a CVE to an asset by hand

Click **{{ui:vulnerabilities.linkCve}}**. In the **{{ui:vulnerabilities.linkCveHeader}}** dialog, choose the **{{ui:vulnerabilities.linkCveAsset}}**, type the **{{ui:vulnerabilities.linkCveId}}** exactly as it is published, in capitals, and add a **{{ui:vulnerabilities.linkCveNote}}** if you want. Click **{{ui:vulnerabilities.linkCveSubmit}}**.

The CVE must already be in Inflect's catalogue, which the CVE sync fills. A CVE linked by hand starts as {{ui:vulnerabilities.filterEnums.status.OPEN}}. Linking a CVE that is already on that asset adds nothing new; a note you typed replaces the existing one.

## What happens next

- Every link, change of status, owner, due date or note, task created and conversion is recorded in the workspace's audit log, naming who made it.
- When the CVE sync is on, it runs every night. New matches appear in the list as {{ui:vulnerabilities.filterEnums.status.OPEN}}.
- When the remediation task is moved to {{ui:tasks.statusLabels.RESOLVED}} or {{ui:tasks.statusLabels.CLOSED}}, a vulnerability that is {{ui:vulnerabilities.filterEnums.status.OPEN}} or {{ui:vulnerabilities.filterEnums.status.MITIGATING}} moves to {{ui:vulnerabilities.filterEnums.status.MITIGATED}}. A {{ui:tasks.statusLabels.CANCELED}} task leaves it as it is.
- A risk or finding you create is a record of its own. Changing the vulnerability afterwards does not change it, and closing the risk or finding does not change the vulnerability.
- Assigning an owner here sends them no notification.
- A due date puts the vulnerability on the {{ui:calendar.title}}, and its entry opens the asset's page. The calendar counts it as done only once it is {{ui:vulnerabilities.filterEnums.status.ACCEPTED}}; a {{ui:vulnerabilities.filterEnums.status.MITIGATED}} or {{ui:vulnerabilities.filterEnums.status.FALSE_POSITIVE}} vulnerability still shows there as open, and as overdue once the date has passed.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:vulnerabilities.emptyFilteredTitle}}** | Vulnerabilities exist, but none match the filters | Clear a filter |
| **{{ui:vulnerabilities.emptyDisabledTitle}}** | The CVE sync is turned off for your whole Inflect deployment, so nothing is matched. The message mentions a setting; it is not one any workspace role can change | Ask whoever runs your Inflect deployment. You can still link CVEs that are already in the catalogue |
| **{{ui:vulnerabilities.emptyNoIdentityTitle}}** | No asset carries a CPE, a vendor or a product | Click **{{ui:vulnerabilities.emptyNoIdentityAction}}** and add product identity to your assets |
| **{{ui:vulnerabilities.emptyCleanTitle}}** | No CVE in the catalogue matches your assets. When you opened the page from one asset, it means that asset has none | Nothing to do |
| **{{ui:vulnerabilities.updateFailed}}**, **{{ui:vulnerabilities.taskCreateFailed}}**, or a message that the vulnerability could not be converted | The change did not go through. The message does not say why | Reload the page and try again |
| **CVE not found in catalog** in the link dialog | The CVE is not in Inflect's catalogue, or its identifier is mistyped | Check the identifier, including its capitals |
| **{{ui:vulnerabilities.linkCveFailed}}** | The CVE was not linked | Try again |

## Related

- [{{ui:assets.title}}](assets.md), where product identity is set so that CVEs can match.
- [{{ui:risks.title}}](risks.md), for the risks you create from vulnerabilities.
- [{{ui:tasks.list.srTitle}}](../comply/tasks.md), for the remediation tasks.
