---
route: /t/[tenantSlug]/incidents
---

# {{ui:incidents.title}}

The {{ui:incidents.title}} page is the workspace's register of live security incidents, kept for the incident reporting duties of NIS2 Article 23. It lists each incident with its severity, its response phase and its next open notification deadline, and it is where Owners and Admins open a new incident.

## Where to find it

The page is not in the sidebar. Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar. In the header of the {{ui:audits.title}} page, among the links marked **{{ui:audits.hub.related}}**, click **{{ui:audits.nav.incidents}}**.

The breadcrumb reads **{{ui:incidents.crumb.dashboard}}** › **{{ui:incidents.crumb.internalAudits}}** › **{{ui:incidents.crumb.incidents}}**, and a back link above the title returns you to the page you came from. A deadline notification opens the incident it is about directly, and so does a deadline's entry on the {{ui:calendar.title}}, which you open from **{{ui:nav.calendar}}** in the sidebar.

## Who can use it

| Action | Roles |
| --- | --- |
| View the register and open any incident | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Open a new incident | Owner, Admin |
| Work on an incident on its own page: advance its phase, tick off containment steps, mark it reportable, file reports, add timeline entries and link evidence | Owner, Admin |

Editors, Readers, Auditors and AI admins see the register without the **{{ui:incidents.addBtn}}** button. On an incident's own page, every role sees the buttons for changing it, but only Owners and Admins can use them. For anyone else they fail with **{{ui:incidents.detail.actionFailed}}**.

If your workspace uses custom roles, the **{{ui:incidents.addBtn}}** button and every change follow your role's permission to manage incidents.

## What it is for

Use the register while an incident is live and afterwards, as its record. It holds when each incident was detected, which phase of the response it is in, and the deadlines for the reports NIS2 Article 23 sets once an incident is marked reportable: a 24-hour early warning, a 72-hour detailed report and a final report within a month.

The page itself says that its reporting thresholds and deadlines are operational aids, not legal advice, and that deciding whether an incident must be reported is for your data protection officer or legal team.

## What you see

**The header.** The page title, the line that explains the page, and **{{ui:incidents.addBtn}}** for Owners and Admins.

**Summary cards.** Three cards sit above the table. They count every incident the page has loaded, whatever the search and filters, and clicking them does nothing.

| Card | What it counts |
| --- | --- |
| {{ui:incidents.kpi.open}} | Incidents in any phase except {{ui:incidents.filterEnums.phase.closed}} |
| {{ui:incidents.kpi.reportable}} | Incidents marked reportable |
| {{ui:incidents.kpi.deadlines}} | Incidents with at least one notification deadline that is due soon or overdue. The card turns red when this is above zero |

**Search and filters.** The **{{ui:common.ui.filter}}** button holds them. Its search box, **{{ui:incidents.searchPlaceholder}}**, filters the table as you type and matches an incident's reference and title. The filters are {{ui:incidents.filters.severity}} and {{ui:incidents.filters.phase}}, where you can pick several values, and {{ui:incidents.filters.reportable}}, which is {{ui:incidents.filterEnums.reportable.yes}} or {{ui:incidents.filterEnums.reportable.no}}. Filters and the search are kept in the page address.

**The table.** The most recently detected incidents come first. Click a row to open the incident's own page.

| Column | What it shows |
| --- | --- |
| {{ui:incidents.colHeaders.reference}} | The incident's reference, such as INC-2026-004: the year it was detected, then its number within that year |
| {{ui:incidents.colHeaders.title}} | The incident's title |
| {{ui:incidents.colHeaders.severity}} | {{ui:incidents.filterEnums.severity.low}}, {{ui:incidents.filterEnums.severity.medium}}, {{ui:incidents.filterEnums.severity.high}} or {{ui:incidents.filterEnums.severity.critical}} |
| {{ui:incidents.colHeaders.phase}} | Where the response has got to, as described below |
| {{ui:incidents.colHeaders.nextDeadline}} | The earliest notification deadline that is still open, as 24h, 72h or 1mo with its date. A dash means there is none: the incident is not marked reportable, or every report has been filed |
| {{ui:incidents.colHeaders.owner}} | **{{ui:incidents.assigned}}** when the incident has an incident commander, or a dash. Open the incident to see who it is |

The deadline badge's colour gives its state. Grey means pending, amber means due soon and red means overdue; the badge has no text that says so. A 24-hour deadline turns amber 6 hours before it falls due, a 72-hour deadline 18 hours before, and a one-month deadline 3 days before. The states are updated every hour.

The phases run in this order: {{ui:incidents.filterEnums.phase.detection}}, {{ui:incidents.filterEnums.phase.classification}}, {{ui:incidents.filterEnums.phase.earlyWarning}}, {{ui:incidents.filterEnums.phase.containment}}, {{ui:incidents.filterEnums.phase.investigation}}, {{ui:incidents.filterEnums.phase.detailedReport}}, {{ui:incidents.filterEnums.phase.recovery}} and {{ui:incidents.filterEnums.phase.closed}}.

The page loads the 200 most recently detected incidents. Older ones are not listed, and the page does not say when some are left out.

**An incident's own page.** Its tabs are {{ui:incidents.detail.tabs.overview}}, {{ui:incidents.detail.tabs.timeline}}, {{ui:incidents.detail.tabs.controls}} and {{ui:incidents.detail.tabs.tasks}}. It holds the phase tracker, the Article 23 deadlines and the button that marks the incident reportable, the forms for filing each report, a containment runbook for the incident's type and the forensic evidence checklist.

## What you can do

### Open an incident

Click **{{ui:incidents.addBtn}}**. The **{{ui:incidents.new.title}}** dialog has these fields:

- **{{ui:incidents.new.fields.title}}**, the only required field, up to 300 characters.
- **{{ui:incidents.new.fields.description}}**: what happened, what is affected and what is known so far.
- **{{ui:incidents.new.fields.severity}}**, starting on {{ui:incidents.filterEnums.severity.medium}}.
- **{{ui:incidents.new.fields.type}}**: {{ui:incidents.filterEnums.type.ransomware}}, {{ui:incidents.filterEnums.type.dataBreach}}, {{ui:incidents.filterEnums.type.ddos}}, {{ui:incidents.filterEnums.type.unauthorizedAccess}} or {{ui:incidents.filterEnums.type.other}}, starting on {{ui:incidents.filterEnums.type.other}}. The containment runbook on the incident's page follows this choice.
- **{{ui:incidents.new.fields.detectedAt}}**, under which the hint reads **{{ui:incidents.new.detectedHint}}**
- **{{ui:incidents.new.fields.commander}}**, a member of the workspace. Optional.

{{ui:incidents.new.fields.detectedAt}} starts at the moment you opened the dialog. The picker chooses a day, not a time. If you pick a day, today included, the detection time is recorded as midnight UTC at the start of that day, and every deadline is counted from then. To keep the time the dialog started with, leave the field as it is.

Click **{{ui:incidents.new.create}}**. It stays greyed out until the title is filled in. The dialog closes and the new incident's page opens.

## What happens next

- The incident gets the next reference for the year it was detected and starts in the {{ui:incidents.filterEnums.phase.detection}} phase. Its timeline records that it was opened, with its severity and type, and the workspace's audit log records who opened it.
- Opening an incident starts no deadlines and notifies nobody, the incident commander included.
- The deadlines start when an Owner or Admin marks the incident reportable on its page, which the page describes as a human determination rather than an automatic one. That creates the 24-hour, 72-hour and one-month deadlines, counted from the detection time. Marking it not reportable again stops them.
- Each time a deadline becomes due soon or overdue, the incident commander and every active Owner and Admin get an in-app notification that opens the incident.
- Filing a report on the incident's page closes that deadline, and the {{ui:incidents.colHeaders.nextDeadline}} column moves on to the next open one.
- Incidents are not deleted from this page or the incident's page. A closed incident stays in the register in the {{ui:incidents.filterEnums.phase.closed}} phase.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:incidents.emptyTitle}}** with no search or filter set | The workspace has no incidents | Click **{{ui:incidents.addBtn}}** when one is detected. Roles that cannot open incidents see no button |
| **{{ui:incidents.emptyTitle}}** with a search or filter set | No incident matches the search and filters. The page shows the same message as for an empty register | Clear the search and the filters |
| **{{ui:incidents.new.createFailed}}** in the dialog | The incident was not opened. The dialog shows this message whatever the reason, such as a title over 300 characters | Check the fields and try again |
| No **{{ui:incidents.addBtn}}** button | Your role cannot open incidents | Ask an Owner or Admin |

## Related

- [{{ui:controls.list.pageTitle}}](../govern/controls.md), for the controls an incident's {{ui:incidents.detail.tabs.controls}} tab links to.
- [{{ui:evidence.title}}](../comply/evidence.md), which holds the evidence records an incident links as forensic evidence.
- [{{ui:tasks.list.srTitle}}](../comply/tasks.md), for the follow-up work on an incident.
