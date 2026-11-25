# 2026-11-25 — DSAR erasure follow-ups: removals name the person, the register row survives, the command takes a request, a VM apply action (#5940)

**Commit:** `fix(dsar): …` (branch `fix/fix-5940-dsar-erasure-follow-ups`)

## Design

Four owner decisions of 2026-11-25 on #5940. The second round settled the
open points: the VM action takes no parameter, the rejection rules apply the
owner check only, completion requires IN_PROGRESS, and the surviving row is
cleared. The third round bound the erase to the preflight that showed it: the
preflight stamps the request, and the erase refuses one with no stamp under 24
hours old.

```
production:  VM apply  dsar-erase-preflight            →  --due              (plan; stamps the request it showed)
                       dsar-erase  (within 24 h)       →  --due --check      (writes nothing)
                                                          --due --confirm    (refuses an unstamped / stale request)
               vm.sh → remote.sh → compose exec -T app node dist/dsar-erase.mjs …
                                                     └─ | dsar_lines   (only `[dsar-erase] ` lines reach the log)
local:       npm run dsar:erase -- --request <id> [--check | --confirm]

scripts/dsar-erase.ts
  ├─ the request: --request <id>, or --due → readDueErasureRequests (exactly one, else refused)
  ├─ decideErasureRequest(stage): the register's refusals, at ERASE the stamp
  │     (NOT_PREFLIGHTED / PREFLIGHT_EXPIRED), then evaluateDsarRejection
  │     (LAST_OWNER from memberships; balance + hold printed as the operator's check)
  ├─ the plan: planErasure + readErasureWorkspaces (OWN_ACTION | MEMBERSHIP_RECORD | TARGET_RECORD | ORG_TENANT_FANOUT)
  │     a plan --confirm would refuse exits 1, so a passing preflight admits the write
  ├─ preflight (no flag): stampErasurePreflight — the one write, only on an admitted plan
  ├─ --check: nothing written
  └─ --confirm: eraseUser(userId, { request })
        tx: subject visible → planErasure → readErasureWorkspaces
            → re-read + decide the request at ERASE, stamp included (refuse: nothing written)
            → fulfilErasureRequestWithin: clear fulfilmentNotes/exportUrl on every request of the
              subject; IN_PROGRESS → COMPLETED by a conditional claim
            → pseudonymize → ERASURE_EXECUTED records → delete User (FK SET NULL unlinks the requests)
        after commit: Managed Agents clean-up (unchanged)
```

**Removals name the person.** `MEMBER_REMOVED` and `MEMBER_DEACTIVATED`
(`tenant-admin.ts`) and `SCIM_USER_DEACTIVATED` (`emitScimAudit`) now carry
`detailsJson.targetUserId`. `ORG_ADMIN_DEPROVISIONED` and
`ACCESS_REVIEW_DECISION_EXECUTED` already carried it. `planErasure` refuses
while any membership is left, so every erasure is preceded by a removal. That
removal finds a workspace joined through a writer that records no row at the
join.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/tenant-admin.ts` | `targetUserId` on `MEMBER_REMOVED` / `MEMBER_DEACTIVATED` |
| `src/app-layer/usecases/scim-users.ts` | `targetUserId` on `SCIM_USER_DEACTIVATED` |
| `src/app-layer/jobs/dsar-erasure-workspaces.ts` | `TARGET_RECORD` kind, `TARGET_RECORD_ACTIONS`, the third arm of the read; the remaining gaps |
| `src/app-layer/jobs/dsar-erasure-request.ts` | New: the request decision (by stage), the due read, `LAST_OWNER`, `ERASURE_PREFLIGHT_VALID_HOURS`, the stamp's writer `stampErasurePreflight`, and the register's second writer `fulfilErasureRequestWithin` |
| `src/app-layer/jobs/dsar-erasure.ts` | `eraseUser({ request })`: re-decide in the transaction, clear and complete before the delete |
| `src/app-layer/usecases/dsar-register.ts`, `DsarRegisterClient.tsx` | A null subject; the two-writer note |
| `prisma/schema/auth.prisma`, `prisma/migrations/20261125140000_dsar_request_user_set_null/` | `userId` nullable, `ON DELETE SET NULL ("userId")`; the nullable stamp column `erasurePreflightAt` |
| `scripts/dsar-erase.ts` (was `dsar-erase-user.ts`), `scripts/dsar-erase-main.ts` | The command, by request; the process entry the bundle is built from |
| `scripts/build-worker.mjs`, `package.json` | `dist/dsar-erase.mjs`; `npm run dsar:erase` |
| `deploy/vm-apply/{vm.sh,remote.sh}`, `.github/workflows/vm-apply.yml` | `dsar-erase-preflight` (`--due`, stamps), `dsar-erase` (`--due --check`, then `--due --confirm`); `dsar_lines` |
| `tests/guards/dsar-register-writers.test.ts` | The register's writers, by file; the stamp's one writer, and the erasure never clearing it |
| `tests/helpers/dsar-erasure-probe.ts` | `dataSubjectRequest` disposition: PSEUDONYMIZE |
| `docs/runbooks/dsar-erasure.md`, `docs/dsar.md`, `docs/deployment.md`, `docs/data-retention.md`, `CLAUDE.md` | The result |

## Decisions

- **The shared key is `targetUserId`.** It was already the convention on the
  DSAR, access-review and org fan-out rows, and Epic C.4 already streams it to
  the tenant's SIEM. It is an opaque id, never an e-mail. After an erasure the
  id resolves to nobody, but it stays in those rows: the audit trigger permits
  only `userId` → NULL. The e-mail that some of these rows carry in `details` or
  `detailsJson.summary` is #5950, not this change.
- **Listed, never inferred, and an unlisted key is IGNORED, not undecided.**
  `targetUserId` appears on dozens of actions about no membership: DSAR
  transitions, session revocations, MFA resets. Marking them undecided would
  refuse every erasure on its own DSAR rows. The arm is read only under a listed
  action (`$4`), so those rows are neither read nor grouped.
- **No backfill.** Removals written before #5940 carry no key, and the trail is
  immutable. They stay on the printed gap list, with the tenant purge, which
  deletes memberships naming nobody and runs its own clean-up.
  `org-tenants.ts` (tenant removal under an org) is unchanged by decision: its
  rows stay until the purge.
- **`--user` is retired.** Every erasure has a register row as its record and
  its accountable handler. An out-of-band request is recorded on the register
  first. Keeping `--user` would have left an erasure with no cooling-off and no
  rejection check, which is the gap decision 3 closed.
- **Two places decide.** The command decides on its own read, for the plan and
  the preflight's exit code. `eraseUser` re-reads and decides inside its
  transaction, because that is where the request is completed. The completion is
  a conditional claim on `(id, userId, ERASURE, IN_PROGRESS)`. A request changed
  in between is refused, or rolls the whole erasure back.
- **Refusal order** is `REQUEST_NOT_FOUND`, `NOT_AN_ERASURE`,
  `ALREADY_COMPLETED`, `REQUEST_REJECTED`, `REQUEST_CANCELED`, `NOT_VERIFIED`,
  `COOLING_OFF`, `NOT_IN_PROGRESS`, `SUBJECT_ALREADY_ERASED`, then
  `REJECTION_CRITERION`. A terminal state is named before a timing one, so a
  completed request reads as completed, not as cooling off.
- **"Due" includes VERIFIED.** The owner's definition is "verified, past its
  cooling-off, not completed/rejected/cancelled". A VERIFIED request is
  therefore due, and is then refused `NOT_IN_PROGRESS` by name rather than
  skipped in silence. A request whose subject is already erased is not due,
  because it can never be fulfilled. It stays on the register as it stands, and
  is not counted against "exactly one".
- **Clearing runs on every erasure; completing only with a request.** `eraseUser`
  without a request (tests, the probe) still clears `fulfilmentNotes` and
  `exportUrl`, because the erasure must not leave the person identifiable
  through the register. `handledById` is staff, and `rejectionReason` is a
  constant, so both stay.
- **The migration is column-scoped on a single-column FK.** It is the same action
  as a plain `SET NULL`; the column list states the retention rule's intent. The
  table has no trigger, so nothing had to admit the FK's write (contrast #5848).
  The post-condition reads `confdelsetcols`, as the earlier column-scoped
  migrations do. The fresh-database drift check stays green, because Prisma
  reads both forms as `SetNull`.
- **The bundle has its own entry file.** `require.main === module` does not
  exist in the ESM bundle, so `scripts/dsar-erase-main.ts` only calls `main`, and
  `scripts/dsar-erase.ts` only exports.
- **The public log is filtered by prefix, not by shape.** `shape` keeps compose
  resource lines and would withhold every line the command prints. `dsar_lines`
  keeps exactly the command's `[dsar-erase] ` lines. It withholds the app's
  JSON logger, whose slow-query line prints SQL parameters, and any compose
  warning. The command prints a foreign error as its class and code only.
- **The register has a third writer**, found while writing its guard:
  `dsr-legacy-decrypt.ts`, the container-start repair that rewrites values
  stored encrypted as the same values in plaintext. It is named in the guard as
  a format repair, not a writer of requests.
- **The erase is bound to the preflight that showed it** (third round). The VM
  actions take no parameter, so each picks the due request afresh; between the
  two runs the request the owner read can be cancelled and another become due.
  The preflight stamps `erasurePreflightAt` on the request it printed, as a
  conditional claim on that subject's open IN_PROGRESS erasure, and only when
  the plan would be admitted; the erase refuses `NOT_PREFLIGHTED` or
  `PREFLIGHT_EXPIRED` (older than 24 hours, or later than `now`, which only a
  clock moved back can give). The refusals come after the register's own, so a
  cancelled request reads as cancelled. A re-run preflight re-stamps and
  restarts the 24 hours.
- **The stage is an argument, never a default.** `decideErasureRequest` takes
  `'PREFLIGHT' | 'ERASE'` on every call, in the module that already argued
  that a gate off whenever a caller omits an argument is worse than none.
- **The `dsar-erase` action's same-run preflight is `--check`, not the plan.**
  Running the stamping plan before `--confirm` in the same run would stamp
  whatever request is due at that moment and then erase it: the write would
  vouch for itself, and the binding would bind nothing. `--check` decides at
  the ERASE stage and writes nothing. It keeps the repository's rule that every
  write runs its preflight first in the same run.
- **The local `--request` preflight stamps too, and `--confirm` needs it.**
  Recommended over exempting the local path, because the check also lives in
  `eraseUser`'s transaction, which serves every caller; exempting one entry
  point would mean telling the transaction who called it, and the local path
  is the same irreversible act. The cost is one plan run within 24 hours
  before confirming, which the runbook already asked for.
- **The stamp is kept.** The row survives erasure as evidence, and the stamp
  says which preview the erasure was approved on; `fulfilErasureRequestWithin`
  does not touch it, and the writers guard holds that.
- **Folded into `20261125140000`**, since that migration is not yet on main: a
  nullable column with no default, so every existing row reads "never
  previewed", which is true.
