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
| Generate or rotate the workspace's signing key | Owner |

Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page.

## What you see

**{{ui:agents.peers.signingKey.title}}.** {{ui:agents.peers.signingKey.description}} The panel shows the key's **{{ui:agents.peers.signingKey.publicKey}}** and **{{ui:agents.peers.signingKey.fingerprint}}**, each with a copy button, when it was created, and how many older keys are kept so that older messages can still be checked. With no key, it says **{{ui:agents.peers.signingKey.none}}**

**The peers table:**

| Column | What it shows |
| --- | --- |
| {{ui:agents.peers.colName}} | The peer's name, and the address of its agent card |
| {{ui:agents.peers.colStatus}} | **{{ui:agents.peers.statusActive}}**, **{{ui:agents.peers.statusSuspended}}** or **{{ui:agents.peers.statusRetired}}** |
| {{ui:agents.peers.colPin}} | **{{ui:agents.peers.pinNone}}**, or which approved version of its card is in force |
| {{ui:agents.peers.colCard}} | Whether the card the peer publishes today is the one approved: **{{ui:agents.peers.cardMatches}}**, **{{ui:agents.peers.cardChanged}}** or **{{ui:agents.peers.cardUnobserved}}** |
| {{ui:agents.peers.colQuota}} | How many messages the peer may send this workspace in an hour |

Click a row to open the peer's own page.

## What you can do

### Register a peer

1. Click **{{ui:agents.peers.register.open}}**. The form **{{ui:agents.peers.register.heading}}** opens above the table.
2. Fill in:
   - **{{ui:agents.peers.register.name}}**.
   - **{{ui:agents.peers.register.cardUrl}}**: {{ui:agents.peers.register.cardUrlHint}}
   - **{{ui:agents.peers.register.signingKey}}**: {{ui:agents.peers.register.signingKeyHint}} Get it from the other organisation.
   - **{{ui:agents.peers.register.owner}}**: {{ui:agents.peers.register.ownerHint}}
   - **{{ui:agents.peers.register.vendor}}**: {{ui:agents.peers.register.vendorHint}} Add the supplier to the vendor register first if it is not there.
   - **{{ui:agents.peers.register.riskTier}}**, optional. {{ui:agents.peers.register.riskTierHint}}
3. Click **{{ui:agents.peers.register.submit}}**.

The peer's page opens. Read its card there and approve it before the peer can exchange anything.

### Generate or rotate the signing key

Owners only. Click **{{ui:agents.peers.signingKey.generate}}**, or **{{ui:agents.peers.signingKey.rotate}}** when a key exists, and confirm. {{ui:agents.peers.signingKey.rotateDescription}}

### Find a peer

Open the filter to choose by **{{ui:agents.peers.filters.status}}**, or type to search by name or card address.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.peers.emptyTitle}}** | No peer is registered | Register one |
| **{{ui:agents.peers.emptyMatchingTitle}}** | {{ui:agents.peers.emptyMatchingDesc}} | Clear the filters |
| {{ui:agents.peers.register.failed}} | The details were refused | Read the message under the form, correct it and try again |
| {{ui:agents.peers.signingKey.failed}} | The key was not changed | Try again; only an Owner can do this |

## Related

- [Peer agent](peer-agent-detail.md), one peer's card, credential, messages and stop switch.
- [Agents](agents.md), the agent register, where the agent that receives a peer's tasks is registered.
- [Vendors](vendors.md), where the supplier a peer belongs to is recorded.
