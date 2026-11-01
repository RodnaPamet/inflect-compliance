---
route: /t/[tenantSlug]/admin/mcp
---

# {{ui:admin.mcp.title}}

The {{ui:admin.mcp.title}} page lists every API key that is bound to one of the workspace's registered agents, says whether each key still works, and says how much the key lets its agent do. It answers one question during an incident: what can act in this workspace right now, and what has been switched off.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.security}}, click **{{ui:admin.nav.agentCredentials}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.agentCredentials}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the agent credentials | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

## What it is for

An AI agent reaches the workspace through an API key bound to it. When an agent misbehaves, or a key may have leaked, you revoke the key on the [{{ui:admin.apiKeys.pageTitle}}](api-keys.md) page and then come here to confirm it took effect. Revoked and expired keys stay on this list for that reason.

## What you see

A notice at the top says that the agent register, the proposal queue, activity, receipts and quarantine have moved, with a link, **{{ui:admin.agentRegisterLink}}**, to the agents' pages.

**{{ui:admin.mcp.credentialsTitle}}.** One entry per key bound to an agent, newest first:

- the key's name;
- the first characters of the key, so you can tell which key a system holds, and the name of the agent it acts as;
- how far the key lets its agent act: **{{ui:admin.apiKeys.autonomyLabel}}** followed by a number, the lowest of the key's own limit, the agent's level and what the agent's risk assessment allows. **{{ui:admin.mcp.credentialUnassessed}}** means the agent has never been risk-assessed, so the key can do nothing;
- its state: **{{ui:admin.mcp.credentialLive}}**, **{{ui:admin.mcp.credentialRevoked}}** or **{{ui:admin.mcp.credentialExpired}}**.

Keys that act as no agent, such as one for a CI pipeline, are not on this page. They are on [{{ui:admin.apiKeys.pageTitle}}](api-keys.md).

## What you can do

Read. The page changes nothing.

- **To stop a key**, revoke it on [{{ui:admin.apiKeys.pageTitle}}](api-keys.md), then reload this page and check that it reads **{{ui:admin.mcp.credentialRevoked}}**.
- **To stop an agent altogether**, whatever key it holds, use its kill switch, or suspend or retire it, on the agents' pages. Retiring an agent revokes every key bound to it.
- **When a key reads {{ui:admin.mcp.credentialUnassessed}}**, complete the agent's risk assessment on its page in the agent register.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.mcp.credentialsEmpty}}** | No key is bound to an agent | Nothing, or bind one when you create a key on [{{ui:admin.apiKeys.pageTitle}}](api-keys.md) |
| **{{ui:admin.forbidden.title}}** | You are not an Owner or an Admin | Ask an Owner or an Admin |

## Related

- [{{ui:admin.apiKeys.pageTitle}}](api-keys.md), where keys are created, bound to an agent and revoked.
- [{{ui:admin.integrations.title}}](integrations.md), where the external tool servers an agent may call are connected.
