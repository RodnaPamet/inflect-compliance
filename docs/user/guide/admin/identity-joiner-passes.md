---
route: /t/[tenantSlug]/admin/identity-joiner-passes
---

# {{ui:admin.joinerPasses.title}}

The {{ui:admin.joinerPasses.title}} page lists every nightly pass that looks for new starters: who HR reported as joining, the directory account the pass would have created for each, or did create, and why it held back from the rest. Only an Owner can read it.

## Where to find it

The page has no link in the app yet. Open its address, `/admin/identity-joiner-passes` in your workspace. The breadcrumb reads **{{ui:admin.integrations.title}}** › **{{ui:admin.joinerPasses.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the passes and their decisions | Owner |

Anyone else who opens the page sees **{{ui:admin.joinerPasses.forbidden}}**

## What it is for

{{ui:admin.joinerPasses.intro}} The joiner direction is set on the [{{ui:admin.writeLadder.title}}](identity-write-policy.md) page, separately from leavers.

## What you see

**The passes.** One row per pass, newest first:

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.colProvider}} | The directory the pass worked on |
| {{ui:admin.integrations.colStatus}} | How the pass ended: it ran, it ran and refused, or it failed |
| {{ui:admin.joinerPasses.colMode}} | The step it ran at: dry run or automatic |
| {{ui:admin.joinerPasses.colStarters}} | How many new starters HR reported |
| {{ui:admin.joinerPasses.colWouldCreate}} | How many accounts it would create, and how many it did |
| {{ui:admin.joinerPasses.colRan}} | When it ran |

**{{ui:admin.joinerPasses.decisionsTitle}}.** Click a pass to see one row per starter below the table, with the pass's refusal above them if it refused:

| Column | What it shows |
| --- | --- |
| {{ui:admin.joinerPasses.colOutcome}} | Whether the account was planned, created, or held back |
| {{ui:admin.joinerPasses.colIntendedAddress}} | The address the new account would have, or has |
| {{ui:admin.joinerPasses.colRosterAddress}} | The work email HR holds for the person |
| {{ui:admin.joinerPasses.colReason}} | Why it was held back, for example because the address is already taken |

## What you can do

Read. The page changes nothing; the passes run every night at 04:30 UTC.

Before you widen joiners to automatic, check that the intended addresses are the ones IT would have chosen, and that the people held back were held back for a good reason. Accounts are created only through a Microsoft Entra ID connection that has been granted account creation; an Active Directory connection never creates accounts.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.joinerPasses.empty}}** | No joiner pass has run. The direction may be off | Turn on a dry run on the [{{ui:admin.writeLadder.title}}](identity-write-policy.md) page |
| **{{ui:admin.joinerPasses.noDecisions}}** | The pass found no new starter | Nothing |
| **{{ui:admin.joinerPasses.loadFailed}}** | The passes did not load | Reload the page |

## Related

- [{{ui:admin.writeLadder.title}}](identity-write-policy.md), where the joiner direction is switched on and widened.
- [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md), the same for leavers.
- [{{ui:admin.identityWriteJournal.title}}](identity-write-journal.md), every write made to your directory.
