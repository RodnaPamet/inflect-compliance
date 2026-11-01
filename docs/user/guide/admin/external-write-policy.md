---
route: /t/[tenantSlug]/admin/external-write-policy/[connectionId]
---

# {{ui:admin.externalWriteLadder.title}}

The {{ui:admin.externalWriteLadder.title}} page decides, for one external tool server connection, whether agents may change configuration in that system, and how far. Like the directory write policy, it widens one step at a time, and only an Owner can see or change it.

## Where to find it

Open **Agents**, then **{{ui:admin.externalWriteLadder.parentLabel}}**, and follow the write-policy link on the connection. The breadcrumb reads **{{ui:admin.externalWriteLadder.parentLabel}}** › **{{ui:admin.externalWriteLadder.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the policy | Owner |
| Widen or narrow it | Owner |

Anyone else who opens the page sees **{{ui:admin.externalWriteLadder.forbidden}}**

## What it is for

An agent with a write tool on an external system, such as granting a permission in a cloud account, could change that system on its own. This page sets how much of that it may do, per connection, and lets you watch it before you trust it.

## What you see

A card with the connection's name and its current step:

| Step | What an agent's write does |
| --- | --- |
| **{{ui:admin.externalWriteLadder.mode.DISABLED}}** | Nothing. Writes are refused and not recorded |
| **{{ui:admin.externalWriteLadder.mode.DRY_RUN}}** | Recorded as what the agent would change, and not sent |
| **{{ui:admin.externalWriteLadder.mode.PROPOSE_ONLY}}** | Queued as a proposal. Nothing reaches the system until a person accepts it |
| **{{ui:admin.externalWriteLadder.mode.AUTOMATIC}}** | Sent without asking |

The card says since when the connection has been on its step, and how long it must stay there before it can widen. Widening also needs evidence from the current step: at {{ui:admin.externalWriteLadder.mode.DRY_RUN}}, at least one recorded dry-run write, and at {{ui:admin.externalWriteLadder.mode.PROPOSE_ONLY}}, at least one approved proposal. The card says how many it needs and how many it has so far. When this build of Inflect will not act above a certain step, a note says so, and the steps above it are unavailable.

Two links lead to where each step's effect shows: **{{ui:admin.externalWriteLadder.passportLink}}**, the connection's page with its write step and pairings, and **{{ui:admin.externalWriteLadder.proposalsLink}}**, where proposals wait for a person.

## What you can do

### Widen

Click **Widen to** the next step, read what it means, and confirm. A connection moves one step at a time, and only after it has spent the stated number of days on its current step with the evidence the card names. Until then the button is greyed out, with the reason under it in words: for example how many days are left, or how many approved proposals there are of how many needed.

Confirming {{ui:admin.externalWriteLadder.mode.AUTOMATIC}} says what still stands between the agent and the system: it changes the system only through a parameter set an Owner approved, with the system's state captured first, and a write with neither is refused.

### Narrow

Click **Narrow to** the step below. It takes effect at once.

## What happens next

- Every change to the policy adds an entry to the workspace's audit log.
- What the agents recorded or proposed under each step appears on the agents' pages, and an accepted proposal is sent to the system then.
- Even at automatic, a write is sent only when it matches a parameter set an Owner has approved, and with the system's state before it captured, so the change can be checked and reversed.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.externalWriteLadder.forbidden}}** | You are not an Owner | Ask an Owner |
| A reason under a greyed-out widen button | The connection cannot widen yet | Wait, or do what the reason names |
| **{{ui:admin.externalWriteLadder.saveError}}**, or a reason from the server | The change was not made | Read the reason, and try again |
| **{{ui:admin.externalWriteLadder.loadError}}** | The policy did not load. The page keeps its title, breadcrumb and links | Reload the page |

## Related

- [{{ui:admin.writeLadder.title}}](identity-write-policy.md), the same ladder for your identity directory.
- [{{ui:admin.integrations.outcome.title}}](integration-connection.md), where an external tool server's integration passport shows its write step and pairings.
