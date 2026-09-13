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
 * reconcile transaction at their full timeout, and it is one of the three
 * terms of {@link SYNC_LEASE_HELD_BUDGET_MS}, which
 * `tests/guards/sync-transaction-budget-composes.test.ts` asserts fits inside
 * `SYNC_LOCK_TTL_MS` — the per-connection lease a sync must finish within, or
 * a second run may steal the lock and interleave with it.
 *
 * ═══ AND SO IS THE READ PHASE, NOW (#2508) ═══
 *
 * It was not when #2501 landed, and the paragraph that stood here said so: the
 * roster read's worst case was bounded by nothing, and exceeded
 * `SYNC_LOCK_TTL_MS` on its own. A read that outlives the lease is not an
 * aborted read — `acquireSyncLock` reaps the stale lease and a SECOND run
 * starts against the same connection, which is precisely the overlap the lock
 * exists to prevent.
 *
 * The half that moved is the READ, not the lease. {@link
 * ROSTER_READ_DEADLINE_MS} is the budget; the usecase adds it to its own run
 * start and hands the provider the resulting INSTANT, so the budget cannot be
 * restarted at a seam it crosses. The roster reader checks that instant
 * BETWEEN pages and, once it has passed, stops early and hands back the resume
 * cursor it already holds. The run then
 * ends as a PARTIAL that the next scheduled run continues, so the failure
 * direction is "fewer pages per run", never "two writers". What the lease has
 * to accommodate is {@link ROSTER_READ_PHASE_BUDGET_MS}.
 *
 * ═══ AND THE THIRD PHASE, NOW (#2522) ═══
 *
 * "Read plus write fits inside the lease" was TRUE OF TWO PHASES OUT OF
 * THREE, and it was the sentence a future author would have reasoned from
 * while changing one of these constants. `SYNC_WRITE_PHASE_BUDGET_MS` counts
 * the chunk and reconcile `writeTx` budgets and NOTHING ELSE, so the
 * bookkeeping transactions — the run-open, the manager map, the cursor store,
 * the finalise — sat inside the lease and inside neither budget. Worse, the
 * run-open sits inside the lease and OUTSIDE THE CLOCK THE READ DEADLINE IS
 * MEASURED FROM: `jobs/hris-sync.ts` takes the lock before calling the
 * usecase, and the usecase takes its `start` AFTER the run-open transaction
 * has committed.
 *
 * {@link SYNC_BOOKKEEPING_PHASE_BUDGET_MS} is that third term and
 * {@link SYNC_LEASE_HELD_BUDGET_MS} is the sum the guard now asserts against
 * `SYNC_LOCK_TTL_MS`, so the guard fails when the REAL lease-held total
 * crosses the TTL rather than when a two-phase subtotal does.
 *
 * WHAT IS STILL NOT COMPOSED, STATED PLAINLY: identity-sync's enumeration.
 * Okta and Google Workspace each fan out a per-USER enrichment request after
 * the page walk (`enrichAccounts`, `enrichSso`), so their worst case is a
 * different derivation from the one below, and no deadline is threaded into
 * them by this change. The composition the guard asserts covers the HRIS
 * roster read only, and `SYNC_LOCK_TTL_MS` says the same thing at its own
 * declaration.
 */
import { DEFAULT_TIMEOUT_MS } from './bounded-fetch';
import { MAX_ABSORBED_RETRY_AFTER_MS, MAX_HTTP_ATTEMPTS } from './http-resilience';

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
 * Worst case for ONE outbound provider request, retries included.
 *
 * Derived, because the three numbers live in three files:
 * `createResilientFetch` makes at most {@link MAX_HTTP_ATTEMPTS} attempts,
 * each bounded at {@link DEFAULT_TIMEOUT_MS} by `bounded-fetch`, and sleeps an
 * absorbed `Retry-After` of at most {@link MAX_ABSORBED_RETRY_AFTER_MS}
 * BETWEEN attempts.
 *
 * THE SLEEP COUNT IS ONE FEWER THAN THE ATTEMPT COUNT, and it is worth being
 * exact: #2508's own description composed this as 3 × (30 s + 60 s) = 270 s,
 * which is 60 s per request too high. The loop throws on the last attempt
 * instead of sleeping after it (`if (attempt === maxAttempts) throw`), so
 * three attempts carry two sleeps — 3 × 30 s + 2 × 60 s = 210 s. The same
 * bound covers a page that eventually SUCCEEDS: two throttled attempts then a
 * slow 200 costs exactly as much.
 *
 * The error arm sleeps a jittered backoff rather than a Retry-After, and that
 * arm is never the ceiling here: its base is `min(1000 * 2 ** (attempt - 1),
 * 30_000)`, so at the only two attempts that can sleep it is at most 1 s and
 * 2 s.
 */
export const MAX_HTTP_REQUEST_MS =
    MAX_HTTP_ATTEMPTS * DEFAULT_TIMEOUT_MS + (MAX_HTTP_ATTEMPTS - 1) * MAX_ABSORBED_RETRY_AFTER_MS;

/**
 * How long a run's provider read may run before the reader stops paging.
 *
 * CHOSEN, not derived — this is the number #2508 moved, and it is the one the
 * guard makes somebody choose on purpose. Ten minutes is far beyond any
 * healthy read (a ten-page Workday roster off an unthrottled tenant is
 * seconds) and comfortably inside what the lease can carry alongside the write
 * phase.
 *
 * WHY NOT SIMPLY RAISE THE LEASE. `SYNC_LOCK_TTL_MS` is also the REAPER's
 * threshold: it is how long a connection stays wedged after a worker is killed
 * mid-sync. Sizing it to the read's unbounded worst case would widen that
 * window to most of an hour, so a stuck sync would block its own retry for
 * longer the slower the provider got — the wrong direction on exactly the
 * input that causes the problem.
 *
 * THE COST, STATED. A provider throttling every page to the full
 * {@link MAX_HTTP_REQUEST_MS} gets through roughly three pages per run instead
 * of ten, so a large roster takes more scheduled runs to complete a pass and
 * the departure reconcile waits for the pass to finish. That is visible — each
 * run writes a PASSED execution row with `partial: true` and an advancing
 * cursor — and it is strictly better than the alternative it replaces, which
 * is a second run writing the same pass state concurrently.
 */
export const ROSTER_READ_DEADLINE_MS = 10 * 60_000;

/**
 * Worst case for the whole read phase: the deadline, plus the one request that
 * may still be in flight when it passes.
 *
 * The deadline is checked BETWEEN pages — never mid-request, because aborting
 * a page in flight would throw away the rows it was carrying and cost the run
 * its progress. So a page started at `deadline - 1 ms` still runs to its own
 * ceiling, and the honest bound is the deadline plus ONE
 * {@link MAX_HTTP_REQUEST_MS}, not one per remaining page.
 *
 * Adding it ONCE holds only while everything a provider does BEFORE its paging
 * loop can itself finish inside the deadline. For Workday that is TWO things,
 * not one, and the second was missed until #2522:
 *
 *   • the OAuth token exchange in `listEmployees`, at most one request
 *     (`resolveWorkdayAccessToken` refreshes or returns the cached token; it
 *     never loops);
 *   • the `persistSecret` callback it fires ON ROTATION, which is a
 *     BOOKKEEPING TRANSACTION — `SYNC_BOOKKEEPING_TX_TIMEOUT_MS` of pre-loop
 *     cost, opened and committed inside this window.
 *
 * So the precondition is `MAX_HTTP_REQUEST_MS + SYNC_BOOKKEEPING_TX_TIMEOUT_MS
 * < ROSTER_READ_DEADLINE_MS`, and the guard asserts that rather than leaving
 * it as prose.
 *
 * STRICTLY less than, and the strictness is the second thing it buys: the
 * reader's check is `now >= deadline`, so equality here would let a maximally
 * slow token exchange land exactly on the deadline and leave the run zero
 * pages. `<=` would be enough for the budget arithmetic alone; `<` is what
 * makes "every run attempts at least one page" true as well.
 *
 * THIS IS ALSO WHY THE PERSIST TRANSACTION IS ABSORBED RATHER THAN ADDED.
 * The deadline is a wall-clock INSTANT derived from the run's `start`, so
 * every transaction opened between `start` and the reader's last page SPENDS
 * this budget instead of extending it. That is what keeps
 * {@link SYNC_BOOKKEEPING_PHASE_BUDGET_MS} a count of the transactions
 * OUTSIDE this window, and it is a property of the wall clock rather than of
 * how many times a provider happens to call the callback.
 */
export const ROSTER_READ_PHASE_BUDGET_MS = ROSTER_READ_DEADLINE_MS + MAX_HTTP_REQUEST_MS;

/**
 * Bookkeeping transactions one run opens while holding the lease and OUTSIDE
 * the read window, at the worst path through `usecases/hris-sync.ts`.
 *
 * COUNTED, NOT ESTIMATED, and the census is the resumable-PARTIAL path —
 * the longest of the arms, because it stores a cursor AND finalises:
 *
 *   1. THE RUN-OPEN. `shortTx` reads the connection and commits the `RUNNING`
 *      row. This is the one that is invisible to every other budget: the lock
 *      is taken in `jobs/hris-sync.ts` BEFORE `runHrisSync` is called, and
 *      `start` — the instant `ROSTER_READ_DEADLINE_MS` is measured from — is
 *      taken AFTER this transaction commits. It is inside the lease and
 *      outside the read clock.
 *   2. THE MANAGER MAP. One `findMany` between the upsert chunks and the
 *      manager-link chunks. Bookkeeping-budgeted, so `SYNC_WRITE_PHASE_BUDGET_MS`
 *      — which counts `writeTx` only — does not see it either.
 *   3. THE CURSOR STORE, on the resumable arm.
 *   4. THE EXECUTION FINALISE, which carries `clearAuthFailure` with it.
 *
 * NOT COUNTED, deliberately: `persistSecret`. It is a fifth bookkeeping
 * transaction on a Workday run, and it is opened INSIDE the read window,
 * whose budget is a wall-clock deadline — see {@link
 * ROSTER_READ_PHASE_BUDGET_MS}. Counting it here would charge the lease twice
 * for the same seconds.
 *
 * Nor are the arms added together. The truncation-ERROR, read-failure,
 * provider-unsupported and write-failure arms each RETURN, so a run walks one
 * of them; the four above are the longest, and
 * `tests/unit/sync-transaction-shape.test.ts` measures the count against a
 * real run rather than trusting this comment.
 */
export const SYNC_BOOKKEEPING_TXS_BEFORE_READ = 1;

/** The manager map, the cursor store and the finalise — see the constant above. */
export const SYNC_BOOKKEEPING_TXS_AFTER_READ = 3;

/** Every bookkeeping transaction the lease pays for outside the read window. */
export const MAX_SYNC_BOOKKEEPING_TXS =
    SYNC_BOOKKEEPING_TXS_BEFORE_READ + SYNC_BOOKKEEPING_TXS_AFTER_READ;

/**
 * Worst case for the bookkeeping phase: every such transaction at its full
 * timeout.
 *
 * Derived from the count rather than written down, for the same reason
 * {@link MAX_SYNC_WRITE_CHUNKS} is: raising
 * {@link SYNC_BOOKKEEPING_TX_TIMEOUT_MS} because an evidence write timed out
 * under load is a REASONABLE thing for a future author to do, and it must move
 * this number and fail the composition rather than quietly eat the lease's
 * margin.
 */
export const SYNC_BOOKKEEPING_PHASE_BUDGET_MS =
    MAX_SYNC_BOOKKEEPING_TXS * SYNC_BOOKKEEPING_TX_TIMEOUT_MS;

/**
 * What the lease actually has to carry: read + write + bookkeeping.
 *
 * THE WHOLE POINT OF THE THIRD TERM. Read + write is a SUBTOTAL, and a
 * subtotal asserted against the TTL is a guard that goes red later than the
 * thing it is guarding goes wrong. #2508's failure — a sync outliving its
 * lease, a second run starting, and two runs destroying each other's roster —
 * arrives when the LEASE-HELD total crosses `SYNC_LOCK_TTL_MS`, not when a
 * two-phase subtotal does.
 *
 * WHAT THIS DOES NOT INCLUDE, so the next author does not have to rediscover
 * it:
 *
 *   • THE LOCK'S OWN TRANSACTIONS. `jobs/hris-sync.ts` wraps `acquireSyncLock`
 *     and `releaseSyncLock` in `runInTenantContext` with NO options, so each
 *     inherits Prisma's 5 s default — the number `db-context.ts` forwards only
 *     when present, and the number this whole file exists to stop inheriting.
 *     The lease clock starts at the `syncLockedAt` that acquire writes, so the
 *     tail of that transaction is lease-held time this sum does not carry. No
 *     constant is declared for it here on purpose: nothing enforces one, and a
 *     constant with no consumer is exactly the ghost the lock's own comment
 *     records (`ENUMERATION_TIMEOUT_MS`, #1950 → #1970). The guard asserts
 *     instead that the RESIDUAL margin under the TTL is wide enough to cover
 *     both.
 *   • IN-PROCESS CPU BETWEEN TRANSACTIONS — the secret decrypt, the manager
 *     map build, the chunking. Bounded by nothing here, and nothing here can
 *     bound it; it is milliseconds against a lease measured in minutes.
 *
 * AND WHAT ARITHMETIC CANNOT CERTIFY AT ALL: that the code still honours any
 * of these numbers. A sum of constants stays green when a transaction is
 * opened with the wrong options, when the reader stops checking the deadline,
 * or when a fifth bookkeeping transaction joins the long path. The conduct is
 * measured in `tests/unit/sync-transaction-shape.test.ts` and
 * `tests/unit/roster-read-within-lock-lease.test.ts`.
 */
export const SYNC_LEASE_HELD_BUDGET_MS =
    ROSTER_READ_PHASE_BUDGET_MS + SYNC_WRITE_PHASE_BUDGET_MS + SYNC_BOOKKEEPING_PHASE_BUDGET_MS;

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
