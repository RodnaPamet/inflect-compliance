---
route: /t/[tenantSlug]/admin/identity-write-journal
---

# {{ui:admin.identityWriteJournal.title}}

The {{ui:admin.identityWriteJournal.title}} is the record of every change Inflect has made to your identity directory: each account it disabled or created, when, how it ended, and the account's state just before. Only an Owner can read it, because each entry is about one of your people's accounts.

## Where to find it

Three ways in, all for Owners:

- on the [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md) page, **{{ui:admin.leaverPasses.journalLink}}** under the title, or **{{ui:admin.leaverPasses.journalOpen}}** beside a decision's journal reference, which opens that entry;
- on the [{{ui:admin.writeLadder.title}}](identity-write-policy.md) page, the link on each direction's card;
- the reference quoted in a disable notification, pasted into the page's **{{ui:admin.identityWriteJournal.findLabel}}** field.

The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}** › **{{ui:admin.identityWriteJournal.breadcrumb}}**, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the journal | Owner |

Anyone else who opens the page sees **{{ui:admin.identityWriteJournal.forbidden}}**

## What it is for

- **To answer "what did it change?"** The passes pages say whether a pass ran and what it decided; the journal is what was actually written. An entry exists only when Inflect was at automatic, every safety check passed, and a call to your directory was made.
- **To undo a change.** Inflect does not re-enable accounts itself. The journal keeps the account's state before the change, so whoever re-enables it in your directory knows what to restore.
- **To check writes that never reported back.** Sometimes a directory accepts a request and Inflect cannot confirm the result. Those are listed first, so someone can check them in the directory.

An empty journal is not evidence that the passes ran. It is empty for every workspace in dry run, and for every pass that held back.

## What you see

**{{ui:admin.identityWriteJournal.findLabel}}.** {{ui:admin.identityWriteJournal.findHint}} Paste it and click **{{ui:admin.identityWriteJournal.findOpen}}** to open its entry.

**{{ui:admin.identityWriteJournal.unsettledTitle}}.** Shown only when there are any: writes that were attempted more than an hour ago and never reported an outcome. Check each in your directory.

**{{ui:admin.identityWriteJournal.historyTitle}}.** Every write, newest first:

| Column | What it shows |
| --- | --- |
| {{ui:admin.identityWriteJournal.colAccount}} | Whose account: the person HR names and the account's address. **{{ui:admin.identityWriteJournal.accountUnlinked}}** or **{{ui:admin.identityWriteJournal.accountGone}}** when it cannot be named |
| {{ui:admin.integrations.colProvider}} | The directory written to |
| {{ui:admin.identityWriteJournal.colAction}} | What was done, such as **{{ui:admin.identityWriteJournal.action.DISABLE_ACCOUNT}}** or **{{ui:admin.identityWriteJournal.action.CREATE_ACCOUNT}}** |
| {{ui:admin.integrations.colStatus}} | How it ended: **{{ui:admin.identityWriteJournal.outcome.APPLIED}}**, **{{ui:admin.identityWriteJournal.outcome.FAILED}}**, **{{ui:admin.identityWriteJournal.outcome.PENDING}}**, **{{ui:admin.identityWriteJournal.outcome.INDETERMINATE}}** (not confirmed either way) or **{{ui:admin.identityWriteJournal.outcome.REVERTED}}** |
| {{ui:admin.identityWriteJournal.colAttempted}} | When it was attempted |
| {{ui:admin.identityWriteJournal.colActor}} | The member who started the pass, **{{ui:admin.identityWriteJournal.actorScheduled}}** for the nightly pass, or **{{ui:admin.identityWriteJournal.actorFormer}}** |

**{{ui:admin.identityWriteJournal.capturedTitle}}.** Click a row, or open a reference, to see the entry: its journal reference, to copy; whose account, what was done, how it ended, when and by whom; and, under **{{ui:admin.identityWriteJournal.priorStateTitle}}**, each field the directory held just before the write, under the directory's own name. **{{ui:admin.identityWriteJournal.priorStateCopy}}** copies the whole capture as it was stored.

## What you can do

Read. The journal cannot be changed or deleted.

To reverse a disable, re-enable the account in your directory, re-applying the fields under {{ui:admin.identityWriteJournal.priorStateTitle}}. If the person should not be disabled again, protect the account on [{{ui:admin.identityAccounts.title}}](identity-accounts.md), or correct their record in your HR system.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.identityWriteJournal.empty}}** | Inflect has never written to your directory | Nothing. This is what a workspace in dry run looks like |
| **{{ui:admin.identityWriteJournal.loadFailed}}** | The journal did not load | Reload the page |
| **{{ui:admin.identityWriteJournal.unsettledLoadFailed}}** | The page could not check for writes that never reported back | Reload the page. Until it loads, do not read the absence of the list as "nothing outstanding" |
| A message that no journal entry has the reference you entered | The reference is not in this workspace's journal | Check it was copied whole, from this workspace's notification |
| **{{ui:admin.identityWriteJournal.entryLoadFailed}}** | The entry did not load | Try again |
| **{{ui:admin.identityWriteJournal.forbidden}}** | You are not an Owner | Ask an Owner |

## Related

- [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md), whose decisions carry the journal reference of each write.
- [{{ui:admin.writeLadder.title}}](identity-write-policy.md), where writing to the directory is switched on.
