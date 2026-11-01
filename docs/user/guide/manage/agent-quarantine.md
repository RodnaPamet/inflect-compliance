---
route: /t/[tenantSlug]/agents/quarantine
---

# {{ui:agents.quarantine.title}}

The {{ui:agents.quarantine.title}} page lists the changes agents tried to propose that the output guard refused, such as a proposal carrying a prompt injection or a leaked secret. A refused proposal never reaches the review queue and can never be approved. This page is where you investigate what was attempted.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.quarantine}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.quarantine.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read a refused proposal | Owner, Admin, AI admin |

Everyone else, Auditors included, sees **{{ui:agents.quarantine.accessTitle}}** instead of the page.

## What you see

A notice at the top: {{ui:agents.quarantine.terminalNotice}}

The newest 100 refused proposals, newest first, with how many are listed beside the title. When there are more than 100, the count says older ones exist and a second notice explains that they are not listed or searched.

| Column | What it shows |
| --- | --- |
| {{ui:agents.quarantine.colWhen}} | When the agent proposed it |
| {{ui:agents.quarantine.colAgent}} | The agent that proposed it, or **{{ui:agents.quarantine.unattributed}}** when the credential it came through belongs to no registered agent |
| {{ui:agents.quarantine.colKind}} | What it would have done, such as creating a risk or updating a control |
| {{ui:agents.quarantine.colRules}} | Which guard rules refused it |
| {{ui:agents.quarantine.colDigest}} | The first characters of a fingerprint of the attempted content |

**Click a row** to open **{{ui:agents.quarantine.sheetTitle}}** at the side. Besides the columns above, it shows:

- **{{ui:agents.quarantine.sheetTarget}}**: the record an update would have changed.
- **{{ui:agents.quarantine.sheetProvenance}}**: where the content came from, such as text the workspace wrote or content read in from an outside source.
- **{{ui:agents.quarantine.sheetCredential}}**: the API key the proposal came through.
- **{{ui:agents.quarantine.sheetDigest}}** in full, with a button to copy it.
- **{{ui:agents.quarantine.sheetRationale}}**: the reason the agent gave.
- **{{ui:agents.quarantine.sheetPayload}}**: exactly what the agent tried to write. {{ui:agents.quarantine.sheetPayloadWarning}}

## What you can do

Read and investigate. Nothing on this page can be approved, released or deleted.

**Search.** Open the filter and type. The search looks through the agent, the rules, the fingerprint, the rationale and the attempted content of the proposals on the page. It does not reach older proposals that are not listed.

If one agent appears again and again, open it on the [agent register](agents.md) and suspend it, or check the content it is reading.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.quarantine.emptyTitle}}** | {{ui:agents.quarantine.emptyDesc}} | Nothing to do |
| **{{ui:agents.quarantine.emptyMatchingTitle}}** | Nothing on the page matches your search | Clear the search |
| {{ui:agents.quarantine.loadFailed}} | The list could not be loaded | Reload the page |
| **{{ui:agents.quarantine.accessTitle}}** | Your role cannot read refused proposals | Ask an Owner or Admin |

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), where proposals the guard let through are reviewed.
- [{{ui:agents.compose.title}}](compose-request.md), whose requests pass the same guard.
- [{{ui:agents.decisions.title}}](agent-decisions.md), the record of each model call.
