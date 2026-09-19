/**
 * Declared concurrency limits for the audit write path (issue #2653).
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════
 *
 * `appendAuditEntry` serialises appends per tenant with
 * `pg_advisory_xact_lock(hashtext(tenantId))`. That lock is correct and
 * is what makes the hash chain safe against concurrent writers. Its
 * COST is a queue, and until this file every term of that queue's
 * budget was an inherited library default that nobody had written down:
 *
 *   | limit                          | inherited default | owner         |
 *   |--------------------------------|-------------------|---------------|
 *   | pool `max`                     | 10                | node-postgres |
 *   | pool `connectionTimeoutMillis` | undefined (∞)     | node-postgres |
 *   | `$transaction` `maxWait`       | 2000 ms           | Prisma        |
 *   | `$transaction` `timeout`       | 5000 ms           | Prisma        |
 *
 * (The first two were MEASURED on the installed `pg`: `new Pool({...})`
 * reports `max: 10`, `connectionTimeoutMillis: undefined`. The Prisma
 * two are documented on `PrismaClientOptions.transactionOptions` in the
 * generated client.)
 *
 * The defect in #2653 is not any one of those numbers. It is that the
 * product's supported concurrency was whatever those four happened to
 * be — so the ceiling moved with the library version and the host, and
 * no reviewer could tell whether a given failure was in contract or out
 * of it. Everything below is therefore a STATED limit. Argue with the
 * numbers; do not go back to inheriting them.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE MECHANISM THAT COUPLES THEM
 * ═══════════════════════════════════════════════════════════════════
 *
 * The advisory lock is acquired INSIDE the transaction. So a concurrent
 * append takes a pooled connection AND opens a transaction BEFORE it
 * blocks on the lock:
 *
 *   N concurrent appends for ONE tenant
 *     → N connections held simultaneously,
 *     → N-1 of them idle, waiting on the lock,
 *     → and the lock wait is charged to the transaction `timeout`,
 *       not to `maxWait`.
 *
 * Two consequences a reader should not have to rediscover:
 *
 *   1. Pool size becomes binding above N concurrent appends per tenant.
 *      With the inherited `max: 10`, the 11th concurrent append for one
 *      tenant waits for a CONNECTION, and that wait is charged to
 *      `maxWait`.
 *   2. `connectionTimeoutMillis` silently outranks `maxWait`. If the
 *      pool gives up first, Prisma's declared budget never elapses and
 *      the error the caller sees is node-postgres's, not ours. Hence
 *      the invariant `connectionTimeoutMillis >= maxWait`, pinned by
 *      `tests/unit/db/audit-concurrency-limits.test.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE DERIVATION, AND WHAT IN IT IS NOT MEASURED
 * ═══════════════════════════════════════════════════════════════════
 *
 * `docs/sizing.md` is the only sizing authority in the repo, and it is
 * explicit that only its SMALL tier is "observed" — medium, large and
 * enterprise are "extrapolated and untested". So these numbers anchor
 * to the small tier and to the single observed concurrency figure that
 * tier rests on: the nightly k6 smoke, 25 VUs for 1 minute on a 2-vCPU
 * runner (`tests/load/`, `.github/workflows/load-test.yml:156`).
 *
 * That gives the design point. What it does NOT give is a latency
 * distribution, and the honest statement of what we have is short:
 *
 *   • We have NO measured p99 for a single audit append.
 *   • We have a LOWER BOUND from the one observed CI failure: five
 *     appends serialised behind each other did not all start inside the
 *     2000 ms `maxWait`. Read loosely (2000 / 5) that is >400 ms per
 *     append; read strictly (the 5th waits behind 4 predecessors,
 *     2000 / 4) it is >500 ms. Both readings are floors, and the true
 *     p99 on a loaded runner may be well above either.
 *   • The local reproduction attempt did not fail at all — three runs
 *     of the parallel-append test at 2.825 / 2.87 / 2.837 s wall clock
 *     for the suite. Same order of magnitude, but suite time is not
 *     per-append time, so it corroborates rather than measures.
 *
 * Every number below is therefore derived from a FLOOR. If real
 * telemetry puts p99 per-append above 400 ms, these budgets are too
 * small and must be re-derived — that is the expected outcome, not a
 * bug in this file. What must not happen is a silent return to the
 * library defaults.
 *
 * @module db/concurrency-limits
 */

/**
 * Concurrent audit appends for ONE tenant that the product supports.
 *
 * 25 = the nightly k6 smoke's VU count (`load-test.yml:156`, 25 VUs /
 * 1 min on a 2-vCPU runner). That run is the ONLY observed concurrency
 * figure in the repo and is what `docs/sizing.md` calls the small
 * tier's "observed" anchor.
 *
 * Treating all 25 VUs as ONE tenant's appends is deliberately the worst
 * case: the advisory lock is per tenant, so 25 VUs spread across many
 * tenants never queue on each other. Sizing to the worst case means the
 * declared ceiling still holds for a single-tenant load test.
 *
 * NOT a measured maximum. It is the largest concurrency anyone has
 * actually run this product at.
 */
export const AUDIT_APPEND_DESIGN_POINT_CONCURRENCY = 25;

/**
 * Per-append latency floor, in ms — a LOWER BOUND, not a p99.
 *
 * From the observed CI failure in #2653: five serialised appends did
 * not all start inside Prisma's 2000 ms `maxWait`, so each append cost
 * at least 2000 / 5 = 400 ms on that runner. See the module comment for
 * why the stricter reading (500 ms) is equally defensible and why
 * neither is a distribution.
 *
 * Exported so the budgets below show their arithmetic instead of
 * arriving as magic numbers, and so a future PR that actually MEASURES
 * p99 has one obvious place to correct.
 */
export const AUDIT_APPEND_OBSERVED_LATENCY_FLOOR_MS = 400;

/**
 * node-postgres pool size per client. Inherited default was 10.
 *
 * WHY 25: at the design point, 25 concurrent appends for one tenant
 * hold 25 connections at once (see "THE MECHANISM" above — the lock is
 * inside the transaction, so a queued append is still holding its
 * connection). A pool of 10 cannot serve 25; it turns the lock queue
 * into a connection queue, which is the failure #2653 observed.
 *
 * WHY NOT MORE: 25 is also PgBouncer's `DEFAULT_POOL_SIZE` in
 * `deploy/docker-compose.prod.yml:42` and the chart default quoted in
 * `docs/sizing.md`. PgBouncer runs in transaction mode, so an in-flight
 * transaction holds a SERVER connection there too — asking this pool
 * for more than 25 does not buy concurrency, it relocates the queue
 * into PgBouncer, where the wait is governed by `query_wait_timeout`
 * (default 120 s) and is invisible to the app. Two independent
 * constraints landing on the same number is the reason to take it, not
 * a coincidence to lean on.
 *
 * WHAT THIS COSTS, stated plainly:
 *   • At the design point one tenant's appends can occupy the whole
 *     pool, so other queries in the same process — including other
 *     tenants' — queue behind it. That is inherent to acquiring the
 *     lock inside the transaction; fixing it means changing the append
 *     path (queue + retry, #2657), not widening the pool.
 *   • `prisma.ts` can build TWO clients (primary + read replica), each
 *     with its own pool of this size.
 *   • PgBouncer's 25 is shared with the worker in the compose
 *     deployment, so with the worker contending the effective ceiling
 *     is below 25. Re-derive if worker write volume grows.
 */
export const DB_POOL_MAX = 25;

/**
 * How long a caller may wait for a pooled connection, in ms.
 * Inherited default was `undefined` — wait forever.
 *
 * WHY FINITE AT ALL: an unbounded wait converts pool exhaustion into a
 * hung request that still holds a server worker, which is strictly
 * worse than an error for a product whose write SLO is p95 < 1000 ms
 * (`docs/slos.md` SLO 2b).
 *
 * WHY 15_000 AND NOT SOMETHING NEAR THE SLO: this value must be >= the
 * largest per-call `maxWait` in the codebase or it silently BECOMES the
 * real limit, and every declared `maxWait` under it is dead (see "THE
 * MECHANISM" above). The largest today is 10_000 —
 * {@link AUDIT_APPEND_MAX_WAIT_MS} here and `SYNC_WRITE_TX_MAX_WAIT_MS`
 * in `src/app-layer/integrations/sync-transaction.ts`. 15_000 clears
 * that with headroom and still bounds what was previously infinite.
 *
 * This is a policy choice, not a measurement. The only measured input
 * is that the previous value was "never give up".
 */
export const DB_POOL_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Budget for an audit append to ACQUIRE its transaction, in ms.
 * Prisma's inherited default was 2000 — the number #2653 exceeded.
 *
 * WHY 10_000: the worst case this must survive is arriving while a full
 * design-point queue is draining, i.e. the pool is saturated by
 * {@link AUDIT_APPEND_DESIGN_POINT_CONCURRENCY} appends each costing at
 * least {@link AUDIT_APPEND_OBSERVED_LATENCY_FLOOR_MS}:
 *
 *     25 × 400 ms = 10_000 ms
 *
 * Read that as a floor-shaped estimate: under the stricter reading of
 * the same observation (500 ms/append) the same design point wants
 * 12_500 ms, which the transaction `timeout` below does cover. The
 * number is stated so it can be argued with; it is not a measurement.
 *
 * Corroboration, not derivation: `SYNC_WRITE_TX_MAX_WAIT_MS` is also
 * 10_000, so the two write paths that queue for the pool now declare
 * the same patience.
 */
export const AUDIT_APPEND_MAX_WAIT_MS = 10_000;

/**
 * Budget for the audit append transaction BODY, in ms.
 * Prisma's inherited default was 5000.
 *
 * WHY THIS IS IN SCOPE even though #2653 names `maxWait`: the advisory
 * lock is acquired inside the transaction, so the lock WAIT is charged
 * here, not to `maxWait`. At the design point the 25th append waits
 * behind 24 predecessors — 24 × 400 ms = 9_600 ms, or 12_000 ms under
 * the stricter reading — plus its own work. The inherited 5000 ms could
 * therefore not honour the design point no matter what `maxWait` said,
 * and declaring `maxWait` alone would have shipped a budget the
 * transaction cannot meet.
 *
 * WHY 15_000: covers 12_500 ms of lock queue (the stricter reading of
 * the whole design-point queue) plus one append's own work, with
 * headroom. Matches `SYNC_BOOKKEEPING_TX_TIMEOUT_MS`, the repo's other
 * must-not-lose-the-evidence transaction.
 *
 * DECLARED WORST CASE, so nobody has to reconstruct it from a stack
 * trace: a single append can block its caller for
 * `maxWait + timeout` = 25 s before failing. That is long, and it is
 * the price of an in-transaction lock at a 25-deep queue. It is now a
 * number to argue with rather than one to inherit.
 */
export const AUDIT_APPEND_TIMEOUT_MS = 15_000;

/**
 * Transaction options for BOTH hash-chained audit appends.
 *
 * Passed as the second argument to `$transaction` in
 * `src/lib/audit/audit-writer.ts` (per-tenant, #2653) and
 * `src/lib/audit/org-audit-writer.ts` (per-organization, #2661).
 * Both fields are load-bearing; see each constant above for why.
 *
 * The two call sites SHARE these numbers on purpose. They are the same
 * shape — a per-key `pg_advisory_xact_lock` taken inside the
 * transaction, serialising appends for one key — so the queue the
 * budgets have to cover is the same queue. Giving the org path its own
 * copy would create a second source of truth for one property, and the
 * copies would drift the first time only one of them was revised.
 *
 * This docblock named only the tenant path until #2661. If a third
 * call site appears, name it here too: a reader checking whether a
 * number is safe to change needs the full list of who reads it.
 */
export const AUDIT_APPEND_TX_OPTIONS = {
    maxWait: AUDIT_APPEND_MAX_WAIT_MS,
    timeout: AUDIT_APPEND_TIMEOUT_MS,
} as const;
