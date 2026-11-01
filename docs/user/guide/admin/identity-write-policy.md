---
route: /t/[tenantSlug]/admin/identity-write-policy
---

# {{ui:admin.writeLadder.title}}

The {{ui:admin.writeLadder.title}} page decides whether Inflect may act on accounts in your identity directory, and how far: disable the directory account of someone HR reports as having left, and create one for someone HR reports as having joined. It is the most consequential setting in the workspace, so only an Owner can see or change it, and it can only be widened one step at a time.

## Where to find it

On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.writeLadder.linkLabel}}** in the header of {{ui:admin.integrations.configuredConnections}}. The link appears for Owners only. The breadcrumb reads **{{ui:admin.integrations.title}}** › **{{ui:admin.writeLadder.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the policy | Owner |
| Widen or narrow a direction | Owner |

Anyone else who opens the page's address sees **{{ui:admin.writeLadder.forbidden}}**

## What it is for

When someone leaves, their directory account should be disabled the same day. When someone joins, they need an account before their first morning. Inflect already knows both from your HR system and your directory connections, so it can do this for you. This page is where you decide whether it may, separately for leavers and joiners, after watching what it would do first.

## What you see

Two cards, **{{ui:admin.writeLadder.direction.leaver}}** and **{{ui:admin.writeLadder.direction.joiner}}**. Each shows its current step, a line on what the direction covers, and the buttons to move it.

Each direction has three steps:

| Step | What Inflect does |
| --- | --- |
| **{{ui:admin.writeLadder.mode.DISABLED}}** | Nothing. This is where every workspace starts |
| **{{ui:admin.writeLadder.mode.DRY_RUN}}** | Works out every night what it would do, and records it, but writes nothing to your directory |
| **{{ui:admin.writeLadder.mode.AUTOMATIC}}** | Writes to your directory without asking: disables a leaver's account, or creates a joiner's |

In dry run, the card says since when, and how long the direction must stay there before it can widen.

## What you can do

### Widen a direction

Click **Widen to** the next step, read what it means, and confirm. A direction moves one step at a time, from {{ui:admin.writeLadder.mode.DISABLED}} to {{ui:admin.writeLadder.mode.DRY_RUN}} to {{ui:admin.writeLadder.mode.AUTOMATIC}}.

A direction can leave dry run only after both:

- it has been in dry run for the number of days the card states, long enough for a real leaver or hire to happen and be compared with what HR and IT actually did; and
- at least one nightly pass has run in that time.

Until then, the widen button is greyed out, with the reason under it. Read the passes' outcomes on [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md) and [{{ui:admin.joinerPasses.title}}](identity-joiner-passes.md) before you widen.

### Narrow a direction

Click **Narrow to** the step below. It takes effect at the next nightly pass, with no wait. Leaving dry run, whether up or down, restarts its clock: coming back to dry run later means waiting the full period again.

## Before automatic does anything

Automatic is the policy; your connections still have to allow it. A pass at {{ui:admin.writeLadder.mode.AUTOMATIC}} acts only through exactly one enabled directory connection that:

- has been granted offboarding writes, and, for joiners, account creation too, on the [{{ui:admin.integrations.title}}](integrations.md) page; and
- has the directory permissions consented, for example for Microsoft Entra ID, the right to enable and disable accounts.

A dry run needs neither: it reads, and writes nothing.

Safety rails apply at every step. An account marked never to be offboarded on [{{ui:admin.identityAccounts.title}}](identity-accounts.md) is never disabled, nor is the account a connection signs in as, and a pass that would disable an unusual share of the directory at once stops.

## What happens next

- Every change to the policy adds an entry to the workspace's audit log, naming who made it.
- Each night the leaver pass runs at 05:00 UTC and the joiner pass at 04:30 UTC, after the directory and HR syncs. Each records what it did, or would have done, on its passes page. Every account it actually changes is recorded in the [{{ui:admin.identityWriteJournal.title}}](identity-write-journal.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.writeLadder.forbidden}}** | You are not an Owner | Ask an Owner |
| A reason under a greyed-out widen button | The direction cannot widen yet, for example because its dry run has not lasted long enough | Wait, or do what the reason names |
| **{{ui:admin.writeLadder.saveError}}**, or a reason from the server | The change was not made | Read the reason, and try again |
| **{{ui:admin.writeLadder.loadError}}** | The policy did not load | Reload the page |

## Related

- [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md) and [{{ui:admin.joinerPasses.title}}](identity-joiner-passes.md), what each nightly pass did.
- [{{ui:admin.identityWriteJournal.title}}](identity-write-journal.md), every change made to your directory.
- [{{ui:admin.identityAccounts.title}}](identity-accounts.md), where accounts are protected from offboarding.
