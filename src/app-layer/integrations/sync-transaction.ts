/**
 * The transaction budget a directory / roster sync runs under.
 *
 * ═══ WHAT WENT WRONG ═══
 *
 * `runHrisSync` and `runIdentitySync` each wrapped their ENTIRE body in one
 * `runInTenantContext` call. That is `p.$transaction(cb, txOptions)` where
 * `txOptions` is populated only from an explicit caller argument
 * (`db-context.ts`), neither sync passed one, and the client sets no
 * `transactionOptions` (`prisma.ts`). Prisma 7.10.0's runtime default is
 * `timeout: 5_000`.
 *
 * Inside those five seconds sat the provider roster read — for Workday up to
 * ten sequential HTTPS fetches, each budgeted at `DEFAULT_TIMEOUT_MS` (30 s) by
 * `bounded-fetch.ts` and each able to absorb a `MAX_ABSORBED_RETRY_AFTER_MS`
 * (60 s) Retry-After sleep in-process — then thousands of sequential upserts,
 * a full-table read, the manager/link updates and the reconcile.
 *
 * ═══ WHY IT WAS INVISIBLE ═══
 *
 * When the budget blew, Prisma aborted and rolled the transaction back. That
 * took the `RUNNING` IntegrationExecution row created at the top of the
 * callback AND the `ERROR` row the catch would have written, because the
 * catch's own update ran on the same, now-closed, transaction client. The
 * observable was an ABSENCE of any execution row — which is exactly what a
 * dispatcher that never fired, a disabled connection and a dead worker also
 * look like.
 *
 * ═══ THE SHAPE THAT REPLACES IT ═══
 *
 * Three kinds of transaction, none of them holding an out-of-process round
 * trip:
 *
 *   1. `SYNC_BOOKKEEPING_TX` — a handful of statements: read the connection,
 *      write the RUNNING row, finalise the execution row, persist a rotated
 *      secret. These run BEFORE and AFTER the provider read, so a run that
 *      dies mid-flight still leaves a committed execution row to look at.
 *   2. `SYNC_WRITE_TX` — one bounded batch of row writes: at most
 *      {@link SYNC_UPSERT_CHUNK_SIZE} upserts, or the reconcile.
 *   3. No transaction at all around the provider HTTP.
 *
 * ═══ THE NUMBERS ARE CHOSEN TO COMPOSE, AND THE COMPOSITION IS TESTED ═══
 *
 * The defect report's real complaint is not the 5 s — it is that three layers
 * carried three budgets nobody had multiplied together. So the write phase's
 * worst case is derived here rather than asserted in prose:
 * {@link SYNC_WRITE_PHASE_BUDGET_MS} is every chunk transaction plus the
 * reconcile transaction at their full timeout, and
 * `tests/guards/sync-transaction-budget-composes.test.ts` asserts it fits
 * inside `SYNC_LOCK_TTL_MS` — the per-connection lease a sync must finish
 * within, or a second run may steal the lock and interleave with it.
 *
 * WHAT IS NOT COMPOSED HERE, STATED PLAINLY: the ROSTER READ's worst case is
 * not bounded by anything in this file. `MAX_HTTP_ATTEMPTS` (3) × (30 s
 * timeout + 60 s absorbed Retry-After) per request, across up to ten
 * sequential pages, exceeds `SYNC_LOCK_TTL_MS` on its own. This change does
 * not fix that and must not be read as having fixed it — it moves the read out
 * of a transaction, which stops the read from destroying the run's evidence,
 * and leaves the read-versus-lease composition to #2508.
 */

/**
 * Budget for the short transactions that carry the run's own bookkeeping.
 *
 * Generous for what is at most a few single-row statements, and deliberately
 * so: this is the transaction whose job is to LEAVE EVIDENCE. A bookkeeping
 * write that times out under load takes the record of the failure with it, so
 * the failure mode of a number too small here is silence — the same silence
 * this whole change exists to end.
 */
export const SYNC_BOOKKEEPING_TX_TIMEOUT_MS = 15_000;

/**
 * Budget for ONE chunk of row writes, or for the reconcile.
 *
 * At {@link SYNC_UPSERT_CHUNK_SIZE} = 500 rows this is 40 ms per row, and every
 * row costs two statements (the upsert plus the audit extension's own insert),
 * so the ceiling sits at roughly 20 ms per statement — comfortably UNDER the
 * 50 ms `SLOW_QUERY_THRESHOLD_MS`, which is the point: a chunk that exhausts
 * this budget is made of statements each slow enough to be logged
 * individually, so the timeout is not the first thing to tell you. (An earlier
 * version of this paragraph said 20 ms was "already past" 50 ms. It is not, and
 * the inverted comparison made the budget look tighter than it is.) It is a ceiling, not a target: a
 * chunk that genuinely needs this long is a database in trouble, and the right
 * answer then is to fail the run loudly rather than hold a pooled connection
 * open while the pile-up gets worse.
 */
export const SYNC_WRITE_TX_TIMEOUT_MS = 20_000;

/**
 * How long a write transaction may wait for a connection before giving up.
 *
 * Separate from the timeout above because it measures a different thing —
 * queueing for the pool, not doing work — and because a sync competing with
 * request traffic should yield rather than starve it.
 */
export const SYNC_WRITE_TX_MAX_WAIT_MS = 10_000;

/**
 * Rows per write transaction.
 *
 * The point of a chunk is that the number of round trips inside ONE
 * transaction is bounded by a constant instead of by the size of the customer's
 * directory. 500 is the same page size Workday's roster reader uses, so a chunk
 * is roughly "one page's worth of writes" and the two layers are easy to reason
 * about together.
 *
 * NOT a batched multi-row INSERT ... ON CONFLICT. That would be fewer round
 * trips still, and it would go around the Prisma client extensions — the audit
 * trail and the field-level encryption both hang off the model-level
 * `upsert`/`update` handlers in `lib/prisma.ts`. Trading the audit trail for
 * latency is not a trade this subsystem gets to make silently.
 */
export const SYNC_UPSERT_CHUNK_SIZE = 500;

/**
 * The largest number of rows any provider hands back for one run.
 *
 * The HRIS ceiling (`MAX_EMPLOYEES` = 10,000) rather than the identity one
 * (`MAX_USERS` = 5,000), because the budget derived from it has to hold for
 * whichever sync is worse.
 */
export const MAX_SYNC_ROWS_PER_RUN = 10_000;

/** Write transactions one run can open for its upserts, at the ceiling above. */
export const MAX_SYNC_WRITE_CHUNKS = Math.ceil(MAX_SYNC_ROWS_PER_RUN / SYNC_UPSERT_CHUNK_SIZE);

/**
 * Worst case for the whole write phase: every upsert chunk, every manager /
 * link chunk, and the reconcile, each burning its full timeout.
 *
 * The `2 *` is not padding. HRIS walks the roster twice — once to upsert and
 * once to attach managers — so a run can open two full sets of chunk
 * transactions; the `+ 1` is the reconcile. Deriving it instead of writing a
 * number down is what makes the guard test able to fail when someone raises
 * the chunk size or the per-run ceiling.
 */
export const SYNC_WRITE_PHASE_BUDGET_MS = (2 * MAX_SYNC_WRITE_CHUNKS + 1) * SYNC_WRITE_TX_TIMEOUT_MS;

/**
 * Options for a bookkeeping transaction.
 *
 * `maxWait` IS SET EXPLICITLY AND MATCHES THE WRITE TRANSACTION, which an
 * earlier version of this file omitted. Prisma's default is 2000 ms, so the
 * transaction whose entire job is to LEAVE EVIDENCE had less patience for a
 * busy connection pool than the transaction it exists to record — which had
 * 10_000. That is backwards in the failure that matters: pool exhaustion is a
 * likely cause of a write phase dying, and it is exactly the moment the ERROR
 * row must still be written. Losing the evidence write to a 2-second pool wait
 * reproduces #2501's original symptom — an absence indistinguishable from a
 * dispatcher that never fired — from a different direction.
 */
export const SYNC_BOOKKEEPING_TX_OPTIONS = {
    timeout: SYNC_BOOKKEEPING_TX_TIMEOUT_MS,
    maxWait: SYNC_WRITE_TX_MAX_WAIT_MS,
} as const;

/** Options for a bounded write transaction. */
export const SYNC_WRITE_TX_OPTIONS = {
    timeout: SYNC_WRITE_TX_TIMEOUT_MS,
    maxWait: SYNC_WRITE_TX_MAX_WAIT_MS,
} as const;

/**
 * Split `rows` into consecutive groups of at most `size`.
 *
 * Returns an EMPTY array for an empty input, which is the behaviour both syncs
 * rely on: no rows means no write transaction is opened at all, so an empty
 * roster cannot cost a pooled connection.
 */
export function chunk<T>(rows: readonly T[], size: number = SYNC_UPSERT_CHUNK_SIZE): T[][] {
    if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
}
