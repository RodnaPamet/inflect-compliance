---
route: /t/[tenantSlug]/admin/integrations/[connectionId]/reconciliation
---

# {{ui:admin.integrations.legacyQueue.title}}

The {{ui:admin.integrations.legacyQueue.title}} lists the accounts in a legacy application that Inflect could not match to a person with certainty. A reviewer looks at each one, sees why the matching suggested whom it did, and confirms the match or puts the account off for later.

## Where to find it

On a legacy application connection's own page (see [{{ui:admin.integrations.outcome.title}}](integration-connection.md)), click **{{ui:admin.integrations.legacyRuns.openQueue}}** under **{{ui:admin.integrations.legacyRuns.lastMatch}}**. The breadcrumb reads **{{ui:admin.integrations.legacyQueue.crumbIntegrations}}** › **{{ui:admin.integrations.legacyQueue.crumbConnection}}** › **{{ui:admin.integrations.legacyQueue.title}}**, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the queue | Owner, Admin |
| Confirm a match, or defer an account | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An Admin whose custom role does not allow confirming matches can open the queue, but a confirmation is refused.

## What it is for

An access review of a legacy application asks, for every account, whose it is. Matching links most accounts to people in your HR records on strong evidence, such as an exact email address or an employee number. Weaker evidence, such as a similar name or a naming convention, only ever suggests a person: a reviewer decides. This queue is where they decide, so that the access review is built on links a person has confirmed.

## What you see

The queue always shows the latest successful match on this connection. The line under the breadcrumb counts the accounts still waiting for a decision.

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.legacyQueue.colAccount}} | The account's key in the application, such as its login |
| {{ui:admin.integrations.legacyQueue.colOutcome}} | **{{ui:admin.integrations.legacyQueue.outcomeSUGGESTED}}**: one person scored best on weak evidence. **{{ui:admin.integrations.legacyQueue.outcomeAMBIGUOUS}}**: two or more people scored the same. **{{ui:admin.integrations.legacyQueue.outcomeUNMATCHED}}**: nobody matched |
| {{ui:admin.integrations.legacyQueue.colTopCandidate}} | The person who scored best, or **{{ui:admin.integrations.legacyQueue.noCandidates}}** |
| {{ui:admin.integrations.legacyQueue.colScore}} | Their score |
| {{ui:admin.integrations.legacyQueue.colReason}} | **{{ui:admin.integrations.legacyQueue.reasonUNDECIDED}}**, or that an earlier decision that the account belongs to someone outside the organization has expired |

Filter by **{{ui:admin.integrations.legacyQueue.colOutcome}}** or **{{ui:admin.integrations.legacyQueue.colReason}}** in the toolbar, and choose which columns to show.

## What you can do

### Look at the evidence

Click **{{ui:admin.integrations.legacyQueue.review}}** on a row. A panel lists every candidate with their score, each piece of evidence that scored, and any veto, a reason the match should not be trusted, such as an account created before the person joined. Check the vetoes first: a vetoed candidate is the one most likely to look right and be wrong.

### Confirm a match

Click **{{ui:admin.integrations.legacyQueue.actConfirm}}** on the row. The account is linked to its top candidate, the page says **{{ui:admin.integrations.legacyQueue.decided}}**, and the row leaves the queue. The next match treats that link as certain.

To confirm several at once, select their rows and click **{{ui:admin.integrations.legacyQueue.actConfirm}}** in the bar that appears. Only rows whose top candidate is clearly ahead of the next are confirmed; the page counts how many were confirmed and how many refused.

### Defer an account

Click **{{ui:admin.integrations.legacyQueue.actDefer}}** to leave it for later. It stays in the queue for the next match.

## What happens next

- Decisions are recorded against the match they were made on. If a newer match has replaced it, a decision is refused with **{{ui:admin.integrations.legacyQueue.superseded}}**
- The access review of the application is built from the latest complete read, with the links confirmed here.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.integrations.legacyQueue.empty}}** | Every account on the latest match has an answer, or no match has finished yet | If no match has run, go back and click **{{ui:admin.integrations.legacyRuns.matchButton}}** |
| **{{ui:admin.integrations.legacyQueue.superseded}}** | A newer match replaced the one on screen | Reload the page |
| A message that starts **Could not record the decision** | The decision was refused; the message says why | Fix what it names, or ask an Owner or Admin |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.integrations.outcome.title}}](integration-connection.md), where the application's accounts are read and matched.
- [{{ui:admin.integrations.title}}](integrations.md), every connection in the workspace.
