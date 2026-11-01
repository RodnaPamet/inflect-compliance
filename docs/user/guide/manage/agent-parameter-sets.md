---
route: /t/[tenantSlug]/agents/parameter-sets
---

# {{ui:agents.parameterSets.title}}

The {{ui:agents.parameterSets.title}} page holds the approved arguments for tools on an outside tool server. When an agent, or a person composing a request, asks to use a tool through one of these saved sets, the change is made with exactly the values saved here, not values the model made up. A set can also leave some fields open within limits. Changing which fields are open, or their limits, needs a second person's signature.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.parameterSets}}**. You can also reach it from the [{{ui:agents.externalTools.title}}](agent-external-tools.md) page: pick the tool server and click **{{ui:agents.externalTools.parameterSetsLink}}**, and the page opens on that server.

The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.parameterSets.title}}**, and the same **{{ui:common.ui.viewsMenu}}** menu sits in the page header.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, save a baseline, propose a change, sign, approve | Owner, Admin, AI admin |

Who may decide a change depends on what it changes:

| The change | Who signs | Who approves |
| --- | --- | --- |
| Any change to a set that has open fields, or one that gives it open fields | Anyone but the proposer; one signature is needed | Anyone but the proposer |
| A change of exact values, on a set with no open fields before or after | Nobody; no signature is needed | Anyone, the proposer included. When an Owner has turned on **{{ui:admin.agentOversight.setting.exactParameterEditNeedsSecondApprover.name}}** under [AI features](../admin/ai-features.md), anyone but the proposer |

The page turns off the buttons you may not use, and says why: {{ui:agents.parameterSets.proposerCannotDecide}} Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page.

## What you see

**{{ui:agents.parameterSets.connectionLabel}}** picks the server, and **{{ui:agents.parameterSets.refresh}}** reads the saved sets again.

**{{ui:agents.parameterSets.createTitle}}**, a form for a server's first saved set of a tool (see below).

**The saved sets for this server.** Each one shows:

- **{{ui:agents.parameterSets.source.BASELINE}}** or **{{ui:agents.parameterSets.source.APPROVED}}**;
- its label, the tool it is for in words, and its revision;
- who approved it, by name, and when; or, for a first save, that it had no approver. A person no longer in the workspace reads **{{ui:agents.parameterSets.formerMember}}**;
- **{{ui:agents.parameterSets.inForce}}**: the arguments used today;
- its open fields and the limits on each, or **{{ui:agents.parameterSets.noOpenFields}}**: {{ui:agents.parameterSets.noOpenFieldsDesc}}
- the target, when one field names the record the call is about, and which records it may name;
- a fingerprint of the saved arguments, with a button to copy it in full.

When a change is waiting, the set also shows **{{ui:agents.parameterSets.pendingTitle}}**: who proposed it, by name, and when, **{{ui:agents.parameterSets.diffTitle}}** argument by argument, and the open fields and target it would set. {{ui:agents.parameterSets.pendingNotInForce}}

Below that, a change that needs a signature shows the signatures collected so far, each by name. A change of exact values on a set with no open fields shows no signature count; it says instead either {{ui:agents.parameterSets.exactEditNoSignature}} or {{ui:agents.parameterSets.exactEditSecondPerson}}

## What you can do

### Save a baseline

1. Under **{{ui:agents.parameterSets.toolLabel}}**, choose the tool. Only tools the server currently offers are listed.
2. Give it a **{{ui:agents.parameterSets.labelLabel}}**. This is the name an agent or a request uses to pick it.
3. Under **{{ui:agents.parameterSets.parametersLabel}}**, write the arguments as a JSON object of argument names and values, such as `{"role": "reader"}`. The page checks that it is valid JSON, not that the tool accepts these arguments.
4. Click **{{ui:agents.parameterSets.create}}**.

A first save takes exact values only. To leave a field open or set a target, save the exact values first, then propose the change.

### Propose a change

1. On a set with no change waiting, click **{{ui:agents.parameterSets.propose}}**.
2. Edit **{{ui:agents.parameterSets.parametersLabel}}**.
3. Under **{{ui:agents.parameterSets.openFieldsLabel}}**, write the open fields the set should have after the change, as JSON. Write the whole intended set, not just what changes; leave it empty to remove them all. Each field has a kind: `regex` (a pattern), `enum` (a list of values), `integer` (a whole-number range), `length` (a text length) or `target` (a subject from the target population).
4. Choose a **{{ui:agents.parameterSets.targetLabel}}** from the list, which describes each in words, or **{{ui:agents.parameterSets.targetNone}}**.
5. Click **{{ui:agents.parameterSets.proposeSubmit}}**.

### Sign and approve a change

1. Read **{{ui:agents.parameterSets.diffTitle}}** and the open fields below it.
2. If the set has open fields before or after the change, someone other than the proposer clicks **{{ui:agents.parameterSets.sign}}**. One signature is needed. A change of exact values on a set with no open fields has no Sign button.
3. Check the pending fingerprint shown above the button, then click **{{ui:agents.parameterSets.approve}}**. The approval is for that version, and the change then takes effect.

A signature counts only for the change it was given on. If the proposal is replaced, the signatures collected on the old one no longer count. If the change moved while you were reading it, the approval is refused; reload and read it again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.parameterSets.noConnectionsTitle}}** | {{ui:agents.parameterSets.noConnectionsDesc}} | Connect a tool server under Integrations |
| **{{ui:agents.parameterSets.emptyTitle}}** | {{ui:agents.parameterSets.emptyDesc}} | Save a baseline |
| {{ui:agents.parameterSets.catalogueError}} | The server's tool list could not be read | Check the server on the [{{ui:agents.externalTools.title}}](agent-external-tools.md) page |
| {{ui:agents.parameterSets.noToolsDesc}} | The server lists no tools | Check the server's own configuration |
| {{ui:agents.parameterSets.invalidJson}} | What you typed is not JSON | Fix the text and try again |
| {{ui:agents.parameterSets.notAnObject}} | The arguments are a list or a single value | Wrap them in `{ }` with a name for each |
| {{ui:agents.parameterSets.signError}} or {{ui:agents.parameterSets.approveError}}, with what the server said | The signature or approval was refused | Read the reason; reload if the change moved |

## Related

- [{{ui:agents.externalTools.title}}](agent-external-tools.md), where a tool's definition is approved.
- [{{ui:agents.compose.title}}](compose-request.md), where a person asks for a change using a saved set.
- [{{ui:admin.externalWriteLadder.title}}](../admin/external-write-policy.md), how far agents may change things in a server.
