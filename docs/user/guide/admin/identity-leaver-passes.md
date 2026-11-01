---
route: /t/[tenantSlug]/admin/identity-leaver-passes
---

# {{ui:admin.leaverPasses.title}}

The {{ui:admin.leaverPasses.title}} page lists every nightly offboarding pass the workspace has run: who HR reported as having left, which directory accounts the pass would have disabled or did disable, and why it held back from the rest. Only an Owner can read it, because it names your people's accounts.

## Where to find it

On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.leaverPasses.linkLabel}}** in the header of {{ui:admin.integrations.configuredConnections}}. The link appears for Owners only. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}** › **{{ui:admin.leaverPasses.breadcrumb}}**, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the passes and their decisions | Owner |

Anyone else who opens the page's address sees **{{ui:admin.leaverPasses.forbidden}}**

## What it is for

Before you let Inflect disable accounts on its own, you watch what it would do. With the leaver direction in dry run on the [{{ui:admin.writeLadder.title}}](identity-write-policy.md) page, every pass records the accounts it would have disabled and does nothing. Compare that with what HR and IT actually did. Once you trust it, widen to automatic; the page then records what it did.

## What you see

The line under the title says the leaver direction's current step, and the highest step Inflect will act on. A second line links to the [{{ui:admin.identityWriteJournal.title}}](identity-write-journal.md): **{{ui:admin.leaverPasses.journalLink}}**.

**{{ui:admin.leaverPasses.passesHeading}}.** One row per pass, newest first:

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.colProvider}} | The directory the pass worked on |
| {{ui:admin.integrations.colStatus}} | **{{ui:admin.leaverPasses.statusPassed}}**, **{{ui:admin.leaverPasses.statusPartial}}** (it made more decisions than it recorded), **{{ui:admin.leaverPasses.statusRefused}}** or **{{ui:admin.leaverPasses.statusError}}** |
| {{ui:admin.leaverPasses.colSync}} | **{{ui:admin.leaverPasses.syncStale}}** or **{{ui:admin.leaverPasses.syncNeverObserved}}** when the directory sync, not the pass, is why accounts were held back |
| {{ui:admin.leaverPasses.colRefusal}} | Why a pass refused, when it did, in words, such as **{{ui:admin.leaverPasses.refusalLabel.MODE_DISABLED}}** or **{{ui:admin.leaverPasses.refusalLabel.NO_TERMINATED_WORKERS}}** |
| {{ui:admin.leaverPasses.colDecisions}} | How many accounts it decided about |
| {{ui:admin.leaverPasses.colRan}} | When it finished |

**A pass's details.** Click a row. The panel below the table shows:

- the pass's facts: the step it ran at, the evidence it used (**{{ui:admin.leaverPasses.evidenceLabel.live}}** or **{{ui:admin.leaverPasses.evidenceLabel.snapshot}}**), how many terminated workers HR reported, how many accounts were candidates, the size of the directory, and how many earlier writes were still unconfirmed when it started;
- a notice when the pass refused, when the directory sync was too old or had never seen the accounts, when earlier writes were never confirmed, or when no account in the directory is marked protected;
- **{{ui:admin.leaverPasses.decisionsHeading}}**, one row per account:
  - **{{ui:admin.leaverPasses.colAccount}}**: the person HR names and the account's address, or **{{ui:admin.leaverPasses.accountUnlinked}}**;
  - **{{ui:admin.leaverPasses.colOutcome}}**, in words, such as **{{ui:admin.leaverPasses.outcomeLabel.DRY_RUN}}**, **{{ui:admin.leaverPasses.outcomeLabel.DISABLED}}** or **{{ui:admin.leaverPasses.outcomeLabel.REFUSED_PROTECTED}}**;
  - a **{{ui:admin.leaverPasses.colJournal}}** when the pass wrote to the directory, to copy, with **{{ui:admin.leaverPasses.journalOpen}}** to open it;
  - the **{{ui:admin.leaverPasses.colBasis}}**: whether the account is mastered in the cloud or on-premises, and when that was observed;
  - the reason.

## What you can do

The passes run on their own every night at 05:00 UTC. To run one now, for example after fixing what made the last one refuse, click **Run now** for its directory in the {{ui:admin.leaverPasses.passesHeading}} card. The page says the pass is queued; it appears in the table when it finishes. A pass run now does exactly what the nightly one would, at the step the leaver direction is on.

- **To act on a disable**, click **{{ui:admin.leaverPasses.journalOpen}}** beside its **{{ui:admin.leaverPasses.colJournal}}**. The [{{ui:admin.identityWriteJournal.title}}](identity-write-journal.md) opens at that entry, with the account's state before the change.
- **When accounts were held back because the sync is stale**, re-enable or repair the directory connection that read them on the [{{ui:admin.integrations.title}}](integrations.md) page. Waiting does not clear it.
- **When an account must never be disabled**, protect it on [{{ui:admin.identityAccounts.title}}](identity-accounts.md).

## How a pass decides

A pass acts only on accounts it can be sure of:

- the person is reported as terminated by a complete HR sync, and their account is matched to them by work email after a complete directory sync;
- the account is not protected, and is not the account the connection signs in as;
- for Microsoft Entra ID, the directory has said recently whether the account is cloud-only. An account mastered in an on-premises directory is left for that directory;
- the batch as a whole is not an unusual share of the directory. A pass that would disable too many accounts at once disables none.

Anything it is not sure of, it refuses and records, rather than guessing.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.leaverPasses.emptyDisabled}}** | The leaver direction is off, so no pass runs | Turn on a dry run on the [{{ui:admin.writeLadder.title}}](identity-write-policy.md) page |
| **{{ui:admin.leaverPasses.emptyAwaitingFirstPass}}** | The direction was switched on and the first pass has not run yet | Come back after 05:00 UTC |
| **{{ui:admin.leaverPasses.emptyOverdue}}** | A pass should have run and recorded nothing | Ask your Inflect administrator to check the background jobs |
| **{{ui:admin.leaverPasses.emptyClampMismatch}}** | The direction is set above what Inflect will act on | Narrow it on the [{{ui:admin.writeLadder.title}}](identity-write-policy.md) page |
| **{{ui:admin.leaverPasses.noDecisions}}** | The pass found nobody to act on | Nothing |
| **{{ui:admin.leaverPasses.runFailed}}**, or the server's reason | The pass did not start | Act on the reason, or try again |
| **{{ui:admin.leaverPasses.loadError}}** | The passes did not load | Reload the page |

## Related

- [{{ui:admin.writeLadder.title}}](identity-write-policy.md), where the leaver direction is switched on and widened.
- [{{ui:admin.identityWriteJournal.title}}](identity-write-journal.md), every write a pass made.
- [{{ui:admin.joinerPasses.title}}](identity-joiner-passes.md), the same for new starters.
