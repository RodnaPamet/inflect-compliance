---
route: /t/[tenantSlug]/admin/identity-write-journal
---

# {{ui:admin.identityWriteJournal.title}}

The {{ui:admin.identityWriteJournal.title}} is the record of every change Inflect has made to your identity directory: each account it disabled or created, when, how it ended, and the account's state just before. Only an Owner can read it, because each entry is about one of your people's accounts.

## Where to find it

The page has no link in the app yet. Open its address, `/admin/identity-write-journal` in your workspace. The breadcrumb reads **{{ui:admin.integrations.title}}** › **{{ui:admin.identityWriteJournal.breadcrumb}}**.

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

**{{ui:admin.identityWriteJournal.unsettledTitle}}.** Shown only when there are any: writes that were attempted more than an hour ago and never reported an outcome. Check each in your directory.

**{{ui:admin.identityWriteJournal.historyTitle}}.** Every write, newest first:

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.colProvider}} | The directory written to |
| {{ui:admin.identityWriteJournal.colAction}} | What was done: disabling an account, or creating one |
| {{ui:admin.integrations.colStatus}} | How it ended: applied, failed, pending, not confirmed either way, or reverted |
| {{ui:admin.identityWriteJournal.colAttempted}} | When it was attempted |
| {{ui:admin.identityWriteJournal.colActor}} | Who started the pass, or **{{ui:admin.identityWriteJournal.actorScheduled}}** for the nightly pass |

**{{ui:admin.identityWriteJournal.capturedTitle}}.** Click a row to see its journal reference, to copy, and the account's state as it was just before the write.

## What you can do

Read. The journal cannot be changed or deleted.

To reverse a disable, re-enable the account in your directory, using the captured state as your guide. If the person should not be disabled again, protect the account on [{{ui:admin.identityAccounts.title}}](identity-accounts.md), or correct their record in your HR system.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.identityWriteJournal.empty}}** | Inflect has never written to your directory | Nothing. This is what a workspace in dry run looks like |
| **{{ui:admin.identityWriteJournal.loadFailed}}** | The journal did not load | Reload the page |
| **{{ui:admin.identityWriteJournal.forbidden}}** | You are not an Owner | Ask an Owner |

## Related

- [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md), whose decisions carry the journal reference of each write.
- [{{ui:admin.writeLadder.title}}](identity-write-policy.md), where writing to the directory is switched on.
