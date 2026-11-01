---
route: /t/[tenantSlug]/agents/receipts
---

# {{ui:admin.mcp.receiptsTitle}}

The {{ui:admin.mcp.receiptsTitle}} page lists signed receipts of the tool actions agents take through this workspace's agent connection. A mediator placed in front of the agents signs a receipt for each tool decision it makes, and sends it here. The workspace checks the signature, so an auditor can confirm what an agent did without having to trust this system's own records.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.receipts}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:admin.crumb.agentReceipts}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and export a receipt | Owner, Admin, AI admin |

Everyone else, Auditors included, sees **{{ui:agents.receipts.accessTitle}}** instead of the page.

## What you see

The newest 100 receipts, newest first. Each one shows:

- the tool the agent used, and the decision the mediator recorded for it;
- the policy the mediator applied, and the agent it named, when the receipt gives them;
- when the action happened;
- whether the signature checked out:

  | Label | What it means |
  | --- | --- |
  | **{{ui:admin.mcp.signatureVerified}}** | {{ui:admin.mcp.signatureVerifiedTooltip}} |
  | **{{ui:admin.mcp.unverified}}** | {{ui:admin.mcp.unverifiedTooltip}} |

  Hover over the label to see the same explanation.

An unverified receipt is kept so that it can be investigated, but it is not evidence of anything. The agent it names is only what the receipt claims.

## What you can do

**Export a receipt.** Click **{{ui:admin.mcp.export}}** beside it. You get the receipt's recorded content, its signature and the ID of the key that signed it, with notes on how to check the signature independently using the mediator's own verification tool.

If a run of receipts is unverified, find the agent that produced them on the [agent register](agents.md) and suspend it while you investigate.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:admin.mcp.receiptsEmpty}} | No receipt has arrived. This is normal unless your workspace runs the mediator | Nothing, unless you expect receipts: then check the mediator is set up to post to this workspace |
| **{{ui:agents.receipts.accessTitle}}** | Your role cannot read receipts | Ask an Owner or Admin |

## Related

- [Agents](agents.md), the agent register.
- [{{ui:agents.decisions.title}}](agent-decisions.md), the record of each model call.
- [{{ui:agents.quarantine.title}}](agent-quarantine.md), agent proposals the output guard refused.
