---
route: /t/[tenantSlug]/risks/ai-systems
---

# {{ui:risks.aiSystems.title}}

The {{ui:risks.aiSystems.title}} page is the workspace's register of AI systems it builds or uses. Each system is classified against the EU AI Act, and its risk tier links it to the obligations that tier brings.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}** in the sidebar, then choose **{{ui:risks.viewLinks.aiSystems}}** under **{{ui:risks.viewsRegistry}}** in the **{{ui:risks.viewsMenu}}** menu. The breadcrumb reads **{{ui:risks.breadcrumbDashboard}}** › **{{ui:risks.aiSystems.risksCrumb}}** › **{{ui:risks.aiSystems.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the register and any system | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Register a system, classify a provisional one, and generate conformity drafts | Owner, Admin, Editor |
| Approve a conformity draft | Whoever reviews the workspace's agent proposals; see [{{ui:agents.proposals.title}}](../manage/agent-proposals.md) |

**{{ui:risks.aiSystems.addSystem}}**, **{{ui:risks.aiSystems.detail.classify}}** and the draft buttons appear only for Owners, Admins and Editors.

If your workspace uses custom roles, these changes follow the built-in role your custom role is based on.

## What it is for

Use the register to keep track of every AI system in scope of the EU AI Act, to know which tier each falls in, and to see what that tier obliges you to do. A high-risk system can also produce drafts of the conformity documents the Act requires.

## What you see

**The header.** The title, and a line counting the systems registered, how many are high-risk, how many are prohibited and how many still need classifying. Owners, Admins and Editors also see **{{ui:risks.aiSystems.addSystem}}**, with a plus sign.

**The filter.** Filter by **{{ui:risks.aiSystems.filters.riskTier}}**: {{ui:risks.aiSystems.filterEnums.riskTier.UNCLASSIFIED}}, {{ui:risks.aiSystems.filterEnums.riskTier.PROHIBITED}}, {{ui:risks.aiSystems.filterEnums.riskTier.HIGH}}, {{ui:risks.aiSystems.filterEnums.riskTier.LIMITED}} or {{ui:risks.aiSystems.filterEnums.riskTier.MINIMAL}}.

**The register.**

| Column | What it shows |
| --- | --- |
| {{ui:risks.aiSystems.colSystem}} | The system's name, with its provider under it |
| {{ui:risks.aiSystems.colRiskTier}} | Its tier: {{ui:risks.aiSystems.filterEnums.riskTier.PROHIBITED}}, {{ui:risks.aiSystems.filterEnums.riskTier.HIGH}}, {{ui:risks.aiSystems.filterEnums.riskTier.LIMITED}}, {{ui:risks.aiSystems.filterEnums.riskTier.MINIMAL}}, or {{ui:risks.aiSystems.filterEnums.riskTier.UNCLASSIFIED}} for a provisional entry that nobody has classified |
| {{ui:risks.aiSystems.colBasis}} | The article or annex of the Act that decided the tier |
| {{ui:risks.aiSystems.colRole}} | Whether the workspace is the system's provider or its deployer |
| {{ui:risks.aiSystems.colObligations}} | How many obligations its tier links it to |

Click a row to open the system.

**A system's page** shows its tier, the article or annex that decided it and the reasoning, its provider, purpose and use context, and its linked obligations: the requirements its tier links it to, each linking to its framework. A provisional entry says **{{ui:risks.aiSystems.detail.notClassifiedNotice}}** A high-risk system also has **{{ui:risks.aiSystems.detail.conformityHeading}}**.

## What you can do

### Register a system

Click **{{ui:risks.aiSystems.addSystem}}**. The **{{ui:risks.aiSystems.new.title}}** form asks for:

- **{{ui:risks.aiSystems.new.nameLabel}}**, required, and the **{{ui:risks.aiSystems.new.providerLabel}}**.
- **{{ui:risks.aiSystems.new.roleLabel}}**: {{ui:risks.aiSystems.provider}} if you build it, {{ui:risks.aiSystems.deployer}} if you use it.
- **{{ui:risks.aiSystems.new.purposeLabel}}** and **{{ui:risks.aiSystems.new.useContextLabel}}**. Both are kept encrypted.
- Under **{{ui:risks.aiSystems.new.classificationHeading}}**, four questions: **{{ui:risks.aiSystems.new.art5Label}}**, **{{ui:risks.aiSystems.new.annexIIILabel}}**, **{{ui:risks.aiSystems.new.art6Checkbox}}** and **{{ui:risks.aiSystems.new.art50Label}}**. {{ui:risks.aiSystems.new.classificationHelp}}

Click **{{ui:risks.aiSystems.new.submit}}**. Inflect works out the tier from your answers, links the obligations it brings, and opens the system's page. The tier cannot be changed afterwards from the page.

### Classify a provisional entry

An entry created when a discovered agent is taken into the agent register starts unclassified. On its page, click **{{ui:risks.aiSystems.detail.classify}}**. Answer all four questions, choosing **{{ui:risks.aiSystems.detail.classifyModal.notApplicable}}** where one does not apply, and click **{{ui:risks.aiSystems.detail.classifyModal.submit}}**. An entry is classified once; after that its tier is fixed.

### Generate conformity drafts

On a high-risk system's page, **{{ui:risks.aiSystems.detail.conformityHeading}}** offers three documents: **{{ui:risks.aiSystems.detail.docTypes.ANNEX_IV_TECHNICAL_DOCUMENTATION}}**, **{{ui:risks.aiSystems.detail.docTypes.ART_9_RISK_MANAGEMENT}}** and **{{ui:risks.aiSystems.detail.docTypes.ANNEX_V_DECLARATION_OF_CONFORMITY}}**. Click one to have a draft written. {{ui:risks.aiSystems.detail.conformityHelp}} The button then reads **{{ui:risks.aiSystems.detail.queued}}**.

What the page says next depends on whether you can read the workspace's agent proposals:

- **If you can** (Owners and Admins), a link opens the {{ui:risks.aiSystems.detail.approvalQueue}}.
- **If you cannot** (Editors), the page says: {{ui:risks.aiSystems.detail.draftsQueuedNoQueueSingular}} **{{ui:risks.aiSystems.detail.openPolicies}}** takes you there.

## What happens next

- An approved draft becomes a draft policy, to be reviewed and published like any other. See [{{ui:policies.title}}](../manage/policies.md).
- An agent can be activated only once the AI system it belongs to is classified.
- Registering and classifying a system are recorded in the workspace's audit log, naming who did it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.aiSystems.emptyTitle}}** | The workspace has no AI systems | Owners, Admins and Editors click **{{ui:risks.aiSystems.addSystem}}** |
| **{{ui:risks.aiSystems.emptyMatchingTitle}}** | No system matches the filter | {{ui:risks.aiSystems.emptyMatchingDesc}} |
| **{{ui:risks.aiSystems.new.errorFallback}}**, or the reason the server gave | The system was not registered, and the form stays open | Follow the reason given, then try again |
| **{{ui:risks.aiSystems.detail.classifyModal.failed}}** | The entry was not classified | Check that every question is answered, then try again |
| **{{ui:risks.aiSystems.detail.errorFallback}}**, or the reason the server gave | The draft was not created | Follow the reason given |

## Related

- [{{ui:risks.title}}](risks.md), where this register is reached from.
- [An AI system](ai-system-detail.md), the page each entry opens.
- [{{ui:agents.register.title}}](../manage/agents.md), where an agent's AI system is chosen.
- [{{ui:frameworks.list.heading}}](frameworks.md), which holds the EU AI Act and ISO 42001 requirements.
