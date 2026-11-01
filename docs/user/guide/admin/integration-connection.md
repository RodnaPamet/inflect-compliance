---
route: /t/[tenantSlug]/admin/integrations/[connectionId]
---

# {{ui:admin.integrations.outcome.title}}

A connection's own page shows what one integration connection has done: every check it has run, with its result, and a **{{ui:admin.integrations.syncNow}}** button to run it again. A legacy application connection also gets its column mapping and its account reads here, and an external tool server gets its accountable owner and its integration passport.

## Where to find it

On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.integrations.viewOutcomes}}** on the connection's row. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}** › the connection's name, and its steps go back.

The title is the connection's name. Under it, a line names the kind of system and says whether the connection is switched on.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see the check runs | Owner, Admin |
| Click **{{ui:admin.integrations.syncNow}}** | Owner, Admin |
| Map a legacy application's columns, read its accounts and match them to people | Owner, Admin |
| Name an external tool server's accountable owner | Owner, Admin |
| See an external tool server's integration passport | Owner |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. A card your role cannot use is not shown at all.

## What you see

**{{ui:admin.integrations.outcome.checkRuns}}.** One row per run of a check on this connection, newest first:

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.outcome.colCheck}} | The check that ran, in words, such as **{{ui:admin.integrations.outcome.runLabels.sync}}** or **{{ui:admin.integrations.outcome.runLabels.leaver_pass}}** |
| {{ui:admin.integrations.colStatus}} | How it ended: **{{ui:admin.integrations.outcome.statusLabels.PASSED}}**, **{{ui:admin.integrations.outcome.statusLabels.FAILED}}**, **{{ui:admin.integrations.outcome.statusLabels.ERROR}}**, **{{ui:admin.integrations.outcome.statusLabels.PARTIAL}}** (the read stopped early and continues next time), **{{ui:admin.integrations.outcome.statusLabels.RUNNING}}**, **{{ui:admin.integrations.outcome.statusLabels.PENDING}}** or **{{ui:admin.integrations.outcome.statusLabels.NOT_APPLICABLE}}** |
| {{ui:admin.integrations.outcome.colTrigger}} | What started it: **{{ui:admin.integrations.outcome.triggerLabels.manual}}**, **{{ui:admin.integrations.outcome.triggerLabels.scheduled}}** or **{{ui:admin.integrations.outcome.triggerLabels.webhook}}** |
| {{ui:admin.integrations.outcome.colRan}} | When it finished, or when it started if it has not finished |
| {{ui:admin.integrations.outcome.colControl}} | **{{ui:admin.integrations.outcome.viewControl}}** when the check is wired to a control, or **{{ui:admin.integrations.outcome.unmapped}}** |

The extra cards appear below it only for the connections they apply to.

## What you can do

### Run the connection now

Click **{{ui:admin.integrations.syncNow}}**. It is offered only while the connection is switched on. The connection reads its system and runs every check wired to it, as on the [{{ui:admin.integrations.title}}](integrations.md) page, and a summary appears above the table: green when everything worked, amber when a read stopped early or nothing was collected, red with the reason when a read failed. The table then shows the new runs.

### Map a legacy application's columns

A legacy application connection reads an access table, whose columns are the application's own. **{{ui:admin.integrations.legacyMapping.title}}** says which column means what.

1. Click **{{ui:admin.integrations.legacyMapping.profileButton}}**. Inflect reads the server's manifest and the first page of the table, and lists each column with statistics about its values, such as how many are filled and how many look like email addresses. No value is stored or shown, apart from a status column's vocabulary.
2. For each column, choose what it **{{ui:admin.integrations.legacyMapping.colTarget}}**. The **{{ui:admin.integrations.legacyMapping.colSuggestion}}** column offers a guess, from the column's name, its values or both. A column whose name is on the never-request list, such as a password column, reads **{{ui:admin.integrations.legacyMapping.deniedColumn}}** and cannot be mapped.
3. Under **{{ui:admin.integrations.legacyMapping.layoutTitle}}**, say how entitlements are laid out: one column per entitlement, one row per entitlement, several values in one column with a delimiter, or not collected.
4. If a status column has few values, map each of them under **{{ui:admin.integrations.legacyMapping.statusMapTitle}}**. An unmapped value reads as unknown, which a reviewer then sees.
5. Click **{{ui:admin.integrations.legacyMapping.saveButton}}**. The card says which version is now in force.

If the application's columns change later, the card says which were added or removed, and reads refuse until you read the columns and save the mapping again.

### Read a legacy application's accounts, and match them to people

**{{ui:admin.integrations.legacyRuns.title}}** reads the application's accounts, then matches them to people in your HR records. An access review of the application is built from the latest read, once it is complete and matched.

1. Click **{{ui:admin.integrations.legacyRuns.readButton}}**. The read runs in the background; click **{{ui:admin.integrations.legacyRuns.refresh}}** to see its result under **{{ui:admin.integrations.legacyRuns.lastRead}}**.
2. When the latest read is complete, click **{{ui:admin.integrations.legacyRuns.matchButton}}**. This runs in the background too; its counts appear under **{{ui:admin.integrations.legacyRuns.lastMatch}}**: linked, suggested, ambiguous, unmatched and not a person.
3. Click **{{ui:admin.integrations.legacyRuns.openQueue}}** to confirm or correct the suggested matches.

**{{ui:admin.integrations.legacyRuns.standingTitle}}** says when the accounts were last read, how many there are, and **{{ui:admin.integrations.legacyRuns.coverageUNKNOWN}}**: every account the application handed over was read, but nothing confirms it handed over every account it holds.

A read or a match that was refused says why, in a sentence such as **{{ui:admin.integrations.legacyRuns.pullReason.SCHEMA_DRIFT}}**

### Name an external tool server's accountable owner

An external tool server connection lets agents call tools on another system. **{{ui:admin.integrations.owner.title}}** names the member who answers for what it lets an agent do. Choose them under **{{ui:admin.integrations.owner.label}}** and click **{{ui:admin.integrations.owner.save}}**, or click **{{ui:admin.integrations.owner.clear}}** and save to remove them. {{ui:admin.integrations.owner.missing}}

### Read an external tool server's integration passport

For an Owner, **{{ui:admin.integrations.passport.title}}** shows what the connection lets agents do, from its stored settings: its endpoint, how it signs in, its write rung, the tools that have been accepted, the agents granted tools on it, its parameter sets and prior-state pairings, and its open findings. A weekly sweep files it as evidence, compares it with the last one filed, and raises a finding for each change. **{{ui:admin.integrations.passport.changesTitle}}** lists the changes the next sweep would raise.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.integrations.outcome.empty}}** | The connection has not run any check yet | Click **{{ui:admin.integrations.syncNow}}** |
| **{{ui:admin.integrations.outcome.loadError}}** | The check runs did not load | Reload the page |
| **{{ui:admin.integrations.syncFailed}}**, or a reason from the server | The sync could not start | Check the connection on the [{{ui:admin.integrations.title}}](integrations.md) page, then try again |
| **{{ui:admin.integrations.legacyRuns.neverRead}}** | A legacy application's accounts have not been read | Map its columns, then click **{{ui:admin.integrations.legacyRuns.readButton}}** |
| **{{ui:admin.integrations.owner.saveFailed}}** | The owner was not saved | Choose an active member and save again |
| **{{ui:admin.integrations.passport.loadError}}** | The passport did not load | Reload the page |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.integrations.title}}](integrations.md), every connection in the workspace.
- [Reconciliation](integration-reconciliation.md), how a legacy application's accounts were matched to people.
- [{{ui:admin.identityAccounts.title}}](identity-accounts.md), the accounts directory connections have read.
