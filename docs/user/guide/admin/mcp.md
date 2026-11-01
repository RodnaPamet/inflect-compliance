---
route: /t/[tenantSlug]/admin/mcp
---

# {{ui:admin.mcp.title}}

The {{ui:admin.mcp.title}} page lists every API key that can act for an agent, says whether each one can act right now, and how far. It answers one question during an incident: what can act in this workspace right now, and what has been switched off.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.security}}, click **{{ui:admin.nav.agentCredentials}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.agentCredentials}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the agent credentials | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

## What it is for

An AI agent reaches the workspace through an API key. When an agent misbehaves, or a key may have leaked, you revoke the key on the [{{ui:admin.apiKeys.pageTitle}}](api-keys.md) page and then come here to confirm it took effect. Revoked and expired keys stay on this list for that reason.

## What you see

A notice at the top says that the agent register, the proposal queue, activity, receipts and quarantine have moved, with a link, **{{ui:admin.agentRegisterLink}}**, to the agents' pages.

**{{ui:admin.mcp.credentialsTitle}}.** One entry per key, newest first. A key is listed when it is bound to a registered agent, or when it is allowed to use the agent tools without one. Each entry shows:

- the key's name, and the first characters of the key, so you can tell which key a system holds;
- the agent it acts as, or **{{ui:admin.mcp.credentialNoAgent}}**;
- whether it can act right now:
  - **{{ui:admin.mcp.credentialLive}}**: it can act, up to the autonomy ceiling shown beside it. The ceiling is the lowest of the key's own limit, the agent's level and what the agent's risk assessment allows, and it says in words what that level lets the agent do.
  - **{{ui:admin.mcp.credentialStopped}}**: the key is valid but reaches nothing, and the entry says why. For example, its agent is suspended or retired, a kill switch is on, or its agent has never been risk-assessed.
  - **{{ui:admin.mcp.credentialUngoverned}}**: the key reaches the agent tools without any agent's limits. This happens when it is bound to no agent, or to one that is gone, retired or still a draft, and this workspace does not require registered agents.
  - **{{ui:admin.mcp.credentialRevoked}}** or **{{ui:admin.mcp.credentialExpired}}**, with the date.
- when it was last used, or **{{ui:admin.mcp.neverUsed}}**, and when it expires.

The list shows the newest keys. When there are more, a notice says how many are shown and that the older ones are on [{{ui:admin.apiKeys.pageTitle}}](api-keys.md). A **{{ui:admin.mcp.manageKeys}}** link goes there too.

## What you can do

Read. The page changes nothing.

- **To stop a key**, revoke it on [{{ui:admin.apiKeys.pageTitle}}](api-keys.md), then reload this page and check that it reads **{{ui:admin.mcp.credentialRevoked}}**.
- **To stop an agent altogether**, whatever key it holds, use its kill switch, or suspend or retire it, on the agents' pages. Retiring an agent revokes every key bound to it.
- **When a key reads {{ui:admin.mcp.credentialStopped}} because its agent was never risk-assessed**, complete the assessment on the agent's page in the agent register.
- **When a key reads {{ui:admin.mcp.credentialUngoverned}}**, bind it to an agent or revoke it. To make every such key stop, turn on **{{ui:admin.security.agentEnforcement.title}}** on the [{{ui:admin.security.title}}](security.md) page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.mcp.credentialsEmpty}}** | No key is bound to an agent or allowed to use the agent tools | Nothing, or bind one when you create a key on [{{ui:admin.apiKeys.pageTitle}}](api-keys.md) |
| **{{ui:admin.forbidden.title}}** | You are not an Owner or an Admin | Ask an Owner or an Admin |

## Related

- [{{ui:admin.apiKeys.pageTitle}}](api-keys.md), where keys are created, bound to an agent and revoked.
- [{{ui:admin.integrations.title}}](integrations.md), where the external tool servers an agent may call are connected.
