---
route: /t/[tenantSlug]/agents/peers/[peerId]
---

# Peer agent

A peer's own page is where a peer agent from another organisation is admitted, connected and, if needed, stopped. You read and approve the peer's agent card, score its risk, issue the credential it uses to send tasks to one of your agents, and see every message exchanged with it.

## Where to find it

On the [{{ui:agents.peers.title}}](peer-agents.md) page, click a peer. Registering a new peer also opens its page. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.register.breadcrumb}}** › **{{ui:agents.peers.detail.crumbPeers}}** › the peer's name.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, approve the card, set the risk tier and quota, issue and revoke the credential | Owner, Admin, AI admin |
| Stop the peer, lift a stop, and read the stop history | Owner, Admin, AI admin |

Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page. A peer from another workspace, or one that does not exist, shows the page-not-found screen.

## When a peer can exchange tasks

A peer is let in only while all of these hold:

- its status is **{{ui:agents.peers.statusActive}}**;
- it has a risk tier. {{ui:agents.peers.detail.riskTierHint}}
- the card it publishes today is the card a person approved;
- traffic with it is not stopped.

To send your workspace a task, it also needs a live inbound credential, and this workspace needs a signing key. An Owner generates the key on the [{{ui:agents.peers.title}}](peer-agents.md) page.

## What you see

**The header** shows the peer's **{{ui:agents.peers.detail.metaStatus}}**, **{{ui:agents.peers.detail.metaPin}}**, **{{ui:agents.peers.detail.metaCard}}**, **{{ui:agents.peers.detail.metaQuota}}** and **{{ui:agents.peers.detail.metaKill}}**, as on the peers list.

**{{ui:agents.peers.detail.tabOverview}}.** When the card has changed: {{ui:agents.peers.detail.cardChangedNotice}} Below that, the card's address, the fingerprint of the peer's signing key, the fingerprint of the approved card and when it was approved, and the fingerprint of the card as last read and when. Then the card review, the risk tier and the quota.

**{{ui:agents.peers.detail.tabKill}}.** Whether traffic with the peer is stopped, and if so since when and why, the button to stop or resume it, and the **{{ui:agents.peers.kill.history}}** of every stop.

**{{ui:agents.peers.detail.tabCredential}}.** The **{{ui:agents.peers.credential.live}}**: the first characters of its token, the **{{ui:agents.peers.credential.receivingAgent}}**, the **{{ui:agents.peers.credential.workflows}}** and when it was issued. Below it, any **{{ui:agents.peers.credential.revokedHistory}}**.

**{{ui:agents.peers.detail.tabMessages}}.** Every task and answer exchanged with the peer, newest first: when, **{{ui:agents.peers.messages.directionInbound}}** or **{{ui:agents.peers.messages.directionOutbound}}**, what kind of message it was, its message ID, which key signed it, and whether its signed receipt checks out: **{{ui:agents.peers.messages.verifiesYes}}**, **{{ui:agents.peers.messages.verifiesNo}}** or **{{ui:agents.peers.messages.verifiesUnknown}}**.

## What you can do

### Read and approve the card

1. On **{{ui:agents.peers.detail.tabOverview}}**, under **{{ui:agents.peers.cardReview.heading}}**, click **{{ui:agents.peers.cardReview.read}}**.
2. The page shows the card's fingerprint, whether it matches the approved card (**{{ui:agents.peers.cardReview.verdict.MATCH}}**, **{{ui:agents.peers.cardReview.verdict.CHANGED}}** or **{{ui:agents.peers.cardReview.verdict.UNPINNED}}**) and, if it changed, which parts moved. Below that is the card's full text. {{ui:agents.peers.cardReview.textHeading}}
3. A line says whether the peer would be let in now, and if not, why.
4. Click **{{ui:agents.peers.cardReview.approve}}**, then **{{ui:agents.peers.cardReview.confirmAction}}**. The card is read again first; if it changed since you read it, nothing is approved.

### Set the risk tier and the quota

On **{{ui:agents.peers.detail.tabOverview}}**:

- Choose a **{{ui:agents.peers.detail.riskTierLabel}}** and click **{{ui:agents.peers.detail.riskTierSave}}**. **{{ui:agents.peers.detail.riskTierValue.UNSCORED}}** withdraws the score, and the peer is refused again.
- Set **{{ui:agents.peers.detail.quotaLabel}}** and click **{{ui:agents.peers.detail.quotaSave}}**. To stop a peer, use the stop switch rather than a low quota.

### Issue the inbound credential

1. On **{{ui:agents.peers.detail.tabCredential}}**, when there is no live credential, choose the **{{ui:agents.peers.credential.agentLabel}}** and the **{{ui:agents.peers.credential.workflowsLabel}}** it may ask that agent to run. {{ui:agents.peers.credential.issueDescription}}
2. Click **{{ui:agents.peers.credential.submitIssue}}**.
3. Copy the token now. {{ui:agents.peers.credential.tokenNotice}} The page also shows the address to send to, this workspace's identity and its signing public key, each with a copy button.
4. Click **{{ui:agents.peers.credential.done}}**.

### Revoke the credential

Click **{{ui:agents.peers.credential.revoke}}** and confirm. {{ui:agents.peers.credential.revokeDescription}}

### Stop traffic with the peer

1. On **{{ui:agents.peers.detail.tabKill}}**, enter a **{{ui:agents.peers.kill.reasonLabel}}**.
2. Click **{{ui:agents.peers.kill.engage}}**. {{ui:agents.peers.kill.engageDescription}}

To resume, enter **{{ui:agents.peers.kill.liftReasonLabel}}** and click **{{ui:agents.peers.kill.lift}}**. {{ui:agents.peers.kill.liftDescription}}

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:agents.peers.credential.none}} | No credential is live | Issue one |
| {{ui:agents.peers.credential.keyMissing}} | The workspace has no signing key | Ask an Owner to generate one |
| {{ui:agents.peers.credential.originMissing}} | This installation has no public address | Ask whoever runs this installation |
| **{{ui:agents.peers.messages.emptyTitle}}** | Nothing has been exchanged yet | Nothing to do |
| {{ui:agents.peers.kill.historyEmpty}} | The peer has never been stopped | Nothing to do |
| {{ui:agents.peers.cardReview.readFailed}} | The card could not be fetched | Check the card address with the other organisation, then read it again |
| The page-not-found screen | The peer does not exist in this workspace | Open it from the [{{ui:agents.peers.title}}](peer-agents.md) page |

## Related

- [{{ui:agents.peers.title}}](peer-agents.md), every peer, and this workspace's signing key.
- [Agents](agents.md), the agent register, where the receiving agent and its tool grants are managed.
