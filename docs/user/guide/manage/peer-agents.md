---
route: /t/[tenantSlug]/agents/peers
---

# {{ui:agents.peers.title}}

The {{ui:agents.peers.title}} page lists agents run by other organisations that your agents exchange tasks with. Registering a peer records who it is and who answers for it here. It does not give the peer any access: a peer can send or receive tasks only after a person has read and approved its agent card, and only through one of your registered agents.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.peers}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.peers.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and register a peer | Owner, Admin, AI admin |
| Invite another workspace, or accept its invitation | Owner, Admin |
| Generate or rotate the workspace's signing key | Owner |

Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page. An AI admin sees **{{ui:agents.peers.invite.open}}** and **{{ui:agents.peers.accept.open}}**, but the invitation is refused: inviting and accepting store a connection, which needs an Owner or Admin. An invitation is always created and accepted by a person, never with an API key.

## What you see

**{{ui:agents.peers.signingKey.title}}.** {{ui:agents.peers.signingKey.description}} The panel shows the key's **{{ui:agents.peers.signingKey.publicKey}}** and **{{ui:agents.peers.signingKey.fingerprint}}**, each with a copy button, when it was created, and how many older keys are kept so that older messages can still be checked. With no key, it says **{{ui:agents.peers.signingKey.none}}**

**The peers table:**

| Column | What it shows |
| --- | --- |
| {{ui:agents.peers.colName}} | The peer's name, and the address of its agent card |
| {{ui:agents.peers.colOwner}} | The member who answers for the peer here |
| {{ui:agents.peers.colVendor}} | The supplier, from the vendor register, that runs the peer |
| {{ui:agents.peers.colStatus}} | **{{ui:agents.peers.statusActive}}**, **{{ui:agents.peers.statusSuspended}}** or **{{ui:agents.peers.statusRetired}}** |
| {{ui:agents.peers.colPin}} | **{{ui:agents.peers.pinNone}}**, or which approved version of its card is in force |
| {{ui:agents.peers.colCard}} | Whether the card the peer publishes today is the one approved: **{{ui:agents.peers.cardMatches}}**, **{{ui:agents.peers.cardChanged}}**, **{{ui:agents.peers.cardUnobserved}}**, or **{{ui:agents.peers.cardUnapproved}}** for a peer whose card nobody has approved yet |
| {{ui:agents.peers.colQuota}} | How many messages the peer may send this workspace in an hour |

Click a row to open the peer's own page.

## What you can do

### Register a peer

1. Click **{{ui:agents.peers.register.open}}**. The form **{{ui:agents.peers.register.heading}}** opens above the table.
2. Fill in:
   - **{{ui:agents.peers.register.name}}**.
   - **{{ui:agents.peers.register.cardUrl}}**: {{ui:agents.peers.register.cardUrlHint}}
   - **{{ui:agents.peers.register.signingKey}}**: {{ui:agents.peers.register.signingKeyHint}}
   - **{{ui:agents.peers.register.owner}}**: {{ui:agents.peers.register.ownerHint}}
   - **{{ui:agents.peers.register.vendor}}**: {{ui:agents.peers.register.vendorHint}} The list shows the first suppliers; type to search the rest. Add the supplier to the vendor register first if it is not there. With no suppliers at all, the form says {{ui:agents.peers.register.vendorsEmpty}} and links to **{{ui:agents.peers.register.vendorsLink}}**.
   - **{{ui:agents.peers.register.riskTier}}**, optional. {{ui:agents.peers.register.riskTierHint}}
3. Click **{{ui:agents.peers.register.submit}}**.

The peer's page opens. Read its card there and approve it before the peer can exchange anything.

### Connect another workspace with an invitation

When the other organisation also uses Inflect, one invitation connects the two workspaces in place of registering each side by hand.

**To invite:**

1. Click **{{ui:agents.peers.invite.open}}**. The form **{{ui:agents.peers.invite.heading}}** opens.
2. Choose the **{{ui:agents.peers.invite.owner}}** here, the supplier the other workspace belongs to, the **{{ui:agents.peers.credential.agentLabel}}** that receives its tasks, and the **{{ui:agents.peers.credential.workflowsLabel}}** it may ask that agent to run. {{ui:agents.peers.invite.workflowsHint}}
3. Click **{{ui:agents.peers.invite.submit}}**. The panel **{{ui:agents.peers.invite.codeTitle}}** shows the code. {{ui:agents.peers.invite.codeNotice}} Click **{{ui:agents.peers.invite.copyCode}}**, send the code to the other workspace, and click **{{ui:agents.peers.invite.done}}**.

The code expires after 7 days. When the other workspace accepts it, it appears in the table here, and you read and approve its card on its page before anything is exchanged.

**To accept:**

1. Click **{{ui:agents.peers.accept.open}}**, paste the code into **{{ui:agents.peers.accept.code}}**, and click **{{ui:agents.peers.accept.read}}**.
2. **{{ui:agents.peers.accept.cardTitle}}** shows the other workspace's card address, its **{{ui:agents.peers.accept.cardHash}}** and its **{{ui:agents.peers.accept.keyFingerprint}}**. Read them.
3. Give the peer a name here, and choose who answers for it, its supplier, the agent that receives its tasks and the workflows it may start, as for an invitation.
4. Click **{{ui:agents.peers.accept.submit}}**. {{ui:agents.peers.accept.approveNotice}}

The new peer's page opens. The other workspace then approves your card on its side.

### Generate or rotate the signing key

Owners only. Click **{{ui:agents.peers.signingKey.generate}}**, or **{{ui:agents.peers.signingKey.rotate}}** when a key exists, and confirm. {{ui:agents.peers.signingKey.rotateDescription}}

### Find a peer

Open the filter to choose by **{{ui:agents.peers.filters.status}}**, or type to search by name or card address.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.peers.emptyTitle}}** | {{ui:agents.peers.emptyDesc}} | Register one |
| **{{ui:agents.peers.emptyMatchingTitle}}** | {{ui:agents.peers.emptyMatchingDesc}} | Clear the filters |
| {{ui:agents.peers.register.failed}} | The details were refused | Read the message under the form, correct it and try again |
| {{ui:agents.peers.register.ownersUnavailable}} | The member list did not load | Reload the page |
| {{ui:agents.peers.register.vendorsUnavailable}} | The vendor register did not load | Reload the page |
| {{ui:agents.peers.signingKey.failed}} | The key was not changed | Try again; only an Owner can do this |
| {{ui:agents.peers.invite.failed}} | The invitation was not created; a reason from the server is shown when there is one | Correct it and try again |
| {{ui:agents.peers.accept.readFailed}} | The code could not be read: it may be incomplete, used or expired | Check the code, or ask for a new one |
| {{ui:agents.peers.accept.failed}} | The invitation was not accepted; a reason from the server is shown when there is one | Correct it and try again |

## Related

- [Peer agent](peer-agent-detail.md), one peer's card, access token, messages and stop switch.
- [Agents](agents.md), the agent register, where the agent that receives a peer's tasks is registered.
- [Vendors](vendors.md), where the supplier a peer belongs to is recorded.
