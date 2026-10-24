# Create an API key

An API key lets another system, such as a CI pipeline, read or change your workspace's data without a person signing in. Create one when you connect an integration, and revoke it when that integration no longer needs access.

## Before you start

- You need the Owner or Admin role. With a custom role, what you can do depends on the permissions your role was given.
- Decide what the other system needs to do. Give the key only the scopes it needs.
- Decide how long the key should live. A key with no expiry works until someone revokes it.
- Have a safe place ready for the key, such as the other system's secret store. The full key is shown only once.

## Steps

1. Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens.
2. Under {{ui:admin.section.organization}}, click **{{ui:admin.nav.apiKeys}}**.
3. Click **{{ui:admin.apiKeys.headerButton}}** beside the page title. The {{ui:admin.apiKeys.createTitle}} form opens.
4. In the {{ui:admin.apiKeys.nameLabel}} field, type a name that says what uses the key, up to 100 characters.
5. In {{ui:admin.apiKeys.expiryLabel}}, choose **30 days**, **90 days**, **180 days** or **1 year**. The time counts from the moment you create the key. If you choose nothing, the key has {{ui:admin.apiKeys.noExpiry}}.
6. {{ui:admin.apiKeys.bindingLabel}} is for a key that a registered agent uses. For any other key, leave it at {{ui:admin.apiKeys.agentPlaceholder}}. The list offers the workspace's active agents. If you pick one, you can also set an {{ui:admin.apiKeys.autonomyLabel}}, which can only lower what the agent may do.
7. Under {{ui:admin.apiKeys.scopesLabel}}, click each scope the key needs. Scopes are grouped by area, such as {{ui:admin.scopeGroup.controls}} and {{ui:admin.scopeGroup.evidence}}. Each area offers choices such as **Read** and **Write**, and a chosen scope shows a tick.
    - **{{ui:admin.apiKeys.fullAccess}}** gives the key read and write on every area. Prefer narrow scopes for automation.
    - Two scopes are never part of full access: **Workpaper_view** under {{ui:admin.scopeGroup.audits}} and **Agent_registry_view** under {{ui:admin.scopeGroup.admin}}. To grant either, pick scopes one by one.
8. Click **{{ui:admin.apiKeys.createKey}}**. It stays greyed out until the key has a name and at least one scope.
9. A box shows the new key under the warning **{{ui:admin.apiKeys.copyWarning}}** Click **{{ui:admin.apiKeys.copy}}**, then paste the key into the other system. The eye button, **{{ui:admin.apiKeys.showKey}}**, reveals the hidden part.
10. Click **{{ui:admin.apiKeys.dismissKey}}**. After that, nobody can see the full key again, Owners included. Leaving the page has the same effect.

The other system sends the key with every request, as a bearer token in the `Authorization` header: `Authorization: Bearer iflk_…`. The key works only in the workspace that created it.

You cannot edit a key once it exists. To change its scopes, expiry or agent, create a new key and revoke the old one.

## Revoke a key

1. On the {{ui:admin.apiKeys.pageTitle}} page, find the key in the table of active keys. The {{ui:admin.apiKeys.colKey}} column shows the key's first characters, so you can match it to the key the other system holds.
2. Click **{{ui:admin.apiKeys.revokeAria}}**, the bin icon at the end of the row.
3. In the dialog, click **{{ui:admin.apiKeys.revokeConfirm}}**.

The key stops working at once, and revoking cannot be undone. The key moves to the list of revoked and expired keys, marked **{{ui:admin.apiKeys.revoked}}**.

To replace a key without a gap, create the new key first. Switch the other system to it, then revoke the old one.

## What happens next

- The key appears in the table of active keys, with its scopes, its expiry and who created it. {{ui:admin.apiKeys.colExpires}} shows {{ui:admin.apiKeys.colNever}} for a key with no expiry.
- {{ui:admin.apiKeys.colLastUsed}} shows when the other system last used the key.
- When its expiry passes, the key stops working. It moves to the list of revoked and expired keys, marked **{{ui:admin.apiKeys.expired}}**.
- Creating or revoking a key adds an entry to the workspace's **{{ui:admin.auditLog}}**, naming who did it.
- A key can do only what its scopes allow. A key bound to an agent also can do no more than the person who created it.
- A key bound to an agent stops working if the person who created it is removed or deactivated. Retiring the agent revokes the key.
- Once a day, Inflect checks the keys an agent could use. Those are keys bound to an agent, keys with **{{ui:admin.apiKeys.fullAccess}}**, and keys with **Read** or **Propose** under {{ui:admin.scopeGroup.mcp}}.
- That check raises a finding when such a key never expires or has gone unused for 30 days. It also raises one for a key older than the rotation age, or with no agent binding. A finding never changes the key.
- The rotation age is 90 days unless an Owner or Admin sets another. They set it under {{ui:admin.security.apiKeyRotation.title}} on the **{{ui:admin.nav.security}}** page in {{ui:admin.title}}.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.apiKeys.createKey}}** stays greyed out | The key has no name, or no scope is chosen | Type a name and pick at least one scope |
| A message starting **Too many requests** | More than five attempts to create a key came from your network within an hour | Wait for the time the message gives. It can be up to an hour |
| **{{ui:admin.apiKeys.copyFailedToast}}** | Your browser blocked the copy | Click **{{ui:admin.apiKeys.showKey}}**, then select the key and copy it by hand |
| You dismissed the key before copying it | The full key is never shown again | Create a new key, then revoke the one you could not copy |
| A note in place of the agent list says you cannot read the agent register | Your role cannot see the workspace's agents | Ask an Owner to create the key |
| {{ui:admin.apiKeys.colBinding}} shows {{ui:admin.apiKeys.noBinding}} | The key is not bound to an agent. That is normal for an integration | If an agent uses the key, create a new key bound to that agent and revoke this one |
| The other system says its authentication failed | The key is revoked, expired, copied wrongly, or from another workspace | Look for the key in the revoked and expired list. If it is there, create a new key |
| The other system is refused some actions but not others | The key lacks the scope for those actions | Create a new key with the missing scope, then revoke the old one |
| A key nobody revoked shows **{{ui:admin.apiKeys.revoked}}** | The agent it was bound to was retired, which revokes its keys | If another agent needs access, create a new key bound to it |
