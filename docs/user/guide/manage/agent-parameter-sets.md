---
route: /t/[tenantSlug]/agents/parameter-sets
---

# {{ui:agents.parameterSets.title}}

The {{ui:agents.parameterSets.title}} page holds the approved arguments for tools on an outside tool server. When an agent, or a person composing a request, asks to use a tool through one of these saved sets, the change is made with exactly the values saved here, not values the model made up. A set can also leave some fields open within limits, and changing a set needs a second person's signature when it does.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}**, choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.externalTools}}**, pick the tool server, and click **{{ui:agents.externalTools.parameterSetsLink}}**. The page opens on that server.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, save a baseline, propose a change, sign, approve | Owner, Admin, AI admin |

The person who proposed a change that sets or alters open fields cannot sign or approve it; someone else must. Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page.

## What you see

**{{ui:agents.parameterSets.connectionLabel}}** picks the server, and **{{ui:agents.parameterSets.refresh}}** reads the saved sets again.

**{{ui:agents.parameterSets.createTitle}}**, a form for a server's first saved set of a tool (see below).

**The saved sets for this server.** Each one shows:

- whether it is a first save that nobody else reviewed, or an approved change;
- its label, the tool it is for, and its revision;
- who approved it and when, or, for a first save, that it had no approver;
- **{{ui:agents.parameterSets.inForce}}**: the arguments used today;
- its open fields and the limits on each, or **{{ui:agents.parameterSets.noOpenFields}}**: {{ui:agents.parameterSets.noOpenFieldsDesc}}
- the target, when one field names the record the call is about, and which records it may name;
- a fingerprint of the saved arguments, with a button to copy it in full.

When a change is waiting, the set also shows **{{ui:agents.parameterSets.pendingTitle}}**: who proposed it and when, **{{ui:agents.parameterSets.diffTitle}}** argument by argument, the open fields and target it would set, and the signatures collected so far. {{ui:agents.parameterSets.pendingNotInForce}}

## What you can do

### Save a baseline

1. Under **{{ui:agents.parameterSets.toolLabel}}**, choose the tool. Only tools the server currently offers are listed.
2. Give it a **{{ui:agents.parameterSets.labelLabel}}**. This is the name an agent or a request uses to pick it.
3. Under **{{ui:agents.parameterSets.parametersLabel}}**, write the arguments as a JSON object, such as `{"role": "reader"}`.
4. Click **{{ui:agents.parameterSets.create}}**.

A first save takes exact values only. To leave a field open or set a target, save the exact values first, then propose the change.

### Propose a change

1. On a set with no change waiting, click **{{ui:agents.parameterSets.propose}}**.
2. Edit **{{ui:agents.parameterSets.parametersLabel}}**.
3. Under **{{ui:agents.parameterSets.openFieldsLabel}}**, write the open fields the set should have after the change, as JSON. Write the whole intended set, not just what changes; leave it empty to remove them all. Each field has a kind: `regex`, `enum`, `integer`, `length` or `target`.
4. Choose a **{{ui:agents.parameterSets.targetLabel}}**, or **{{ui:agents.parameterSets.targetNone}}**.
5. Click **{{ui:agents.parameterSets.proposeSubmit}}**.

### Sign and approve a change

1. Read **{{ui:agents.parameterSets.diffTitle}}** and the open fields below it.
2. If the change sets or alters open fields, someone other than the proposer clicks **{{ui:agents.parameterSets.sign}}**. One signature is needed.
3. Click the **Approve** button. It names the first characters of the change's fingerprint, so you can see which version you are approving. The change then takes effect.

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

## Related

- [{{ui:agents.externalTools.title}}](agent-external-tools.md), where a tool's definition is approved.
- [{{ui:agents.compose.title}}](compose-request.md), where a person asks for a change using a saved set.
- [{{ui:admin.externalWriteLadder.title}}](../admin/external-write-policy.md), how far agents may change things in a server.
