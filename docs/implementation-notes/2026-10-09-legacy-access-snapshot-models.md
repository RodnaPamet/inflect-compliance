# 2026-10-09 — Legacy access snapshot models and a fail-closed pull (Step 2a)

**Commit:** `(pending) feat(legacy-access): snapshot models and a fail-closed pull (Step 2a)`

## Design

A pull reads a legacy application's access table through the operator-hosted MCP
server, applies a stored per-connection mapping, and writes a snapshot that is
either **complete and verifiable** or **visibly not complete**.

```
POST /admin/legacy-access/pull  →  enqueue('legacy-access-pull')
                                        │
                                        ▼
                      acquireSyncLock(connectionId)        ── held? SKIPPED_LOCKED
                                        │                     absent? NOT_APPLICABLE
                                        ▼
                      IntegrationExecution  (RUNNING)       ── committed BEFORE the read
                                        │
                      readStoredMapping(configJson)         ── absent? no snapshot: we never dialled
                                        │
                      pullSnapshot({ fields: projection })  ── ?fields= = the boundary
                                        │
                      assertNoSchemaDrift + assertLayoutAgrees
                      mapRows()  ──────────────────────────── 7 named refusals
                                        │
                      LegacyAccessSnapshot (PENDING)
                      LegacyAccount × N   (chunks of 500)
                                        │
                      status = COMPLETE  ─────────────────── the FINAL act
```

The order of writes is the safety property. `PENDING` is what a crash leaves
behind, so no code has to run for a failure to be recorded — the *absence* of a
transition is the signal, and every reader filters on `COMPLETE`. One big
transaction would be atomic, which sounds stronger and is weaker here: it would
leave nothing behind, and "no snapshot" is indistinguishable from "the job never
ran".

## Files

| File | Role |
| --- | --- |
| `src/lib/legacy-access/canonical.ts` | The 17 canonical fields, the column denylist, the mapping shape, `assertMappingUsable`, the column-set fingerprint, the payload hash and its incremental hasher |
| `src/lib/legacy-access/ingest.ts` | Applying a mapping to returned rows; the seven named refusals; oversharing detection |
| `prisma/schema/legacy-access.prisma` | `LegacyAccessSnapshot` (integrity evidence) + `LegacyAccount` (canonical fields only) |
| `prisma/migrations/20261009000000_legacy_access_snapshots/` | Tables, enums, the `OVERSHARING` flag on `IntegrationConnection`, and the RLS triple on both tables |
| `src/app-layer/usecases/legacy-access-mapping.ts` | Saving a versioned mapping; denylist at save time |
| `src/app-layer/usecases/legacy-access-pull.ts` | The pull; `LEGACY_SNAPSHOT_MAX_ACCOUNTS` |
| `src/app-layer/usecases/legacy-access-verify.ts` | Recomputing the payload hash from the stored rows |
| `src/app/api/t/[tenantSlug]/admin/legacy-access/{pull,mapping}/route.ts` | `admin.manage`; the pull route enqueues and returns 202 |

## Decisions

- **The denylist runs at SAVE, and again at ingestion, and they are different
  checks.** Refusing a denied column when a mapping is saved is what keeps it from
  ever being *requested* — the `?fields=` projection is derived from the mapping,
  so an unmappable column never crosses the network. A defence that runs after the
  data arrives is a filter, not a boundary. Ingestion checks again because a server
  may volunteer a column nobody asked for.

- **The name check and the value check fail in opposite directions, and that is
  why both exist.** A name check cannot see what a column holds; a column called
  `NOTES` carrying an API key is invisible to it, and the operator who mapped it
  had no way to know. So the AI Guard's egress scanner runs over the *mapped*
  values as a backstop. It deliberately does **not** scan dropped columns: a secret
  in a column the projection excluded never reaches the database, so refusing for
  it would let a misconfigured legacy server halt recertification over data we
  correctly threw away.

- **Oversharing is the one fault that is not fatal.** Dropping the extra columns
  is a complete remedy. The connection is flagged (and the flag is *cleared* by a
  later clean pull, so the banner cannot go stale), but refusing would trade a real
  risk for a worse one.

- **`UNKNOWN` is the fail-closed direction for `status`, and only for `status`.**
  Read as `ACTIVE`, an unrecognised status is campaign noise; read as `DISABLED` it
  *removes* a live account from the campaign, which is the failure recertification
  exists to prevent. `UNKNOWN` is neither and reaches a human. The same value then
  had to be treated as **absence** in the long-layout contradiction check — a
  repeat row carrying only the key and a role folds to `UNKNOWN` and would
  otherwise "disagree" with the first row's `ACTIVE`, refusing a legitimate table.
  A test caught that, not a reading of the function.

- **The row bound lives with the snapshot, not the transport.** Step 1b's client
  carries a `MAX_TOTAL_ROWS` default; how many accounts a snapshot may hold is a
  product decision about what a human can be asked to review, so
  `LEGACY_SNAPSHOT_MAX_ACCOUNTS` is authoritative here and the client's value is now
  a backstop for a caller that forgets to pass one.

- **The hash is defined over `accountKey` order explicitly**, not over the
  serialised line. Sorting the lines gives the same answer today only because
  `accountKey` happens to sort first among the canonical field names; a future field
  named before it would silently re-order the population and change every hash.

- **`payloadHashAlgorithmVersion` is read from the row, never from the current
  constant.** A verifier that assumed today's canonicalisation would report every
  snapshot taken before a fix as corrupt — on the day somebody fixes a bug.

- **The verifier is a second, independent mapping back to canonical form.** It is
  not duplication to collapse: if it and the pull's mapping ever disagree, the
  recompute fails, which is exactly what a verification is for.

- **Execution status uses four values, not ok/not-ok.** A refusal records `PARTIAL`
  (the run reached a verdict; its output is incomplete), a crash leaves `RUNNING`, a
  complete pull of an *empty* table records `NOT_APPLICABLE` — the enum's own
  comment says "no data" is not "compliant" — and `ERROR` is reserved for the
  row-count disagreement, which means something internally wrong rather than a
  verdict about the far end. The snapshot is still `COMPLETE` for an empty
  application: that is a true observation, and invariant 5 bites at campaign
  *creation*, which refuses an empty population.

- **A failed lock has two causes and they need different answers.**
  `acquireSyncLock` claims with a conditional `updateMany` keyed on the connection
  id, so it returns null both when the lock is held and when no such connection
  exists — and logs "sync already running" either way. Reporting `SKIPPED_LOCKED`
  for a deleted connection would leave an operator waiting out a lease that will
  never clear, so the cause is resolved rather than guessed. The conflation is
  shared by every caller of that helper and is filed separately.

## Two things found on the way

- **Step 1c had broken Step 4a** (#3315). `CONFIG_FIELD_RULES` is an allowlist and
  `validateProviderConfig` throws on an undeclared key, so registering `legacy-mcp`
  with rules naming only `endpointUrl`/`applicationName` made
  `adoptUsernameConvention` return 400 for the one provider that feature exists for.
  `legacy-username-convention.ts` had *predicted* this in prose, naming the step
  that would break it. A predicted regression with no test is an un-run assertion.

- **The runtime-wiring guard was grading the wrong population.** Its "every
  *dispatched by* reason names a real enqueue site" check scanned only
  `src/app-layer`, on the stated premise that every `enqueue(` lives there. Eleven
  sites do not, ten of them in `src/app/api` — including the identity leaver and
  joiner "run now" routes, the canonical shape for an on-demand admin action. So no
  route-dispatched job could satisfy it and the cheapest way past was to word the
  reason without "dispatched by". The population is now all of `src/`, git-backed,
  with a floor on its own size so it cannot empty itself silently.
