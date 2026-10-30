---
route: /t/[tenantSlug]/security-testing
---

# {{ui:securityTesting.title}}

The {{ui:securityTesting.title}} page shows what your automated security scanners found: code scanners, container and infrastructure scanners, secret scanners. Each finding is mapped to the security standards it touches, and a passing scan can serve as evidence for a control.

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar, then click **{{ui:audits.nav.scans}}** in the header. The page's back link returns you to the audits page.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, its findings and its scan history | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Upload a scan | Owner, Admin, Editor |
| Change a finding's status | Owner, Admin, Editor |

**{{ui:securityTesting.uploadScan}}** and the status lists appear only for Owners, Admins and Editors. Everyone else sees each finding's status as a label.

If your workspace uses custom roles, these changes follow the built-in role your custom role is based on.

## What it is for

Use the page to see what your scanners report, sort real problems from noise, and give your auditors a record that the code and infrastructure are scanned. Scans usually arrive from your build pipeline on every run; you can also upload a scan file by hand.

## What you see

**The header.** The title, then a line counting the recent scan runs and the open critical findings. Before any scan arrives, it reads **{{ui:securityTesting.descEmpty}}** On the right, **{{ui:securityTesting.viewAllVulnerabilities}}** opens the vulnerabilities register, and, for Owners, Admins and Editors, **{{ui:securityTesting.uploadScan}}**.

**The filter.** Filter the findings by:

| Filter | Options |
| --- | --- |
| {{ui:securityTesting.filters.source}} | The scanner: {{ui:securityTesting.filterEnums.source.SEMGREP}}, {{ui:securityTesting.filterEnums.source.TRIVY}}, {{ui:securityTesting.filterEnums.source.ZAP}}, {{ui:securityTesting.filterEnums.source.GITLEAKS}}, {{ui:securityTesting.filterEnums.source.CHECKOV}}, {{ui:securityTesting.filterEnums.source.CODEQL}} or {{ui:securityTesting.filterEnums.source.OTHER}} |
| {{ui:securityTesting.filters.severity}} | {{ui:securityTesting.filterEnums.severity.CRITICAL}}, {{ui:securityTesting.filterEnums.severity.HIGH}}, {{ui:securityTesting.filterEnums.severity.MEDIUM}}, {{ui:securityTesting.filterEnums.severity.LOW}} |
| {{ui:securityTesting.filters.status}} | {{ui:securityTesting.filterEnums.status.OPEN}}, {{ui:securityTesting.filterEnums.status.TRIAGED}}, {{ui:securityTesting.filterEnums.status.FIXED}}, {{ui:securityTesting.filterEnums.status.FALSE_POSITIVE}}, {{ui:securityTesting.filterEnums.status.ACCEPTED}} |

**The findings.** One row per finding the scanners reported, up to 500:

| Column | What it shows |
| --- | --- |
| {{ui:securityTesting.colSeverity}} | How serious the finding is, as the scanner's level in capitals, such as CRITICAL or HIGH |
| {{ui:securityTesting.colFinding}} | The finding's title, with the scanner's rule under it |
| {{ui:securityTesting.colSource}} | The scanner and the kind of scan |
| {{ui:securityTesting.colLocation}} | Where it was found, such as a file and line |
| {{ui:securityTesting.colMapsTo}} | The OWASP Top 10 categories and NIST secure software development practices the weakness falls under, when the scanner names one |
| {{ui:securityTesting.colStatus}} | The finding's status. Owners, Admins and Editors get a list to change it |

The same finding reported again by a later scan is kept as one row, not repeated.

**{{ui:securityTesting.runsHistoryTitle}}.** Below the findings, the 50 most recent scan runs:

| Column | What it shows |
| --- | --- |
| {{ui:securityTesting.colOutcome}} | PASS, FAIL or ERROR. A scan fails when it reported a finding of high severity or above, unless the pipeline said otherwise |
| {{ui:securityTesting.colSourceScan}} | The scanner and the kind of scan |
| {{ui:securityTesting.colRepo}} | The code repository or branch scanned, when the pipeline named one |
| {{ui:securityTesting.colRan}} | When the scan arrived |
| {{ui:securityTesting.colVia}} | API for a scan sent by your pipeline, UPLOAD for one uploaded on this page |
| {{ui:securityTesting.colFindings}} | How many findings the scan reported |

## What you can do

### Upload a scan

Click **{{ui:securityTesting.uploadScan}}** and choose a scan report in the SARIF format, a `.sarif` or `.json` file most scanners can produce. A message confirms the scan was taken in and says how many findings it held, and the list refreshes with them.

### Triage a finding

Choose a status in the finding's status list:

| Status | Use it when |
| --- | --- |
| {{ui:securityTesting.filterEnums.status.OPEN}} | Nobody has looked at it yet. Every new finding starts here |
| {{ui:securityTesting.filterEnums.status.TRIAGED}} | Someone has looked and it is being dealt with |
| {{ui:securityTesting.filterEnums.status.FIXED}} | The problem has been fixed |
| {{ui:securityTesting.filterEnums.status.FALSE_POSITIVE}} | The scanner was wrong |
| {{ui:securityTesting.filterEnums.status.ACCEPTED}} | The risk is accepted and will not be fixed |

The change shows at once. If it is refused, the old status comes back and a message says the finding could not be updated.

## What happens next

- Each high or critical finding in a scan also becomes a finding in the [{{ui:findings.title}}](findings.md), where its remediation is tracked. A scan that reports it again does not raise it twice.
- A passing scan from a scanner your workspace has linked to a control adds automated evidence to that control, kept as one record that each passing scan updates.
- Status changes are recorded in the workspace's audit log, naming who made them.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:securityTesting.emptyTitle}}** | No scan has arrived yet. The message gives the address your pipeline sends scans to | Ask whoever runs your build pipeline to send its scan reports, or upload one |
| **{{ui:securityTesting.emptyMatchTitle}}** | No finding matches the filter | {{ui:securityTesting.emptyMatchDesc}} |
| **{{ui:securityTesting.runsEmptyTitle}}** | No scan has arrived yet | {{ui:securityTesting.runsEmptyDesc}} |
| **{{ui:securityTesting.uploadParseError}}** | The file you chose could not be read | Choose the scanner's SARIF output file |
| **{{ui:securityTesting.uploadError}}** | The scan was not taken in. The file may not be a valid SARIF report, or your role may not upload | Check the file and your role, then try again |
| **{{ui:securityTesting.updateFailed}}** | The status was not changed | Try again |

## Related

- [{{ui:findings.title}}](findings.md), where scan findings are worked to a close.
- [{{ui:audits.title}}](audits.md), the page that links here.
- [{{ui:vulnerabilities.title}}](../govern/vulnerabilities.md), for vulnerabilities found on your assets.
