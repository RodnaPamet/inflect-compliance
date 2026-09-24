# 2026-09-24 — an unsettled identity write now pages somebody (#2842)

## The finding

`src/lib/observability/integration-metrics.ts` carried, for months, an
instruction at the top of `recordIdentityWritesUnsettled`:

```
ALERT ON — `increase(identity_write_unsettled_total[2d]) > 0`
```

The alert did not exist, and as written it could never have worked. Verified on
production:

1. `infra/alerts/rules.yml` holds 22 alert rules and zero mention identity.
2. Prometheus and Alertmanager are **not deployed** — nothing in
   `deploy/docker-compose.prod.yml` references either. `infra/alerts/*.yml`
   describes a stack that does not run.
3. The app container carries **no `OTEL_*` environment**, so
   `recordIdentityWritesUnsettled` increments a counter in a meter with no
   exporter. The metric is dead in production, not merely unalerted.

So a 23rd rule in `rules.yml` would have been useless twice over, and worse than
nothing: it would have read, to the next person, as coverage. That is the exact
failure `infra/alerts/external-uptime.yml` was rewritten to undo in #2745.

And a second finding, which shaped everything below: **the one alerting
mechanism that does work was entirely unversioned.** `git grep
container-health-reporter` returned zero files. The script lived only at
`/usr/local/bin/container-health-reporter.sh` on the VM, with a systemd timer
beside it and its GCP alert policies in the console — unreviewable, untestable,
and unrecoverable if the VM were lost.

## Design

```
      IdentityWriteJournal                    (the source of truth)
      outcome IN (PENDING, INDETERMINATE)
      AND attemptedAt < now() - 1 hour
                 │
                 │  docker exec inflect-postgres-1 psql       (no credential)
                 ▼
  /usr/local/bin/identity-unsettled-reporter.sh   systemd timer, every 5 min
                 │
                 │  POST, token from the metadata server
                 ▼
  custom.googleapis.com/identity/write_unsettled  (one series, no labels)
                 │
     ┌───────────┴────────────┐
     ▼                        ▼
  threshold > 0          absent for 1800s
  for 600s               ("reporting stopped")
     └───────────┬────────────┘
                 ▼
        email notification channel
```

The signal comes from the **database**, not the OTel counter, and that is a
design decision rather than a workaround for the dead exporter.
`identity.write.unsettled` is emitted only from `readUnsettledBacklog`, at the
head of a leaver pass — so it exists only *when a pass runs*. A stopped
dispatcher, a wedged worker, or a tenant narrowed back to `DISABLED` after an
incident all make the counter go quiet, and quiet reads as healthy. A reporter
on its own timer has no such dependency, which matters most in exactly the case
where the pass is what broke.

The counter is also a monotonic Counter fed a LEVEL — its own docblock warns
that three rows stranded for ever add +3 every night, so the sum can say "it
stopped growing" but never "the backlog is clear". A row count read fresh is a
gauge, so it can.

## Files

| file | role |
| --- | --- |
| `infra/reporters/container-health-reporter.{sh,service,timer}` | **captured verbatim from the VM** (sha256 in the README). The working mechanism, finally in version control. |
| `infra/reporters/identity-unsettled-reporter.sh` | the new reporter: reads the journal, POSTs the count, emits nothing when it cannot read. |
| `infra/reporters/identity-unsettled-reporter.{service,timer}` | systemd unit + 5-minute timer. |
| `infra/reporters/README.md` | the shape every reporter follows, and the operator apply procedure. |
| `infra/alerts/policies/*.json` | the three deployed GCP alert policies captured as applyable JSON, plus the new one. |
| `infra/alerts/gcp-custom-metrics.yml` | the deployed-contract record, sibling of `external-uptime.yml`. |
| `src/lib/observability/integration-metrics.ts` | the `ALERT ON` instruction corrected — the intent kept, the impossible mechanism replaced with a pointer to the real one. |
| `tests/guards/unsettled-reporter-matches-the-product.test.ts` | the reporter is executed against stub `docker`/`curl`; its threshold and outcome set are parsed and compared against the product's. |
| `LeaverPassesClient.tsx` + `messages/{en,bg}.json` | `journalId` and `unsettledOnEntry` finally rendered. |

## Decisions

- **A total, not per tenant.** The alert's second arm is "this metric stopped
  arriving", and with a tenant label a series *appears* when a tenant strands a
  row and *stops* when the row is settled — so normal operation would be full of
  absence, and an absence condition over normal absence is noise. One unlabelled
  series emitted every 5 minutes, including when it is 0, makes "no data" mean
  exactly one thing. Cardinality (tenants are added by signup) is the second
  reason; the third is that the alert does not need it — every answer is "go and
  look", and the per-tenant breakdown is in journald for triage.

- **One hour, taken from the code, not chosen here.** `UNSETTLED_STALE_MS` in
  `identity-leaver-pass.ts`. The guard parses `60 * 60 * 1000` and
  `STALE_INTERVAL='1 hour'` into milliseconds and compares the numbers, so the
  two cannot drift silently across the language boundary.

- **A failed read emits NOTHING.** Not a fallback 0. Reporting 0 would convert
  "we cannot tell" into "there is no backlog" — the exact inversion the
  capture-before-write rail exists to prevent, and one the app already refuses
  (`readUnsettledBacklog` returns `null`, not 0). The guard proves this by
  running the script: on a failed read it makes zero POST attempts and exits
  non-zero.

- **The reporter must NOT `SET ROLE app_user`, and this is the trap worth
  remembering.** `IdentityWriteJournal` is `FORCE ROW LEVEL SECURITY`. Measured
  on the live database, same table, same instant:

  ```
  psql as postgres, no SET ROLE            -> 3 rows
  BEGIN; SET LOCAL ROLE app_user; ...      -> 0 rows
  ```

  A monitoring query that helpfully adopts the app's RLS posture returns zero
  for every tenant, for ever, with no error and no warning — the alert would be
  silent by construction and nothing in the number would say so. `postgres` is
  `rolsuper=t rolbypassrls=t`, which is what makes the cross-tenant sweep
  possible; it is the out-of-process equivalent of
  `runWithoutRls({ reason: 'cross-tenant-sweep' })`.

- **`docker exec`, not a connection string.** The script holds no credential —
  same reasoning as the container-health reporter taking its token from the
  metadata server. It also bypasses pgbouncer deliberately: a monitoring read
  must not consume an application pool slot.

- **`null` and `0` are rendered differently on the operator surface.** Both are
  falsy, and the `?? 0` every other fact on the page uses would have collapsed
  "the backlog could not be counted" into "there are none". `readUnsettled`
  returns a three-state reading (`count` / `unknown` / `absent`) and the rendered
  test asserts the two states side by side rather than in tests that never meet.

- **Nothing was applied to production.** The reporter was exercised against the
  live database read-only (`IDENTITY_UNSETTLED_DRY_RUN=1`, which does every read
  and posts nothing) and returned `0` — correct: the journal holds 3 rows, all
  `APPLIED`. Installing the script and creating the alert policy are operator
  actions; `infra/reporters/README.md` carries the procedure, and
  `gcp-custom-metrics.yml` records the reporter as `NOT YET APPLIED` with a
  `deployed_policy_id: null` that the guard pins. **Until an operator runs it,
  an unsettled identity write still pages nobody.**

- **The alert will be silent on day one and that is not evidence it works.** The
  README's step 5 gives the honest drill: a temporary second policy on the same
  live metric with an inverted threshold, exercising the real probe, aggregation,
  policy evaluation and email channel — the same shape that proved the readyz
  policy in #2745 — rather than inserting a fake `PENDING` row into the journal,
  which is the one table in this product designed never to hold a lie.
