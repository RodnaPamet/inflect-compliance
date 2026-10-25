---
route: /t/[tenantSlug]/admin/api-keys
---

# {{ui:admin.apiKeys.pageTitle}}

The {{ui:admin.apiKeys.pageTitle}} page holds the keys that let another system, such as a CI pipeline, a monitoring tool or an AI agent, use this workspace through the Inflect API without a person signing in. Owners and Admins create keys here, see when each was last used, and revoke them.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.organization}}, click **{{ui:admin.nav.apiKeys}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.apiKeys}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the workspace's keys | Owner, Admin |
| Create a key, and bind it to an agent | Owner, Admin |
| Revoke a key, including one somebody else created | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An Admin whose membership carries a custom role can do only what that custom role allows. If it cannot read the workspace's agent register, the form cannot bind a key to an agent.

## What it is for

Give each system its own key, with only the access that system needs, and revoke the key when the system no longer needs it or the key may have leaked. A key that an AI agent uses can be bound to one of the workspace's registered agents, so the key acts as that agent and within that agent's limits.

## What you see

**The header.** The page title and **{{ui:admin.apiKeys.headerButton}}**, which opens the form for a new key. The button is hidden while the form or a newly created key is on screen.

**Messages.** A green message confirms a new or revoked key. A red message says why an action did not go through. Close either with its cross.

**The {{ui:admin.apiKeys.createTitle}} form.**

| Field | What it sets |
| --- | --- |
| {{ui:admin.apiKeys.nameLabel}} | A name that says what uses the key, up to 100 characters. Required |
| {{ui:admin.apiKeys.expiryLabel}} | **30 days**, **90 days**, **180 days** or **1 year**, counted from the moment you create the key. With nothing chosen, the key has {{ui:admin.apiKeys.noExpiry}}. To go back to that after choosing one, click the chosen option again |
| {{ui:admin.apiKeys.bindingLabel}} | The registered agent the key acts as. The list offers the workspace's active agents and starts at {{ui:admin.apiKeys.agentPlaceholder}}. The agent can be chosen only now, when the key is created, never afterwards |
| {{ui:admin.apiKeys.autonomyLabel}} | Appears once an agent is chosen. {{ui:admin.apiKeys.autonomyNone}}, or a level from **L0** up to the agent's own level. It can only lower what the agent may do with this key |
| {{ui:admin.apiKeys.scopesLabel}} | What the key may do. Required: at least one scope |

**Scopes.** Click a choice to select it; a selected choice shows a tick. **{{ui:admin.apiKeys.fullAccess}}** gives the key read and write on every area and hides the other choices. Otherwise, pick choices area by area:

| Area | Choices |
| --- | --- |
| {{ui:admin.scopeGroup.controls}}, {{ui:admin.scopeGroup.evidence}}, {{ui:admin.scopeGroup.tasks}}, {{ui:admin.scopeGroup.risks}}, {{ui:admin.scopeGroup.assets}}, {{ui:admin.scopeGroup.vendors}}, {{ui:admin.scopeGroup.tests}}, {{ui:admin.scopeGroup.frameworks}}, {{ui:admin.scopeGroup.reports}} | **Read**, **Write** |
| {{ui:admin.scopeGroup.policies}}, {{ui:admin.scopeGroup.access_reviews}} | **Read**, **Write**, **Admin** |
| {{ui:admin.scopeGroup.incidents}}, {{ui:admin.scopeGroup.personnel}}, {{ui:admin.scopeGroup.identity_reconciliation}} | **Read**, **Admin** |
| {{ui:admin.scopeGroup.continuity}}, {{ui:admin.scopeGroup.processes}} | **Write** |
| {{ui:admin.scopeGroup.audits}} | **Read**, **Write**, **Workpaper_view** |
| {{ui:admin.scopeGroup.admin}} | **Read**, **Write**, **External_tools**, **Harness_ingest**, **Agent_registry_view** |
| {{ui:admin.scopeGroup.mcp}} | **Read**, **Propose**, **Orchestrate** |

A few of these need a word of explanation:

- **Workpaper_view** reads the auditor agent's workpapers, and **Agent_registry_view** reads the workspace's agent register. Neither is part of **{{ui:admin.apiKeys.fullAccess}}**, so a key gets them only when you pick them by name.
- **External_tools** lets the key reach tools on a server outside Inflect. It is separate from **Write** under {{ui:admin.scopeGroup.admin}} so that no key gains it by accident.
- **Harness_ingest** is the one scope a harness scanner's key needs to send its reports.
- The {{ui:admin.scopeGroup.mcp}} choices are for keys that agents use: **Read** lets the key read through Inflect's agent tools, **Propose** lets it draft proposals for a person to approve, and **Orchestrate** lets it drive an agent run.

**The new key.** After you click **{{ui:admin.apiKeys.createKey}}**, a box shows the key under the warning **{{ui:admin.apiKeys.copyWarning}}** Only its first characters are visible. The eye button, **{{ui:admin.apiKeys.showKey}}**, reveals the rest. **{{ui:admin.apiKeys.copy}}** copies it, and **{{ui:admin.apiKeys.dismissKey}}** closes the box.

**The table of active keys.** One row per key that is neither revoked nor expired.

| Column | What it shows |
| --- | --- |
| {{ui:admin.apiKeys.colName}} | The key's name |
| {{ui:admin.apiKeys.colKey}} | The key's first characters, such as `iflk_1a2b3c4d...`, so you can match it to the key a system holds |
| {{ui:admin.apiKeys.colBinding}} | The agent the key is bound to, and its autonomy ceiling if it has one. **{{ui:admin.apiKeys.noBinding}}** means the key acts as no agent, which is normal for an integration |
| {{ui:admin.apiKeys.colScopes}} | The key's first three scopes as the API writes them, such as `controls:read` or `*` for full access, and a count of the rest |
| {{ui:admin.apiKeys.colExpires}} | When the key stops working, or {{ui:admin.apiKeys.colNever}} |
| {{ui:admin.apiKeys.colLastUsed}} | When a system last used the key, or a dash if it never has |
| {{ui:admin.apiKeys.colCreated}} | When the key was created, and by whom |

The bin icon at the end of a row is **{{ui:admin.apiKeys.revokeAria}}**. Times on this page are shown in UTC.

**The revoked and expired keys.** A second table, shown once any key has been revoked or has expired, lists those keys with their name struck through. Its {{ui:admin.apiKeys.colStatus}} column reads **{{ui:admin.apiKeys.revoked}}** or **{{ui:admin.apiKeys.expired}}**. These keys stay on the page as a record, with no actions: a revoked or expired key cannot be brought back.

## What you can do

### Create a key

Click **{{ui:admin.apiKeys.headerButton}}**, fill in the form and click **{{ui:admin.apiKeys.createKey}}**. The button stays greyed out until the key has a name and at least one scope. Copy the key from the box into the other system before you click **{{ui:admin.apiKeys.dismissKey}}**: the full key is shown only once. After you dismiss it, or leave the page, nobody can see it again, Owners included.

The other system sends the key with every request, as a bearer token in the `Authorization` header: `Authorization: Bearer iflk_…`. The key works only in this workspace.

### Revoke a key

Click **{{ui:admin.apiKeys.revokeAria}}**, the bin icon at the end of the key's row. In the dialog, click **{{ui:admin.apiKeys.revokeConfirm}}**. The key stops working at once, and revoking cannot be undone.

### Change or replace a key

A key cannot be edited once it exists, and its agent can be chosen only when it is created. To change a key's scopes, expiry or agent, create a new key, switch the other system to it, then revoke the old one. Doing it in that order also replaces a key without a gap.

## What happens next

- Creating or revoking a key adds an entry to the workspace's audit log, naming who did it. Open it from **{{ui:admin.auditLog}}** on the {{ui:admin.title}} page.
- {{ui:admin.apiKeys.colLastUsed}} updates each time a system uses the key.
- When its expiry passes, a key stops working and moves to the revoked and expired keys, marked **{{ui:admin.apiKeys.expired}}**.
- A key can do only what its scopes allow. A key bound to an agent also can do no more than the person who created it, and it stops working if that person is deactivated or removed. Retiring the agent revokes its keys.
- A key with no agent binding keeps working after the person who created it leaves the workspace. Revoke it when its system no longer needs access.
- Once a day, Inflect checks the keys an agent could use. It raises a finding for a weakness, such as a key that never expires or has gone unused for 30 days. A finding never changes the key. The age at which a key counts as due for rotation is set under {{ui:admin.security.apiKeyRotation.title}} on the **{{ui:admin.nav.security}}** page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.apiKeys.emptyActive}}** | No key is live: none was created, or every key was revoked or has expired. The same message shows when the list fails to load | Create a key. If you expected keys here, reload the page |
| **{{ui:admin.apiKeys.loadFailed}}** | The page could not reach Inflect | Check your connection and reload the page |
| A note in place of the agent list says you do not have permission to read the agent register | Your role cannot see the workspace's agents | For a key an agent will use, ask an Owner or an Admin who can read the agent register to create it |
| A note in place of the agent list says the agent register could not be loaded | The list of agents did not load | Reload the page before you create a key that an agent will use |
| A message saying only an active agent can be bound to a key | The agent was suspended or retired after the page loaded | Reload the page and choose an active agent |
| A message starting **Too many requests** | More than five attempts to create a key came from your network within an hour | Wait for the time the message gives. It can be up to an hour |
| **{{ui:admin.apiKeys.copyFailedToast}}** | Your browser blocked the copy | Click **{{ui:admin.apiKeys.showKey}}**, then select the key and copy it by hand |
| You dismissed the key before copying it | The full key is never shown again | Create a new key, then revoke the one you could not copy |
| **API key is already revoked.** | Someone revoked the key since the page loaded | Reload the page |
| **{{ui:admin.apiKeys.createFailed}}** or **{{ui:admin.apiKeys.revokeFailed}}** | The action did not go through | Reload the page and try again |

The how-to [Create an API key](../../how-to/set-up/create-an-api-key.md) covers what to do when the other system's requests are refused.

## Related

- [Create an API key](../../how-to/set-up/create-an-api-key.md), step by step, including how to revoke and replace a key.
- [{{ui:admin.members.title}}](members.md), where members are deactivated and removed. Their agent-bound keys stop working when they are; their other keys do not.
