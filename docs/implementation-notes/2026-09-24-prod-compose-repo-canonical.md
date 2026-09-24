# 2026-09-24 — the production Compose file becomes repo-canonical

**Issue:** #2849 — `deploy/docker-compose.prod.yml` and
`/opt/inflect/docker-compose.prod.yml` had diverged by ~148 lines, and neither
was authoritative.

## Design

The direction chosen is **repo canonical**, matching the sibling repo
`agri-saas` (`deploy/apply.sh` + `deploy/check-drift.sh` over a repo-canonical
compose). What made the choice non-obvious is that the repo file, as it stood,
was not deployable — so "declare the repo canonical" on its own would have
shipped the exact hazard the issue names.

### The evidence that the repo file had never run

Measured against the live VM on 2026-09-24, read-only:

| | |
| --- | --- |
| live services | 8 (`postgres pgbouncer redis clamav app watchtower caddy worker`) |
| repo services | 9 — the extra one is `pipelock`, which has never run |
| live `${…}` references | 1 (`POSTGRES_PASSWORD`, used twice) |
| live `:?` guards | 0 |
| live comment lines | 31, against ~90 in the repo |

Running the repo file the way the VM would run it (`docker compose config`
with only the auto-loaded `/opt/inflect/.env`) fails on three counts:

```
required variable REDIS_PASSWORD is missing a value
required variable DATA_ENCRYPTION_KEY is missing a value   (app)
required variable DATA_ENCRYPTION_KEY is missing a value   (worker)
```

- `REDIS_PASSWORD` exists nowhere on the host as a standalone key. Redis auth
  reaches the app embedded in `REDIS_URL`. (Compared by truncated digest, the
  credential inside `REDIS_URL`, the live `--requirepass` argument and the
  live healthcheck's `-a` argument are all the same value.)
- `DATA_ENCRYPTION_KEY` *is* in `/opt/inflect/.env.prod` — but `env_file:` is
  not interpolation scope, so a `${DATA_ENCRYPTION_KEY:?…}` in the compose
  file cannot see it. The guard aborts a deploy whose key is present.
- `pipelock` bind-mounts `./pipelock-signing.key`, absent from the VM. Docker
  answers a missing bind-mount source by creating an empty **directory**, and
  `docker compose config` validates neither bind-mount sources nor whether an
  image resolves — so the service passes every check short of `up`.

Two further divergences fell out of the survey:

- The live `app` and `worker` mount `./prisma.config.ts:/app/prisma.config.ts:ro`,
  absent from the repo file since the 2026-05-05 Prisma 7 recovery. The host
  copy is byte-identical to the repo's root `prisma.config.ts`.
- `/opt/inflect/caddy/Caddyfile` serves a **second vhost, `app.inflect.bg`**
  (answering 200), that `deploy/caddy/Caddyfile` does not define — while the
  repo copy carries the retry/HTTP-3 settings from #1814/#1275 that the live
  copy never received.

## Files

| File | Role |
| --- | --- |
| `deploy/docker-compose.prod.yml` | Canonical. `:?` guard added to `POSTGRES_PASSWORD`; `prisma.config.ts` mount reconciled in from the host; `pipelock` moved out; header states the contract and the interpolation-vs-`env_file` rule. |
| `deploy/docker-compose.pipelock.yml` | New opt-in overlay holding `pipelock` and its unmet preconditions. |
| `deploy/apply.sh` | New. Preflights (env KEY presence, remote `config -q` on a staged file, `up --dry-run`), stops; `CONFIRM=1` applies, then health-verifies both vhosts. |
| `deploy/check-drift.sh` | New. sha256 over the canonical set; exit 1/2/3 for drift / unreachable / unreconciled. |
| `tests/guards/deploy-compose-canonical.test.ts` | New ratchet over the three regression classes. |
| `docs/deployment.md` | New canonical-contract section; two inaccurate `REDIS_URL` claims corrected. |
| `CLAUDE.md` | The "hand-managed, edit it directly" instruction replaced. |

## Decisions

- **Detection is wider than application, deliberately.** `apply.sh` pushes the
  compose file, `init-roles.sh` and `prisma.config.ts`; `check-drift.sh` also
  watches `deploy/caddy/Caddyfile`. `agri-saas` learned that hashing only the
  compose file let a build context drift three months undetected — but the
  fix is not to push everything. Pushing the repo Caddyfile would delete a
  live production hostname. Watch it, report it as exit 3, do not apply it.

- **The `:?` guard on `DATA_ENCRYPTION_KEY` was kept, not moved to a
  preflight, and `--env-file .env.prod` is what makes it correct.** A
  service-level `environment:` value overrides the same key from `env_file:`,
  so an interpolation sourced from anywhere other than `.env.prod` can hand
  the app a *different* key than `.env.prod` holds — unreadable ciphertext
  rather than an error. Sourcing both sides from one file makes them agree by
  construction. (`tests/guardrails/encryption-key-enforcement.test.ts` also
  requires the guard to stay.)

- **`POSTGRES_PASSWORD` gained a guard it never had.** It was the only
  credential in the file without `:?` *and* the only one the VM could
  resolve — the worst pairing: unset, it does not abort, it initialises a
  fresh volume with an empty superuser password.

- **`REDIS_PASSWORD` is left for an operator on purpose.** These scripts do
  not write secret files. `apply.sh` refuses in preflight, having changed
  nothing, and names the file and the source value.

- **The guard needed an axis that survives a rename.** Replacing
  `--requirepass "${REDIS_PASSWORD:?…}"` with a literal reddened only one of
  the two credential assertions: a scan keyed on the variable NAME cannot see
  a secret that removed the name, and the one surviving mention
  (`REDISCLI_AUTH`) satisfied it vacuously. A call-site assertion on the
  `--requirepass` argument was added, and the mutation then reddened both.

- **`DRY_RUN` builds its project directory beside the compose file, not in
  `/tmp`.** Where `docker` is the snap package the CLI has a private `/tmp`,
  and a project there fails "couldn't find env file" for a file that exists.
  The first version of that failure also printed the `:?`-guard message for a
  missing-`env_file` error — one failure shape for two causes — so the two are
  now told apart explicitly.
