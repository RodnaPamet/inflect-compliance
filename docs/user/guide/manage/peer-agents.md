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
| Invite a peer, or accept an invitation | Owner, Admin |
| Generate or rotate the workspace's signing key | Owner |

Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page.

AI admins do not see **{{ui:agents.peers.invite.open}}** or **{{ui:agents.peers.accept.open}}**. Connecting through an invitation also sets up this workspace's connection to the other one, which only an Owner or Admin can do.

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

### Invite another workspace

Owners and Admins only.

1. Click **{{ui:agents.peers.invite.open}}**. The form **{{ui:agents.peers.invite.heading}}** opens above the table. {{ui:agents.peers.invite.intro}}
2. Choose the **{{ui:agents.peers.invite.owner}}**, the supplier, the risk tier, the agent that receives the peer's tasks, and the workflows it may start.
3. Click **{{ui:agents.peers.invite.submit}}**.
4. Under **{{ui:agents.peers.invite.codeTitle}}**, click **{{ui:agents.peers.invite.copyCode}}** and send the code to the other workspace. {{ui:agents.peers.invite.codeNotice}} Click **{{ui:agents.peers.invite.done}}** when you have it.

### Accept an invitation

Owners and Admins only.

1. Click **{{ui:agents.peers.accept.open}}**, and paste the code into **{{ui:agents.peers.accept.code}}**.
2. Click **{{ui:agents.peers.accept.read}}**. **{{ui:agents.peers.accept.cardTitle}}** shows the other workspace's card. Read it.
3. Choose who here answers for the peer, its supplier and risk tier, and the agent and workflows it may reach.
4. Click **{{ui:agents.peers.accept.submit}}**. {{ui:agents.peers.accept.approveNotice}}

The new peer's page opens. The other workspace then approves your card on their side.

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

## Related

- [Peer agent](peer-agent-detail.md), one peer's card, access token, messages and stop switch.
- [Agents](agents.md), the agent register, where the agent that receives a peer's tasks is registered.
- [Vendors](vendors.md), where the supplier a peer belongs to is recorded.
