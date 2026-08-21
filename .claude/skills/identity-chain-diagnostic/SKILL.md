---
name: identity-chain-diagnostic
description: Diagnose why the JML identity chain produced nothing — an empty leaver-passes page, a sync that seemed to work, missing account links, or a leaver that was never acted on. Use when identity sync, account linking, or a leaver pass appears not to have run or to have found nothing.
---

# Why the identity chain produced nothing

**At least eight distinct causes present identically as an empty page.** The
product cannot distinguish them for you, and several of them look like the
feature is broken when a safety rail is working correctly. Do not guess from the
UI; the whole point of this procedure is that the UI is ambiguous here.

## Read this first

**Check state, do not recite behaviour.** Every step below tells you to *look at
something* rather than asserting what the code does. That is deliberate: the
descriptions go stale, the checks do not. Where a step names a code path, open it
and confirm before relying on it — this file is a map, not a source of truth.

**An empty result is ambiguous.** Zero rows means both "ran and found nothing"
and "never ran". Every step below is written to distinguish those two; if you
find yourself concluding from an absence alone, you have skipped a step.

## Step 1 — find which layer is empty

This one query tells you which branch to take. Run it before anything else.

On the production VM (counts only — never echo `.env.prod` or the Redis
password):

```bash
gcloud compute ssh inflect-compliance --zone europe-west1-b --command \
'sudo docker exec inflect-postgres-1 psql -U postgres -d inflect_compliance -t -A -F"|" -c "
SELECT '"'"'connections'"'"',  count(*) FROM \"IntegrationConnection\" WHERE \"isEnabled\"
UNION ALL SELECT '"'"'accounts'"'"',     count(*) FROM \"ConnectedIdentityAccount\"
UNION ALL SELECT '"'"'links'"'"',        count(*) FROM \"IdentityAccountLink\"
UNION ALL SELECT '"'"'employees'"'"',    count(*) FROM \"Employee\"
UNION ALL SELECT '"'"'terminated'"'"',   count(*) FROM \"Employee\" WHERE status = '"'"'TERMINATED'"'"'
UNION ALL SELECT '"'"'settingsRows'"'"', count(*) FROM \"TenantSecuritySettings\";
"'
```

Then branch on the **first** row that is zero or wrong:

| Finding | Go to |
| --- | --- |
| `settingsRows` = 0, or the tenant's leaver mode is not `DRY_RUN` | Step 2 |
| `connections` = 0, or more than one enabled for the same provider | Step 3 |
| `accounts` = 0 | Step 4 |
| `terminated` = 0 | Step 5 |
| `links` = 0 but accounts and terminated are both > 0 | **Step 6 — most common** |
| everything non-zero and a pass row exists | Step 8 |
| everything non-zero and no pass row at all | Step 7 |

## Step 2 — the ladder is the silent one

Check the tenant's `identityLeaverMode`. No settings row at all resolves to
`DISABLED`.

**This is the only failure that records nothing on the leaver-passes page.** Both
ladder refusals return before writing an `IntegrationExecution` row, so an empty
page here is indistinguishable, from inside the product, from a dead worker. They
do emit a metric and a log line — check the worker log for a clamp warning if you
need positive confirmation rather than an absence.

Fix: set the direction to Dry run at `/t/<slug>/admin/identity-write-policy`
(owner-gated, linked from Integrations as **Write policy**).

Note a stored mode *above* `DRY_RUN` fails the same way. The clamp is a source
constant; storing `PROPOSE` or `AUTOMATIC` is permitted and every pass then
refuses `MODE_ABOVE_CLAMP`.

## Step 3 — connection count, not connection health

The daily dispatcher enumerates enabled connections whose provider is writable
and fans out per distinct (tenant, provider).

- **Zero enabled** → no unit is dispatched at all. No pass, no refusal, no row.
  The refusal you might expect to see is unreachable from the scheduled path.
- **Two or more enabled for one provider** → every pass refuses
  `AMBIGUOUS_CONNECTION`, permanently, while still reporting sensible candidate
  counts. It reads as the product being obstinate rather than as a config error.

Confirm by provider, not just by total count.

## Step 4 — the roster is empty

Accounts come only from the sync. Check, in order:

1. **Did a sync run?** Look for the connection's executions, not for a green
   banner. The save/sync banner takes its colour from wired control-check
   failures, so a failed directory read can render as success reading 0 accounts.
2. **Do the credentials work?** The "Test connection" button is not a valid
   signal — it sends no secret and fails on a correct connection. Judge by
   whether the roster page has rows.
3. **Did enumeration complete?** A directory above the account cap returns
   partial, which also blocks Step 6.

## Step 5 — nothing is terminated

A leaver is exactly `Employee.status = 'TERMINATED'`. There is no separate leaver
flag, and no HRIS requirement in the query — a MANUAL employee counts.

If there are employees but none terminated, note there is **no update path** for
an employee's status outside HRIS sync. An existing active employee cannot be
edited to terminated through any route, and work email is unique per tenant.

## Step 6 — links are empty (the usual answer)

Accounts exist, terminated employees exist, and there are still no links.

**The manual "Sync now" button does not create links.** The route calls the sync
usecase; the reconcile lives only in the job wrapper. So the roster fills, looks
correct, and no link is ever written.

Then check, in order:

1. **Did the scheduled sync reach a complete status?** Reconcile is gated on it.
   Partial or errored syncs create no links, silently.
2. **Do the addresses match exactly?** Matching is exact, case- and
   whitespace-normalised, `Employee.workEmail` against the account email, with no
   fuzzy or name fallback. For Entra the account email is the Graph `mail`
   attribute falling back to `userPrincipalName` — copy it from the roster page
   rather than assuming which one the directory returned.
3. **Is the address unique?** Two employees sharing one address produces no link.
4. **Was the employee created after the sync ran?** The reconcile runs inside the
   sync job, so an employee added afterwards is not linked until the next one.

## Step 7 — nothing ran at all

Everything is populated and there is still no pass row. Confirm the machinery is
alive rather than inferring it:

```bash
gcloud compute ssh inflect-compliance --zone europe-west1-b --command \
"sudo docker logs inflect-worker-1 2>&1 | head -40"
```

Look for the repeatable registration lines at boot and for the two identity
dispatch job names among them. A missing registration and a job that has simply
not come due yet look the same in a tail of recent logs — read the boot lines, not
the tail.

There is **no manual trigger for a leaver pass** in the product: no route, no
button, no script. Waiting for the next scheduled run is the supported path.

## Step 8 — a pass exists; read it correctly

The page renders sentences, not enum names. Do not grep the UI for status
constants.

Then read the per-decision outcomes. Two are commonly mistaken for faults:

- **`ALREADY_DISABLED`** — checked *before* the write-target rail, so an account
  that last synced as suspended or deprovisioned returns silently, with no email.
  Not a failure; the account was already off.
- **`REFUSED_TARGET`** — the product refuses to disable an account unless it has
  positively observed that the account is cloud-mastered. An absent
  on-premises-sync flag maps to "never observed", not to "cloud-only". The refusal
  advises running a sync first, which is unactionable if the sync already
  succeeded and the flag simply is not in the directory's response. **This is the
  rail working**, refusing to guess about a directory it could not read.

Also: a dry run is **not** side-effect free. Several refusal outcomes notify every
active owner and admin on the tenant.

## When you finish

If the cause was not on this list, add it — with the check that would have found
it, not a description of the bug. A step that says "look at X" survives the code
changing; a step that says "X is true" does not.
