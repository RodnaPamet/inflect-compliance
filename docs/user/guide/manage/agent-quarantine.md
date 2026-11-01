---
route: /t/[tenantSlug]/agents/quarantine
---

# {{ui:agents.quarantine.title}}

The {{ui:agents.quarantine.title}} page lists the changes agents tried to propose that the output guard refused, such as a proposal carrying a prompt injection or a leaked secret. A refused proposal never reaches the review queue and can never be approved. This page is where you investigate what was attempted.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.quarantine}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.quarantine.crumb}}**, and the same **{{ui:common.ui.viewsMenu}}** menu sits in the page header.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read a refused proposal | Owner, Admin, AI admin; Auditor, when an Owner allows it |

An Owner lets Auditors read the quarantine with the switch **{{ui:admin.agentOversight.setting.auditorReadsQuarantine.name}}** under [AI features](../admin/ai-features.md). It starts off. Without it, an Auditor sees **{{ui:agents.oversightAccess.title}}** instead of the page, as Editors and Readers always do.

## What you see

A notice at the top: {{ui:agents.quarantine.terminalNotice}}

The newest 100 refused proposals, newest first, with how many are listed beside the title. When there are more than 100, the count says older ones exist and a second notice explains that they are not listed or searched.

| Column | What it shows |
| --- | --- |
| {{ui:agents.quarantine.colWhen}} | When the agent proposed it |
| {{ui:agents.quarantine.colAgent}} | Who made it: the agent by name; for a request a person composed in the app, the person's name; otherwise **{{ui:agents.quarantine.unattributed}}**. An agent since removed from the register reads **{{ui:agents.quarantine.agentUnknown}}** |
| {{ui:agents.quarantine.colKind}} | What it would have done, such as a risk, followed by **{{ui:agents.quarantine.operation.CREATE}}** or **{{ui:agents.quarantine.operation.UPDATE}}** |
| {{ui:agents.quarantine.colRules}} | Why the guard refused it, in words (see below) |
| {{ui:agents.quarantine.colDigest}} | The first characters of a fingerprint of the attempted content |

**Click a row** to open **{{ui:agents.quarantine.sheetTitle}}** at the side. Besides the columns above, it shows:

- **{{ui:agents.quarantine.colAgent}}**, linked to the agent's page.
- **{{ui:agents.quarantine.sheetTarget}}**: a link to the record an update would have changed, or **{{ui:agents.quarantine.targetNew}}**.
- **{{ui:agents.quarantine.sheetProvenance}}**: **{{ui:agents.quarantine.provenance.TENANT_AUTHORED}}**, **{{ui:agents.quarantine.provenance.THIRD_PARTY_INGESTED}}** or **{{ui:agents.quarantine.provenance.SYSTEM}}**.
- **{{ui:agents.quarantine.sheetCredential}}**: the name of the API key the proposal came through, or **{{ui:agents.quarantine.credentialComposed}}**.
- **{{ui:agents.quarantine.sheetRules}}**, each described in words with the rule's own ID beside it.
- **{{ui:agents.quarantine.sheetDigest}}** in full, with a button to copy it.
- **{{ui:agents.quarantine.sheetRationale}}**: the reason the agent gave, as plain text.
- **{{ui:agents.quarantine.sheetPayload}}**: exactly what the agent tried to write. {{ui:agents.quarantine.sheetPayloadWarning}}

**Why the guard refused it.** Each rule is shown as what it looks for:

| Shown as | What the guard found |
| --- | --- |
| {{ui:agents.quarantine.ruleFamily.ignorePrevious}} | Text telling the model to disregard what it was told |
| {{ui:agents.quarantine.ruleFamily.systemRole}} | Text dressed up as a system message, or giving the model a new identity |
| {{ui:agents.quarantine.ruleFamily.instructionOverride}} | Text trying to change the model's rules or get it to reveal them |
| {{ui:agents.quarantine.ruleFamily.answerSteering}} | Text telling the model what its answer must be |
| {{ui:agents.quarantine.ruleFamily.toolPoisoning}} | Text trying to make the model call a tool, or change what it sends a tool |
| {{ui:agents.quarantine.ruleFamily.exfil}} | Text trying to send data somewhere outside |
| {{ui:agents.quarantine.ruleFamily.apiKey}}, {{ui:agents.quarantine.ruleFamily.bearerOrJwt}}, {{ui:agents.quarantine.ruleFamily.privateKey}}, {{ui:agents.quarantine.ruleFamily.seedPhrase}} or {{ui:agents.quarantine.ruleFamily.highEntropySecret}} | A secret in the content, which must not be written into a record |
| {{ui:agents.quarantine.ruleFamilyOther}} | A rule this page has no description for; its ID is shown |

## What you can do

Read and investigate. Nothing on this page can be approved, released or deleted.

**Search.** Open the filter and type. The search looks through who made it, the rules, the fingerprint, the rationale and the attempted content of the proposals on the page. It does not reach older proposals that are not listed.

If one agent appears again and again, open it on the [agent register](agents.md) and suspend it, or check the content it is reading.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.quarantine.emptyTitle}}** | {{ui:agents.quarantine.emptyDesc}} | Nothing to do |
| **{{ui:agents.quarantine.emptyMatchingTitle}}** | Nothing on the page matches your search | Clear the search |
| {{ui:agents.quarantine.loadFailed}} | The list could not be loaded | Reload the page |
| **{{ui:agents.oversightAccess.title}}** | {{ui:agents.oversightAccess.message}} | Ask an Owner |

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), where proposals the guard let through are reviewed.
- [{{ui:agents.compose.title}}](compose-request.md), whose requests pass the same guard.
- [{{ui:agents.decisions.title}}](agent-decisions.md), the record of each model call.
