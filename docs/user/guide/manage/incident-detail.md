---
route: /t/[tenantSlug]/incidents/[incidentId]
---

# An incident

An incident's page is where you run the response to one security incident: move it through its phases, work its containment checklist, meet the NIS2 Article 23 reporting deadlines, and record what happened and what proves it.

## Where to find it

Open the incidents list, from the **{{ui:audits.nav.incidents}}** link in the header of the **{{ui:nav.audits}}** page, and click an incident. The breadcrumb ends **{{ui:incidents.crumb.incidents}}** › the incident's reference. Arrows beside the title step to the previous or next incident in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the incident, its deadlines, timeline, controls and tasks | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Advance the phase, tick runbook steps, mark it reportable, file a notification | Owner, Admin, Editor |
| Add timeline entries, link or unlink evidence, create tasks | Owner, Admin, Editor |

## What it is for

Make sure nothing is missed under pressure: who does what, which containment steps are done, when each report to the authority is due, and a record of every action that an authority or auditor can later follow.

## What you see

**The header.** The incident's reference and title, with its **{{ui:incidents.detail.meta.severity}}**, **{{ui:incidents.detail.meta.type}}**, **{{ui:incidents.detail.meta.phase}}** and when it was **{{ui:incidents.detail.meta.detected}}**.

A notice reminds you: **{{ui:incidents.detail.notLegalStrong}}** {{ui:incidents.detail.notLegalBody}}

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:incidents.detail.tabs.overview}}** | The response phase, the containment runbook, the reporting deadlines, forensic evidence and the response roles |
| **{{ui:incidents.detail.tabs.timeline}}** | **{{ui:incidents.detail.timelineHeading}}**, every action and observation recorded |
| **{{ui:incidents.detail.tabs.controls}}** | **{{ui:incidents.detail.linkedControls}}**: the NIS2 security measures the incident touches |
| **{{ui:incidents.detail.tabs.tasks}}** | The tasks linked to the incident |

**The overview.**

- **{{ui:incidents.detail.responsePhase}}**: the incident's place in a seven-phase response, from detection to lessons learned.
- **{{ui:incidents.detail.containmentRunbook}}**: a checklist for the incident's type, such as ransomware, with each step **{{ui:incidents.detail.stepDone}}** or **{{ui:incidents.detail.stepNotDone}}**.
- **{{ui:incidents.detail.deadlinesHeading}}**: once the incident is reportable, the **{{ui:incidents.detail.kinds.EARLY_WARNING_24H}}**, the **{{ui:incidents.detail.kinds.DETAILED_72H}}** and the **{{ui:incidents.detail.kinds.FINAL_1MONTH}}**, each with its due time and status: **{{ui:incidents.deadlineStatus.PENDING}}**, **{{ui:incidents.deadlineStatus.DUE}}**, **{{ui:incidents.deadlineStatus.OVERDUE}}**, **{{ui:incidents.deadlineStatus.SUBMITTED}}** or **{{ui:incidents.deadlineStatus.NOT_REQUIRED}}**.
- **{{ui:incidents.detail.authorityHeading}}**: {{ui:incidents.detail.authorityText}}
- **{{ui:incidents.detail.forensicHeading}}**: the kinds of evidence to capture, each with the evidence records linked to it.
- **{{ui:incidents.detail.rolesHeading}}**: who is accountable, responsible and consulted during the response.

## What you can do

### Move the response on

Click **{{ui:incidents.detail.advancePhase}}** when the current phase is complete. Tick each runbook step as it is done.

### Decide the incident is reportable

Click **{{ui:incidents.detail.markReportable}}** and confirm. {{ui:incidents.detail.markReportableDesc}} The 24-hour, 72-hour and one-month deadlines start from that moment.

### Record a report you filed

When you have sent a report to the authority, click **{{ui:incidents.detail.submit}}** beside that deadline. Paste the **{{ui:incidents.detail.reportText}}**, add the **{{ui:incidents.detail.caseRef}}** if the authority gave one, and click **{{ui:incidents.detail.submitReport}}**. The deadline shows as **{{ui:incidents.deadlineStatus.SUBMITTED}}**.

The app does not send the report for you. It keeps the record that you did.

### Link forensic evidence

Click **{{ui:incidents.detail.linkEvidence}}**, choose an **{{ui:incidents.detail.evidenceRecord}}** from the workspace's evidence and the **{{ui:incidents.detail.forensicCategory}}** it satisfies. **{{ui:incidents.detail.unlink}}** removes the link and leaves the evidence in place.

### Keep the timeline

On **{{ui:incidents.detail.tabs.timeline}}**, click **{{ui:incidents.detail.addEntry}}** and describe what happened. The page offers no way to edit or delete an entry, so the timeline stands as a record.

## What happens next

- Reporting deadlines appear on the compliance calendar, and turn **{{ui:incidents.deadlineStatus.DUE}}** and then **{{ui:incidents.deadlineStatus.OVERDUE}}** as they approach and pass.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:incidents.detail.loadFailed}}** | The incident could not load, or does not exist in this workspace | Reload the page, or go back to the list |
| {{ui:incidents.detail.notReportableText}} | The incident has not been marked reportable, so no deadlines are running | Decide whether it is, and click **{{ui:incidents.detail.markReportable}}** if so |
| **{{ui:incidents.detail.noneLinked}}** beside an evidence category | No evidence has been linked for it yet | Link evidence |
| **{{ui:incidents.detail.controlsEmpty}}** | No control is linked | Link the controls from the control's page |
| **{{ui:incidents.detail.refused.INCIDENT_PHASE_FINAL}}** | The incident has reached its last phase | Nothing more to advance |
| **{{ui:incidents.detail.refused.INCIDENT_NOT_REPORTABLE}}** | You tried to file a report before marking the incident reportable | Click **{{ui:incidents.detail.markReportable}}** first |
| **{{ui:incidents.detail.refused.INCIDENT_EVIDENCE_NOT_FOUND}}** | The evidence record you chose was deleted | Choose another record |
| **{{ui:incidents.detail.actionFailed}}**, or another sentence in red | The action was refused | Follow what the sentence says, then try again |

## Related

- [{{ui:incidents.title}}](incidents.md), every incident in the workspace.
- [Evidence](../comply/evidence.md), where forensic evidence is stored.
