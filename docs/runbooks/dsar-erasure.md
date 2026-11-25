# Running a DSAR erasure

**The erasure is irreversible.** It hard-deletes the person's `User` row,
pseudonymizes their audit rows and deletes every kept Managed Agents session in
every workspace they belonged to. Read the whole page before `--confirm`.

The command is `scripts/dsar-erase-user.ts` (`npm run dsar:erase-user`, #5802,
owner decision 2026-11-25). It has no HTTP route, and nothing in the product
calls it. What it erases and keeps is described in `docs/dsar.md`.

## Before you run it

Each of these is yours to check. The command takes a user id and nothing else,
so it cannot check any of them for you.

1. **The request is an ERASURE request, VERIFIED at least 24 hours ago.** The
   24-hour cooling-off (`DSAR_COOLING_OFF_HOURS`) lets the person cancel.
2. **No rejection criterion applies** (`evaluateDsarRejection` in
   `src/lib/dsar.ts`): `LAST_OWNER`, `OUTSTANDING_BALANCE`, `LEGAL_HOLD`.
3. **You have the person's user id.** Find it in the admin console or the
   database. Never pass an e-mail address: the command refuses one, and does
   not print it back.
4. **Every membership is removed**, in every workspace and every status. A
   `TenantMembership` row refuses the hard delete (`ON DELETE RESTRICT`), and
   the plan lists it as a blocker. Remove a member from the workspace's members
   page (a deactivated member is still a row).

## Run it

The command needs the environment the application runs with: a `DATABASE_URL`
whose role is NOT `app_user` (the audit trail's UPDATE is revoked from
`app_user`, and the plan refuses a view that row-level security narrows), and
the encryption keys, because the clean-up decrypts each workspace connection's
key.

```bash
# 1. The plan. Reads only; writes nothing.
npm run dsar:erase-user -- --user <userId>

# 2. Only when the plan is clean and the checks above hold:
npm run dsar:erase-user -- --user <userId> --confirm
```

Exit codes: `0` done (or the plan printed), `1` refused, `2` a usage refusal
(a missing or malformed `--user`, an e-mail address, an unknown argument, a
`sys_` id).

## Reading the plan

Every line is ids and counts.

| Line | Meaning |
| --- | --- |
| `workspaces where the subject held a membership: N` | The workspaces whose kept Managed Agents sessions are deleted after the erasure, each with the evidence that put it there: `OWN_ACTION` (a row the person wrote), `MEMBERSHIP_RECORD` (a row a membership writer wrote naming them: SCIM, the org-admin fan-out, platform-admin tenant creation), `ORG_TENANT_FANOUT` (an org audit row listing the workspace). |
| `undecided membership evidence: N` | A row naming the person's membership under an action the command does not classify. `--confirm` is refused while any is listed: classify the action in `MEMBERSHIP_RECORD_ACTIONS` (`src/app-layer/jobs/dsar-erasure-workspaces.ts`) first. |
| `membership writers that record no row naming the subject` | Always printed. A workspace the person joined ONLY through one of these, and never acted in, is not in the list above. If you know of one, the erasure does not reach its kept sessions. |
| `references refusing the delete: N` | What `planErasure` found. `--confirm` is refused while any is listed. |

A blocker's reason says whether you can resolve it:

- `RESTRICT_REFERENCE` — a row you can remove or reassign (a membership, a
  notification), then re-run. A `DataSubjectRequest.userId` row is one too: the
  DSAR register's own record of the request refuses the delete.
- `IMMUTABLE_AUDIT_TRAIL` — the org audit trail names the person. The erasure
  is not possible today.
- `STAMPED_DECISION_ACTOR` — a recorded decision names the person as its actor.
  The erasure is not possible today.

## After `--confirm`

The command prints the receipt (`user deleted`, audit rows pseudonymized,
erasure records written) and one line per clean-up record it opened: tenant,
connection, status. A record left `OPEN` (the workspace was unreachable, the key
was refused, a session was still running) is retried by the `data-lifecycle`
job until it is `DONE`, and ends `ABANDONED` after 30 days with an alert.

If the workspaces handed to the clean-up differ from the plan, the command says
so: the erasure reads them again inside its own transaction, and that read is
the one used.

## What it records

Exactly `eraseUser`'s record: one `ERASURE_EXECUTED` audit entry per workspace
whose audit trail it pseudonymized, naming nobody, and one `ManagedAgentsCleanup`
record per workspace connection, naming the tenant and the connection. Nothing
the command writes or prints names the person.
