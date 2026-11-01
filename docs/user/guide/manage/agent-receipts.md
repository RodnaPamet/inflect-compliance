---
route: /t/[tenantSlug]/agents/receipts
---

# {{ui:admin.mcp.receiptsTitle}}

The {{ui:admin.mcp.receiptsTitle}} page lists signed receipts of the tool actions agents take through this workspace's agent connection. A mediator placed in front of the agents signs a receipt for each tool decision it makes, and sends it here. The workspace checks the signature, so an auditor can confirm what an agent did without having to trust this system's own records.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.receipts}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:admin.crumb.agentReceipts}}**, and the same **{{ui:common.ui.viewsMenu}}** menu sits in the page header.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and export a receipt | Owner, Admin, AI admin; Auditor, when an Owner allows it |

An Owner lets Auditors read receipts with the switch **{{ui:admin.agentOversight.setting.auditorReadsReceipts.name}}** under [AI features](../admin/ai-features.md). It starts off. Without it, an Auditor sees **{{ui:agents.oversightAccess.title}}** instead of the page, as Editors and Readers always do.

## What you see

The newest 100 receipts that match the filter, newest first, with a count above them. When there are more, a line says so. Each one shows:

- the tool the agent used, in words, and the tool server it is on;
- the decision the mediator recorded: **{{ui:admin.mcp.receiptVerdict.ALLOWED}}**, **{{ui:admin.mcp.receiptVerdict.BLOCKED}}**, **{{ui:admin.mcp.receiptVerdict.FLAGGED}}**, **{{ui:admin.mcp.receiptVerdict.REDACTED}}** or **{{ui:admin.mcp.receiptVerdict.NOT_STATED}}**. A decision the page does not know is shown as the mediator wrote it;
- the policy the mediator applied, when the receipt gives it, and when the action happened;
- the agent, by name and linked to its page. This is the agent whose key sent the receipt, not the agent the receipt itself names. A receipt sent with a key bound to no agent says **{{ui:admin.mcp.receiptNoAgent}}**. A verified receipt also shows the agent it names itself, as a claim beside ours, not in place of it;
- **{{ui:admin.mcp.receiptOnlyThisTool}}**, which narrows the list to that tool;
- whether the signature checked out:

  | Label | What it means |
  | --- | --- |
  | **{{ui:admin.mcp.signatureVerified}}** | {{ui:admin.mcp.signatureVerifiedTooltip}} |
  | **{{ui:admin.mcp.unverified}}** | {{ui:admin.mcp.unverifiedTooltip}} |

  Hover over the label to see the same explanation.
- **{{ui:admin.mcp.receiptEvidence}}**, folded away: the **{{ui:admin.mcp.receiptAuditEntry}}** a verified receipt is linked to, and the **{{ui:admin.mcp.receiptProvenance}}** that was in force when the agent called the tool:

  | {{ui:admin.mcp.receiptProvenance}} | What it means |
  | --- | --- |
  | {{ui:admin.mcp.receiptProvenanceValue.BUILTIN}} | The tool is one of this product's own |
  | {{ui:admin.mcp.receiptProvenanceValue.UNATTESTED}} | The outside tool's description had not been approved, so what the agent was told is not known |
  | The approved description has changed since | Someone approved a newer description of the tool after this action; the sentence names the revision |
  | {{ui:admin.mcp.receiptProvenanceValue.NONE}} | The receipt predates this record |

An unverified receipt is kept so that it can be investigated, but it is not evidence of anything. The agent it names is only what the receipt claims.

## What you can do

### Narrow the list

Choose **{{ui:admin.mcp.receiptsFilterAll}}**, **{{ui:admin.mcp.receiptsFilterUnverified}}** or **{{ui:admin.mcp.receiptsFilterVerified}}** above the list, or click **{{ui:admin.mcp.receiptOnlyThisTool}}** on a receipt. **{{ui:admin.mcp.receiptsShowAll}}** clears both. The page address carries the filter, so you can share it.

### Export a receipt

Click **{{ui:admin.mcp.export}}** beside it. Your browser downloads a file holding the receipt's recorded content, its signature and the ID of the key that signed it, with notes on how to check the signature independently using the mediator's own verification tool.

If a run of receipts is unverified, find the agent that produced them on the [agent register](agents.md) and suspend it while you investigate.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.mcp.receiptsEmptyTitle}}** | {{ui:admin.mcp.receiptsEmpty}} No receipt has arrived. This is normal unless your workspace runs the mediator | Nothing, unless you expect receipts: then check the mediator is set up to post to this workspace |
| **{{ui:admin.mcp.receiptsEmptyNarrowedTitle}}** | {{ui:admin.mcp.receiptsEmptyNarrowedDesc}} | Click **{{ui:admin.mcp.receiptsShowAll}}** |
| **{{ui:agents.oversightAccess.title}}** | {{ui:agents.oversightAccess.message}} | Ask an Owner |

## Related

- [Agents](agents.md), the agent register.
- [{{ui:agents.decisions.title}}](agent-decisions.md), the record of each model call.
- [{{ui:agents.quarantine.title}}](agent-quarantine.md), agent proposals the output guard refused.
