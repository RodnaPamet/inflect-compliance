---
route: /t/[tenantSlug]/admin/integrations/[connectionId]/reconciliation
---

# {{ui:admin.integrations.legacyQueue.title}}

The {{ui:admin.integrations.legacyQueue.title}} lists the accounts in a legacy application that Inflect could not match to a person with certainty. A reviewer looks at each one, sees why the matching suggested whom it did, and records a decision: whose account it is, that it belongs to no person, that its owner is outside the organization, that nobody can say, or that it waits for later.

## Where to find it

On a legacy application connection's own page (see [{{ui:admin.integrations.outcome.title}}](integration-connection.md)), click **{{ui:admin.integrations.legacyRuns.openQueue}}** under **{{ui:admin.integrations.legacyRuns.lastMatch}}**. The breadcrumb reads **{{ui:admin.integrations.legacyQueue.crumbDashboard}}** › **{{ui:admin.integrations.legacyQueue.crumbAdmin}}** › **{{ui:admin.integrations.legacyQueue.crumbIntegrations}}** › the connection's name › **{{ui:admin.integrations.legacyQueue.title}}**, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the queue and read the evidence | Owner, Admin |
| Record a decision | Owner, Admin, unless a custom role takes away confirming matches |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. A person who can open the queue but not decide sees the accounts and their evidence with no decision buttons.

## What it is for

An access review of a legacy application asks, for every account, whose it is. Matching links most accounts to people in your HR records on strong evidence, such as an exact email address or an employee number. Weaker evidence, such as a similar name or a naming convention, only ever suggests a person: a reviewer decides. This queue is where they decide, so that the access review is built on links a person has confirmed. A service account or a contractor's account would come back every cycle if it could not be answered, so the queue offers an answer for those too.

## What you see

The queue always shows the latest successful match on this connection. The line under the breadcrumb counts the accounts still waiting for a decision.

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.legacyQueue.colAccount}} | The account's key in the application, such as its login |
| {{ui:admin.integrations.legacyQueue.colOutcome}} | **{{ui:admin.integrations.legacyQueue.outcomeSUGGESTED}}**: one person scored best on weak evidence. **{{ui:admin.integrations.legacyQueue.outcomeAMBIGUOUS}}**: two or more people scored the same. **{{ui:admin.integrations.legacyQueue.outcomeUNMATCHED}}**: nobody matched |
| {{ui:admin.integrations.legacyQueue.colTopCandidate}} | The person who scored best, by name and work email, or **{{ui:admin.integrations.legacyQueue.noCandidates}}**. A candidate HR no longer holds reads **{{ui:admin.integrations.legacyQueue.unknownPerson}}** |
| {{ui:admin.integrations.legacyQueue.colScore}} | Their score |
| {{ui:admin.integrations.legacyQueue.colReason}} | **{{ui:admin.integrations.legacyQueue.reasonUNDECIDED}}**, or that an earlier decision that the account belongs to someone outside the organization has expired, with the date |

Search by account or candidate name, filter by **{{ui:admin.integrations.legacyQueue.colOutcome}}** or **{{ui:admin.integrations.legacyQueue.colReason}}** in the toolbar, and choose which columns to show.

## What you can do

### Look at the evidence

Click **{{ui:admin.integrations.legacyQueue.review}}** on a row. A panel lists every candidate by name with their score, each piece of evidence that scored, in words, such as **{{ui:admin.integrations.legacyQueue.signalKind.EMAIL_EXACT}}** or **{{ui:admin.integrations.legacyQueue.signalKind.NAME_TRANSLIT}}**, and any veto, a reason the match should not be trusted, such as **{{ui:admin.integrations.legacyQueue.vetoKind.ACCOUNT_POSTDATES_END_DATE}}**. Check the vetoes first: a vetoed candidate is the one most likely to look right and be wrong.

### Confirm the top candidate

Click **{{ui:admin.integrations.legacyQueue.actConfirm}}** on the row. A message offers **{{ui:admin.integrations.legacyQueue.undo}}** for 5 seconds; after that the account is linked to its top candidate, the page says **{{ui:admin.integrations.legacyQueue.decided}}**, and the row leaves the queue. The next match treats that link as certain.

To confirm several at once, select their rows and click **{{ui:admin.integrations.legacyQueue.actConfirm}}** in the bar that appears. Only rows whose top candidate is clearly ahead of the next are confirmed; the page counts how many were confirmed and how many refused.

### Record another decision

Open the row with **{{ui:admin.integrations.legacyQueue.review}}**. Under the evidence, **{{ui:admin.integrations.legacyQueue.decideTitle}}** offers:

| Decision | When to choose it | What you give |
| --- | --- | --- |
| **{{ui:admin.integrations.legacyQueue.decision.CONFIRM}}** | {{ui:admin.integrations.legacyQueue.decisionHint.CONFIRM}} | Which candidate, when there is more than one |
| **{{ui:admin.integrations.legacyQueue.decision.MANUAL}}** | {{ui:admin.integrations.legacyQueue.decisionHint.MANUAL}} | The **{{ui:admin.integrations.legacyQueue.decidePerson}}**, and a reason |
| **{{ui:admin.integrations.legacyQueue.decision.NON_PERSON}}** | {{ui:admin.integrations.legacyQueue.decisionHint.NON_PERSON}} | The **{{ui:admin.integrations.legacyQueue.owner}}**, and a reason |
| **{{ui:admin.integrations.legacyQueue.decision.EXTERNAL}}** | {{ui:admin.integrations.legacyQueue.decisionHint.EXTERNAL}} | The date it **{{ui:admin.integrations.legacyQueue.expiresAt}}**, from tomorrow on, and a reason |
| **{{ui:admin.integrations.legacyQueue.decision.ORPHAN}}** | {{ui:admin.integrations.legacyQueue.decisionHint.ORPHAN}} | A reason |

A reason is at least 10 characters, and is recorded with the decision. Click **{{ui:admin.integrations.legacyQueue.decideSubmit}}**. The page says **{{ui:admin.integrations.legacyQueue.decided}}** and the row leaves the queue.

### Defer an account

Click **{{ui:admin.integrations.legacyQueue.actDefer}}** to leave it for later. It stays in the queue for the next match.

## What happens next

- Decisions are recorded against the match they were made on. If a newer match has replaced it, a decision is refused with **{{ui:admin.integrations.legacyQueue.superseded}}**
- An account decided to belong to someone outside the organization comes back to the queue on the date you set.
- The access review of the application is built from the latest complete read, with the decisions recorded here.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.integrations.legacyQueue.empty}}** | Every account on the latest match has an answer | Nothing |
| **{{ui:admin.integrations.legacyQueue.emptyNoRun}}** | No match has finished on this connection yet | Go back and click **{{ui:admin.integrations.legacyRuns.matchButton}}** |
| **{{ui:admin.integrations.legacyQueue.loadError}}** | The queue could not be read | Reload the page |
| **{{ui:admin.integrations.legacyQueue.superseded}}** | A newer match replaced the one on screen | Reload the page |
| **{{ui:admin.integrations.legacyQueue.decideFailedGeneric}}**, or the server's reason | The decision was refused | Act on the reason, or ask an Owner or Admin |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.integrations.outcome.title}}](integration-connection.md), where the application's accounts are read and matched.
- [{{ui:admin.integrations.title}}](integrations.md), every connection in the workspace.
