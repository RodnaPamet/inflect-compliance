# 2026-09-02 — remove the PROPOSE rung from the identity write ladder

**Commit:** `<pending>` fix(identity): remove the PROPOSE rung from the write ladder (#2241)

## Design

The ladder was `DISABLED → DRY_RUN → PROPOSE → AUTOMATIC`, stored per direction
on `TenantSecuritySettings.identity{Leaver,Joiner}Mode`. Two facts about the
third rung, both verifiable in the source it shipped with:

1. `identity-disable-account.ts` refused **every** candidate in `PROPOSE` —
   "each disable needs explicit approval, which this path does not perform." The
   approval queue was never built. So widening `DRY_RUN → PROPOSE` moved a tenant
   from a useful dry-run report to nothing: the rung above yielded strictly less
   than the rung below.
2. The seven-day dwell in `describeRefusal` is gated on
   `current.mode === 'DRY_RUN'`. Nothing gated `PROPOSE → AUTOMATIC`.

Individually those are a dead rung and a narrow gate. Composed with the
widen-one-rung rule they are a hole: `PROPOSE` was **compulsory** on the way to
`AUTOMATIC` and was the **only ungated transition on the ladder**. The rung was
not a safety step, it was the safety bypass — the real cost of unattended
directory writes was seven days at `DRY_RUN` plus two PUTs, and the second could
follow the first by a second.

Deleting the rung makes `DRY_RUN → AUTOMATIC` a single move, which the dwell that
already exists now gates. **The safety hole closes as a side effect of a
deletion.** No new gate was added; the thing that let callers step around the old
one was removed.

### The dangerous part: an unknown mode fails PERMISSIVE

The DB enum keeps `PROPOSE` (see Decisions), so a row can still hold it. The
moment the value left `LADDER` it became an *unrecognised* mode, and every
consumer of the ladder treats unrecognised generously:

- `isAboveClamp` sorts it to `-1`, which is not greater than any real index — so
  it reads as **below** the clamp, i.e. cleared to run.
- `resolveDirectoryWriter` returned the snapshot reader for `mode === 'DRY_RUN'`
  and a **live** writer for everything else.
- `decideAndDisable` refused `DISABLED`, returned early for `DRY_RUN`, and wrote
  for everything else.

Three permissive defaults in a row. Deleting the rung without addressing them
would have turned a tenant parked at `PROPOSE` — configured to write nothing —
into a tenant writing to its directory unattended. That was verified by mutation
rather than assumed: with both new locks removed, the end-to-end unit test
returns outcome `DISABLED` (a real write) for a stored `PROPOSE`.

So three changes, in the order they are met at runtime:

```
getIdentityWritePolicy   coerceStoredMode(row.mode)      ← the fix
  PROPOSE            → DRY_RUN      (narrowing; the rung below)
  anything unknown   → DISABLED     (fail closed; no predecessor to guess at)
  null / no row      → DISABLED     (unchanged; absence is a real "off")

resolveDirectoryWriter   if (mode !== 'AUTOMATIC') → snapshot   ← was === 'DRY_RUN'
decideWithTarget         if (mode !== 'AUTOMATIC') → refuse     ← replaces the PROPOSE arm
```

The coercion is applied at the READ boundary and nowhere downstream. That
placement is the whole point: one unconverted comparison anywhere is a live
writer, and there are five call sites that compare. Converting once, where the
value enters the application, is a property the call graph enforces; converting
at each comparison is a promise somebody has to keep.

The two backstops are written as **allowlists** (`!== 'AUTOMATIC'`) rather than
denylists (`=== 'DRY_RUN'`). Removing a rung is precisely the event that makes an
exhaustion-shaped condition wrong, and a rung added later would otherwise inherit
write authority by falling through.

## Files

| File | Role |
| --- | --- |
| `src/lib/identity/write-ladder.ts` | `LADDER` is now a 3-tuple and `IdentityWriteMode` is DERIVED from it, so a retired rung is a compile error at every site that names it. Adds `RETIRED_MODES` + `coerceStoredMode`. |
| `src/app-layer/usecases/identity-write-policy.ts` | `getIdentityWritePolicy` coerces both directions at the read. The dwell comment now records that it gates the only authority-granting widen. |
| `src/app-layer/usecases/identity-disable-account.ts` | PROPOSE refusal deleted; the write is reached by allowlist instead of by exhaustion. |
| `src/app-layer/integrations/identity-writer-factory.ts` | The socket-opening decision is an allowlist: only `AUTOMATIC` gets a live writer. |
| `src/app/api/t/[tenantSlug]/admin/identity-write-policy/route.ts` | Third verbatim copy of the ladder deleted in favour of `LADDER`; `z.enum(LADDER)` rejects the retired rung with a 400. |
| `WriteLadderClient.tsx` | Local `Mode` union replaced by the imported type; `MODE_VARIANT` loses its dead entry. |
| `messages/{en,bg}.json` | `writeLadder.mode.PROPOSE` and `writeLadder.confirmBody.PROPOSE` removed from both locales. |
| `CLAUDE.md`, `.claude/skills/identity-chain-diagnostic/SKILL.md` | Both documented the four-rung ladder and the "PROPOSE builds a live writer and refuses everything" behaviour. |

## Decisions

- **No migration, and the DB enum keeps `PROPOSE`.** Postgres cannot drop an enum
  value without recreating the type, and an `ALTER TYPE` during a rolling deploy
  makes every still-running old container fail with SQLSTATE 42704 — the lesson
  already written down for the `@@map("WorkItem*")` pins. An unreachable enum
  value costs nothing; the migration costs a deploy hazard. The consequence is
  that the *application* is the only thing that knows the rung is gone, which is
  what `coerceStoredMode` exists to make safe.

- **A stored `PROPOSE` coerces DOWN to `DRY_RUN`, not up and not to `DISABLED`.**
  Down because narrowing is always permitted, and to `DRY_RUN` specifically
  because that is what `PROPOSE` was failing to be: the tenant was already
  getting no directory writes, and now gets the report it was silently denied.
  It arrives with a null `dryRunSince` (the write path nulls it on every move out
  of `DRY_RUN`), so it cannot widen until it re-selects `DRY_RUN` and spends the
  seven days. That is the correct answer, not a side effect — it is the toll
  every other tenant pays for the same authority.

- **Anything else unrecognised fails closed to `DISABLED`.** A retired rung has a
  known predecessor to fall back to; an unknown value does not, and guessing at
  the authority a tenant meant to grant is the one thing this module must not do.

- **The retired-rung lookup uses `hasOwnProperty.call`, not `in`.** `in` walks
  the prototype chain, so `'constructor'`, `'toString'` and `'__proto__'` all
  match a one-entry table and the lookup hands back an inherited
  `Object.prototype` member — a *function* returned as an identity write mode.
  Not a live write (nothing off the ladder reaches one, by the two allowlists)
  but a junk value in a log line, a badge and an audit row. The result is also
  re-checked against `LADDER` before being returned, so the function's
  post-condition holds structurally rather than by review of a hand-written
  table.

- **The API rejects `PROPOSE` rather than coercing it.** Coercing a *read*
  translates a value nobody can change now. Coercing a *write* would store a
  different rung than the caller asked for and would silently restart the
  seven-day clock as a side effect of a request that never mentioned it. A 400
  whose zod error names the three valid modes tells an old client exactly what
  happened. No UI sends it: the client only ever PUTs the server-computed
  `nextMode` or the rung immediately below the current one.

- **The safety test is stated as a property over the ladder, not as a
  transition.** `there is no way to AUTOMATIC that skips the dwell` filters every
  rung for one that reaches `AUTOMATIC` with no banked window and asserts the
  result is empty; its paired positive asserts exactly `['DRY_RUN']` reaches it
  after waiting. A per-transition test is what the four-rung ladder *passed* —
  every individual step looked gated or harmless and the hole was in the
  composition of two of them. Written this way the assertion is ladder-length
  independent: re-introduce any ungated rung below `AUTOMATIC` and it goes red.

- **Change class: SIGNIFICANT** under `docs/change-management-policy.md` — it
  alters a documented safety control on the highest-blast-radius subsystem in the
  product. Rollback is a revert of the application diff alone; there is no schema
  change to reverse, and a reverted build reads a `PROPOSE` row as the rung it
  always was.

### Production state at the time of the change

One `TenantSecuritySettings` row: leaver `DRY_RUN` since 2026-08-29, joiner
`DISABLED`. Nobody was at `PROPOSE`, so the coercion is defensive on day one and
the live tenant's dwell (elapsing ~2026-09-05) is untouched — it now buys a move
to `AUTOMATIC` instead of a move to a rung that refused everything.
