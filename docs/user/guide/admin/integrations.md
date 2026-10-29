---
route: /t/[tenantSlug]/admin/integrations
---

# {{ui:admin.integrations.title}}

The {{ui:admin.integrations.title}} page connects this workspace to the systems Inflect reads from: identity directories, cloud accounts, source control, HR systems, legacy applications and SharePoint. Owners and Admins connect a system here, test and sync it, see whether each connection is still collecting, and turn connections off.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. In the {{ui:admin.section.integrations}} section, click **{{ui:admin.nav.integrations}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}**.

The SSO, SCIM and Entra pages link here too. The strip under their titles, **{{ui:admin.identityNav.label}}**, calls this page **{{ui:admin.identityNav.integrations}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see its connections, the catalogue and connection health | Owner, Admin |
| Connect, edit, test, sync and disable a connection | Owner, Admin |
| Connect SharePoint, choose its sites, test it and disconnect it | Owner, Admin |
| Turn on the internal checks | Owner, Admin |
| Open **{{ui:admin.leaverPasses.linkLabel}}** and **{{ui:admin.writeLadder.linkLabel}}** from this page | Owner |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An Admin whose membership carries a custom role can do only what that custom role allows. If it cannot manage the workspace's settings, the page still opens, but it shows the refusal in place of the connections, and no catalogue.

## What it is for

A connection lets Inflect collect from another system without anyone copying data by hand. Depending on the system, it runs automated control checks and records their results as evidence, reads the accounts in an identity directory, reads the employee roster from an HR system, reads a legacy application's access table for review, or imports documents from SharePoint. The health panel tells you when a connection has stopped collecting, which a green **{{ui:admin.integrations.statusActive}}** badge alone does not.

## What you see

**{{ui:admin.sharepoint.title}}.** A card for SharePoint, which connects through Microsoft sign-in rather than a form. With no connection it offers **{{ui:admin.sharepoint.connect}}**. Once connected, it shows the connection's name, a **{{ui:admin.sharepoint.statusConnected}}** or **{{ui:admin.sharepoint.statusError}}** badge from its last test, how many sites Inflect may read, and **{{ui:admin.sharepoint.test}}**, **{{ui:admin.sharepoint.sites}}** and **{{ui:admin.sharepoint.disconnect}}**. A connection that was disabled reads **{{ui:admin.sharepoint.statusDisabled}}** and offers only **{{ui:admin.sharepoint.disconnect}}**. **{{ui:admin.sharepoint.syncHealth}}** opens the SharePoint sync history.

**The agent engine note.** {{ui:admin.integrations.agentEnginesMoved}} **{{ui:admin.integrations.agentEnginesLink}}** opens it.

**{{ui:admin.integrations.availableTitle}}.** One card per system Inflect can connect to, grouped under {{ui:admin.integrations.category.identity}}, {{ui:admin.integrations.category.legacy}}, {{ui:admin.integrations.category.cloud}}, {{ui:admin.integrations.category.scm}}, {{ui:admin.integrations.category.hris}} and {{ui:admin.integrations.category.other}}. Each card names the system, describes it in a line, lists up to three of the checks it runs by name, such as **{{ui:admin.integrations.checkLabels.mfa_enforced}}**, with a count of the rest, and offers **{{ui:admin.integrations.connect}}**.

**Messages.** A green, amber or red banner reports the last action. It stays until the next one. After you authorize a connection with Microsoft Entra, a notice at the top of the page says whether it worked.

**{{ui:admin.integrations.webhookBaseUrl}}.** The address other systems send events to. Add the provider's code to its end, as the box shows.

**{{ui:admin.integrations.configuredConnections}}.** The table of every connection in the workspace, enabled or not, except SharePoint, which is managed on its card. Its header holds:

- **{{ui:admin.integrations.enableInternal}}**, while any of the three internal checks is off.
- **{{ui:admin.identityAccounts.linkLabel}}**, the accounts the directory syncs have read.
- **{{ui:admin.leaverPasses.linkLabel}}** and **{{ui:admin.writeLadder.linkLabel}}**, for Owners only.
- **{{ui:admin.integrations.addButton}}**, which opens an empty form.

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.colProvider}} | The system's name, as its catalogue card shows it |
| {{ui:admin.integrations.colName}} | The name you gave the connection |
| {{ui:admin.integrations.colStatus}} | **{{ui:admin.integrations.statusActive}}** or **{{ui:admin.integrations.statusDisabled}}** |
| {{ui:admin.integrations.colLastTest}} | The date someone last clicked **{{ui:admin.integrations.testConnection}}**, with a tick or a cross for the result, or a dash |
| {{ui:admin.integrations.colLastCollected}} | The date the connection last collected successfully. **{{ui:admin.integrations.neverCollected}}**, in amber, means an enabled connection that has never collected |
| {{ui:admin.integrations.colExecutions}} | How many runs the connection has recorded, whatever their result |
| {{ui:admin.integrations.colActions}} | **{{ui:admin.integrations.syncNow}}**, **{{ui:admin.integrations.viewOutcomes}}**, **{{ui:admin.integrations.testConnection}}**, **{{ui:admin.integrations.editConnection}}** and **{{ui:admin.integrations.disableIntegration}}**. A disabled connection has **{{ui:admin.integrations.enableIntegration}}** in place of **{{ui:admin.integrations.disableIntegration}}**, and no **{{ui:admin.integrations.syncNow}}**. An MCP server connection also has **{{ui:admin.integrations.authorizeEntra}}** |

**{{ui:admin.integrations.health.title}}.** A second table, shown while at least one connection is enabled. It lists each enabled connection's **{{ui:admin.integrations.health.colLastSuccess}}** date, or **{{ui:admin.integrations.health.testedOk}}** or **{{ui:admin.integrations.health.neverSucceeded}}**; its **{{ui:admin.integrations.health.colFreshness}}**, the time since its last run or successful test, such as 3h or 2d; and a status:

- **{{ui:admin.integrations.health.blocked}}**, with the reason, when a scheduled sync has no one it can run as.
- **{{ui:admin.integrations.health.stale}}**, when the connection has had no run and no successful test for 48 hours.
- **{{ui:admin.integrations.health.fresh}}** otherwise. A run counts whatever its result, so a connection whose runs fail can read **{{ui:admin.integrations.health.fresh}}**. Compare **{{ui:admin.integrations.health.colLastSuccess}}**.

The header counts the connections that are stale or not syncing.

## What you can do

### Connect a system

Click **{{ui:admin.integrations.connect}}** on its card, or click **{{ui:admin.integrations.addButton}}**, the button with a plus sign, and choose the system under **{{ui:admin.integrations.provider}}**. The **{{ui:admin.integrations.addIntegration}}** form opens below the tables. Give it a **{{ui:admin.integrations.connectionName}}**, then read the blue box, which says what the system needs and where to find it. Fill in the **{{ui:admin.integrations.configuration}}** fields and the **{{ui:admin.integrations.secrets}}**; **{{ui:admin.integrations.show}}** reveals what you type. Required fields are marked. The form also lists the system's **{{ui:admin.integrations.supportedChecks}}**, and the automation key a control uses to run each one. Click **{{ui:admin.integrations.createConnection}}**.

The new connection syncs straight away, and the banner reports the result. {{ui:admin.integrations.secretsNotice}}

Only one HR system can be enabled at a time, because the roster is kept per workspace. To move to another HR system, disable the first connection, then connect the new one.

### Test a connection

Click **{{ui:admin.integrations.testConnection}}** on its row. Inflect tries the stored settings and secrets and records the result under {{ui:admin.integrations.colLastTest}}:

- **{{ui:admin.integrations.testVerified}}**
- **{{ui:admin.integrations.testShapeOnly}}** Some systems cannot be checked live.
- A red message starting **Test failed:** gives the reason.

### Sync a connection now

Click **{{ui:admin.integrations.syncNow}}**. The banner reads **{{ui:admin.integrations.syncRunning}}**, then a summary. A sync reads the directory for an identity system and the roster for an HR system, and runs every control check wired to the system. The summary counts the directory accounts or HR people read and the control checks that ran. It is green when everything worked; amber when a directory or HR read stopped early, another sync of the connection was already running, or nothing was collected; and red, with the reason, when a read failed or a check could not run. **{{ui:admin.integrations.viewOutcomes}}** lists each check run.

### Edit a connection

Click **{{ui:admin.integrations.editConnection}}**. The **{{ui:admin.integrations.editIntegration}}** form opens with the stored settings. The system cannot be changed. Leave a secret blank to keep the stored one. If you change the address the connection points at, enter the secret again too, or the save is refused. Click **{{ui:admin.integrations.updateConnection}}**.

Saving keeps the connection enabled or disabled, as it was.

### Disable a connection

Click **{{ui:admin.integrations.disableIntegration}}**, the bin icon. There is no confirmation. The status changes to **{{ui:admin.integrations.statusDisabled}}**, and the connection stops syncing and running checks. Its row, settings and history are kept.

### Enable a connection

On a disabled connection, click **{{ui:admin.integrations.enableIntegration}}**. The status changes back to **{{ui:admin.integrations.statusActive}}** and the connection syncs again on its schedule. If another HR system is already enabled, the page says which one and leaves this one off.

### Turn on the internal checks

Click **{{ui:admin.integrations.enableInternal}}**. Inflect adds the Personnel, Device Posture and Training & Background checks, which need no credentials: they check data already in the workspace, such as the personnel roster. If one of them was disabled, the button turns it back on.

### Authorize an MCP server

An MCP server connection that signs in through Microsoft Entra needs consent once. Fill in its Entra tenant ID, client ID and client secret first, then click **{{ui:admin.integrations.authorizeEntra}}** on its row. Microsoft asks you to sign in and consent, then returns you here, and a notice at the top of the page says whether the authorization completed, was declined or did not complete. A successful authorization also adds an entry to the workspace's audit log. If any of those three values is missing, the page says what to set instead of sending you to Microsoft.

### Connect and manage SharePoint

Click **{{ui:admin.sharepoint.connect}}** on the {{ui:admin.sharepoint.title}} card. Microsoft asks you to sign in and consent, then returns you here, and the card shows one of three messages: **{{ui:admin.sharepoint.connected}}**, **{{ui:admin.sharepoint.declined}}** or **{{ui:admin.sharepoint.connectionFailed}}**

- **{{ui:admin.sharepoint.sites}}** opens a list of the sites the connection can reach. Choose the ones Inflect may read and click **{{ui:admin.sharepoint.saveSites}}**. If the save is refused, the list stays open and the card says why. If the sites cannot be read, the card says why instead of opening an empty list.
- **{{ui:admin.sharepoint.test}}** checks the connection and shows the result under it.
- **{{ui:admin.sharepoint.disconnect}}** removes the connection. For five seconds a message offers **{{ui:admin.sharepoint.undo}}**.

The SharePoint connection is managed on its card only, and is not listed in {{ui:admin.integrations.configuredConnections}}. A SharePoint connection that was disabled reads **{{ui:admin.sharepoint.statusDisabled}}**: disconnect it, then connect SharePoint again.

## What happens next

- Creating, editing and disabling a connection, authorizing an MCP server, connecting or disconnecting SharePoint and changing its sites add an entry to the workspace's audit log, naming who did it. Open it from **{{ui:admin.auditLog}}** on the {{ui:admin.title}} page.
- Enabled directory connections sync every night at 03:00 UTC, and the HR connection at 04:00 UTC. A person who disappears from the HR system is marked as terminated on the {{ui:admin.nav.personnel}} page.
- Check results appear on the controls each check is wired to. **{{ui:admin.integrations.viewOutcomes}}** opens the connection's own page: its check runs, its accountable owner and, for a legacy application, its column mapping and account reads.
- When a scheduled sync has no active Owner or Admin to run as, the connection shows **{{ui:admin.integrations.health.blocked}}** with the reason until one is available.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.integrations.emptyConfigured}}** | Nothing is connected | Click **{{ui:admin.integrations.connect}}** on a card |
| A red message in place of the table | Your role cannot read the connections, or Inflect could not list them. The message says which | Ask an Owner or Admin, or reload the page |
| **{{ui:admin.integrations.loadFailed}}** | The page could not reach Inflect | Reload the page |
| A message that starts **This tenant already has an enabled HRIS connection** | Another HR connection is enabled | Disable it first |
| A message that starts **Changing** and asks you to re-enter the credential | You changed the address and kept the stored secret | Type the secret again and save |
| **Test failed:** with a reason | The system refused the settings or secrets | Fix them with **{{ui:admin.integrations.editConnection}}**, then test again |
| **{{ui:admin.integrations.syncFailed}}**, or a reason from the server | The sync could not start | Reload the page and try again |
| A red sync summary that names a reason | The directory or HR system refused the read, for example because a credential expired | Fix the settings or secrets with **{{ui:admin.integrations.editConnection}}**, then sync again |
| **{{ui:admin.integrations.health.blockedNoActiveAdmin}}** | No active Owner or Admin is left to run syncs | Invite or reactivate one |
| **{{ui:admin.integrations.health.blockedNoAdminWithUpload}}** | No Owner or Admin may upload evidence | Give one of them that permission |
| **{{ui:admin.sharepoint.consentError}}** or **{{ui:admin.sharepoint.disconnectFailed}}** | The SharePoint action did not go through | Try again |
| **{{ui:admin.integrations.saveFailed}}**, **{{ui:admin.integrations.networkError}}**, **{{ui:admin.integrations.authorizeFailed}}** or **{{ui:admin.integrations.internalEnableFailed}}** | The action did not go through | Reload the page and try again |

## Related

- [{{ui:admin.sso.title}}](sso.md), which sets up sign-in. A directory connection here reads accounts; it does not sign anyone in.
- [{{ui:admin.members.title}}](members.md), for the Owners and Admins that scheduled syncs run as.
- [{{ui:personnel.title}}](personnel.md), the roster an HR connection fills.
- [{{ui:admin.notifications.title}}](notifications.md), which sends the emails some syncs raise.
