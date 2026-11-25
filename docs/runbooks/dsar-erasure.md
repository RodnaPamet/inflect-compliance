# Running a DSAR erasure

**The erasure is irreversible.** It hard-deletes the person's `User` row,
pseudonymizes their audit rows and deletes every kept Managed Agents session in
every workspace they belonged to. Read the whole page before you confirm.

The command is `scripts/dsar-erase.ts` (#5802, #5940; owner decisions
2026-11-25). It fulfils a **DSAR register request**: it takes the request, never
a person, and reads the subject from it. It has no HTTP route, and nothing in
the product calls it. What it erases and keeps is described in `docs/dsar.md`.

- **Production** runs it through the `VM apply` workflow, with two fixed
  actions: `dsar-erase-preflight` and `dsar-erase`. They take no parameter.
- **Locally**, it runs as `npm run dsar:erase -- --request <requestId>`.

## Before you run it

The command checks the first four steps itself and refuses with a named
reason. The last two are yours to check.

1. **The request is on the register as an ERASURE request.** A person who asked
   outside the product is recorded on `/admin/dsar-requests` first. Every
   erasure needs a register row; the command has no way to erase a person
   without one.
2. **It was VERIFIED at least 24 hours ago.** The 24-hour cooling-off
   (`DSAR_COOLING_OFF_HOURS`) lets the person cancel. Refusals:
   - before then, `COOLING_OFF`;
   - before verification, `NOT_VERIFIED`.
3. **An admin STARTED it (VERIFIED → IN_PROGRESS) on the register.** Do this
   while the person is still a member. That admin stays the request's
   accountable `handledById`. A VERIFIED request is refused with
   `NOT_IN_PROGRESS`.
4. **Every membership is removed**, in every workspace and every status.
   - A `TenantMembership` row refuses the hard delete (`ON DELETE RESTRICT`),
     and the plan lists it as a blocker.
   - Remove a member from the workspace's members page; a deactivated member is
     still a row.
   - Remove members AFTER starting the request. Once the person is no longer a
     member, the register no longer shows the request to anybody.
5. **Outstanding balance and legal hold.** `evaluateDsarRejection` applies
   `LAST_OWNER` from the person's memberships. The product holds no balance and
   no legal hold for a person, so the plan prints both as the operator's check
   every time.
6. **Production only: exactly one request is due.** The actions act on the ONE
   request that is due: an ERASURE request that is verified, past its
   cooling-off, not completed, rejected or cancelled, and whose subject still
   exists. They refuse when none is due (`NO_DUE_REQUEST`) or more than one is
   (`MORE_THAN_ONE_DUE`), so fulfil several one at a time.

## Run it in production

1. Dispatch **VM apply** from `main` with the action `dsar-erase-preflight`.
   The owner approves it in the `production` environment. It runs
   `node dist/dsar-erase.mjs --due` in the app container and writes nothing.
2. Read the run's log:
   - the request id;
   - the plan;
   - the exit status. A refusal fails the run.
3. Check that the id is the request you mean to fulfil.
4. Dispatch **VM apply** with `dsar-erase`. The owner approves it. It runs the
   same preflight again, then — only if that passed — `--due --confirm`.

Both actions select the due request afresh, so `dsar-erase` acts on whatever
request is due when it runs. Check its log's `request` line: it names the
request it erased. The erasure also decides again inside its own transaction,
so a request cancelled or changed in between is refused, not erased.

The log is public. It carries only lines the command prints, which start with
`[dsar-erase]` and hold ids, statuses, timestamps and counts. Anything else the
container prints is counted and withheld (`dsar_lines` in
`deploy/vm-apply/remote.sh`). A failure from outside this repository's code is
printed as its class and code only.

The app image must carry `dist/dsar-erase.mjs`, which images built after #5940
do. The action checks this first and refuses on an older image.

## Run it locally

The command needs the environment the application runs with:

- **A `DATABASE_URL` whose role is NOT `app_user`.** The audit trail's UPDATE
  is revoked from `app_user`, and the plan refuses a view that row-level
  security narrows.
- **The encryption keys.** The clean-up decrypts each workspace connection's
  key.

```bash
# 1. The plan. Reads only; writes nothing.
npm run dsar:erase -- --request <requestId>

# 2. Only when the plan is clean and steps 5 and 6 above hold:
npm run dsar:erase -- --request <requestId> --confirm
```

`--due` in place of `--request <id>` is what the production actions run.

Exit codes:

- `0`: done, or a clean plan printed.
- `1`: refused, and the reason is named.
- `2`: a usage refusal: a missing or malformed `--request`, an e-mail address,
  an unknown argument such as the retired `--user`, or both `--request` and
  `--due`.

## Reading the plan

Every line is ids and counts.

| Line | Meaning |
| --- | --- |
| `request <id> type=… status=… verified=… subject=<userId>` | The request, and the subject read from it. |
| `refused: <REASON>` | One of `REQUEST_NOT_FOUND`, `NOT_AN_ERASURE`, `ALREADY_COMPLETED`, `REQUEST_REJECTED`, `REQUEST_CANCELED`, `NOT_VERIFIED`, `COOLING_OFF`, `NOT_IN_PROGRESS`, `SUBJECT_ALREADY_ERASED`, `REJECTION_CRITERION (last_owner)`, `SYSTEM_USER`, `NO_DUE_REQUEST`, `MORE_THAN_ONE_DUE`. Nothing was written. |
| `workspaces where the subject held a membership: N` | The workspaces whose kept Managed Agents sessions are deleted after the erasure, each with its evidence (below). |
| `undecided membership evidence: N` | A row naming the person's membership under an action the command does not classify. The erasure is refused while any is listed. Classify the action in `MEMBERSHIP_RECORD_ACTIONS` (`src/app-layer/jobs/dsar-erasure-workspaces.ts`) first. |
| `what no row names the subject in` | Always printed. A workspace reached only this way, where the person never acted, is not in the list above (below). |
| `references refusing the delete: N` | What `planErasure` found. The erasure is refused while any is listed. |
| `not checked by the product` | Outstanding balance and legal hold: yours. |

The evidence for a workspace is one of these:

- `OWN_ACTION`: a row the person wrote.
- `MEMBERSHIP_RECORD`: a row a membership writer wrote naming them: SCIM, the
  org-admin fan-out, or platform-admin tenant creation.
- `TARGET_RECORD`: a removal or deactivation naming them as
  `detailsJson.targetUserId`.
- `ORG_TENANT_FANOUT`: an org audit row listing the workspace.

What no row names the subject in:

- **A removal written before #5940.** It carries no `targetUserId`. It matters
  for a membership joined through credentials signup, SSO JIT, an org admin
  creating a tenant, the org fan-out into a new tenant, or the staging seed. If
  you know of such a workspace, the erasure does not reach its kept sessions.
- **The tenant purge.** It deletes a purged tenant's memberships, but it runs
  its own clean-up first.

A blocker's reason says whether you can resolve it:

- `RESTRICT_REFERENCE` — a row you can remove or reassign (a membership, a
  notification), then re-run.
- `IMMUTABLE_AUDIT_TRAIL` — the org audit trail names the person. The erasure
  is not possible today.
- `STAMPED_DECISION_ACTOR` — a recorded decision names the person as its actor.
  The erasure is not possible today.

The DSAR register is not a blocker: its rows survive the erasure, unlinked
(below).

## After the erasure

The command prints three things:

- **The receipt:** `user deleted`, audit rows pseudonymized, erasure records
  written.
- **The register line:** `register: request completed=<id> requests cleared=N`.
- **One line per clean-up record it opened:** tenant, connection, status.

A record left `OPEN` is retried by the `data-lifecycle` job until it is `DONE`.
A record stays `OPEN` when the workspace was unreachable, the key was refused,
or a session was still running. After 30 days it ends `ABANDONED` with an alert.

If the workspaces handed to the clean-up differ from the plan, the command says
so: the erasure reads them again inside its own transaction, and that read is
the one used.

## What it records

These are `eraseUser`'s records:

- **One `ERASURE_EXECUTED` audit entry** per workspace whose audit trail it
  pseudonymized. It names nobody.
- **One `ManagedAgentsCleanup` record** per workspace connection, naming the
  tenant and the connection.
- **The register request, moved to `COMPLETED`.** It keeps its `completedAt`,
  dates and handler.

Every request of the person's loses `fulfilmentNotes` and `exportUrl`, and
`userId` goes to NULL with the deleted `User` row. No tenant `DSAR_COMPLETED`
row is written.

An erased request is evidence in the database only. The register shows a
request through its subject's membership, so no tenant sees it any more.
Nothing the command writes or prints names the person.
