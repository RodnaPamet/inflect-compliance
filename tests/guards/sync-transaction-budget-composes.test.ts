/**
 * #2501 — the sync's budgets have to be multiplied together by SOMETHING.
 *
 * The defect report's real complaint is not that a transaction timeout was
 * 5,000 ms. It is that three layers each carried an internally well-reasoned
 * budget and nobody had composed them:
 *
 *   • one HTTP request        30,000 ms   bounded-fetch.ts
 *   • one Retry-After sleep   60,000 ms   http-resilience.ts
 *   • the per-connection lock 30 minutes  connection-lock.ts, whose comment
 *                                         says in prose that a sync takes
 *                                         minutes
 *   • the transaction          5,000 ms   Prisma's runtime default, chosen by
 *                                         nobody
 *
 * Prose cannot hold that relationship — the lock's own comment asserted the
 * composition and was contradicted by a default it never mentioned. This file
 * is where the arithmetic lives instead, so raising the chunk size, the
 * per-run row ceiling or a timeout fails CI rather than quietly eating the
 * lease.
 *
 * ═══ #2508 CLOSED THE OTHER HALF ═══
 *
 * #2501 composed the WRITE phase and said plainly that the READ phase was
 * still bounded by nothing. It is now: the roster read carries a wall-clock
 * deadline, and the second describe block below asserts read + write fits
 * inside the lease.
 *
 * The lock comment's "120 s per-page budget" has also gone, and its provenance
 * is worth recording because it is the exact failure this file exists to
 * prevent: that number was `ENUMERATION_TIMEOUT_MS`, added to bounded-fetch.ts
 * by #1950, cited by the lock in #1958, and DELETED by #1970 for having no
 * consumer. A prose justification outlived the constant it rested on, and
 * nothing failed.
 *
 * ═══ #2522 ADDED THE THIRD PHASE ═══
 *
 * "Read + write fits inside the lease" was a composition of TWO PHASES OUT OF
 * THREE. `SYNC_WRITE_PHASE_BUDGET_MS` counts the chunk and reconcile `writeTx`
 * budgets only, so the run's five lease-held BOOKKEEPING transactions were in
 * neither term — and the run-open is not even inside the clock the read
 * deadline is measured from, because `jobs/hris-sync.ts` takes the lock before
 * `runHrisSync` takes its `start`. 75 s unaccounted against 170 s of margin,
 * and the sentence a future author would have reasoned from while moving one
 * of these constants was true of a subtotal.
 *
 * ═══ WHAT ARITHMETIC CERTIFIES, AND WHAT IT DOES NOT ═══
 *
 * Stated at the top because it governs every assertion below. This file adds
 * up CONSTANTS. It fails when the numbers stop composing, and it stays GREEN
 * when the code stops honouring them — a transaction opened with the wrong
 * options, a reader that stops checking its deadline, a SIXTH bookkeeping
 * transaction added to the long path. None of those move a constant.
 *
 * THAT IS NOT A HYPOTHETICAL, AND THIS FILE REACHED REVIEW WRONG BECAUSE OF IT.
 * The count started at four, taken over the resumable arm that SUCCEEDS. The
 * write-phase `catch` in `usecases/hris-sync.ts` wraps that arm rather than
 * standing beside it, so a finalise that blows its own bookkeeping budget —
 * the precise failure `SYNC_BOOKKEEPING_TX_TIMEOUT_MS` is sized for — opens a
 * FIFTH. Every assertion here stayed green at 60,000 ms while the reachable
 * worst case was 75,000 ms. Arithmetic over a wrong census is still arithmetic.
 *
 * So the third term is bound to CONDUCT somewhere a sum cannot be:
 * `tests/unit/sync-transaction-shape.test.ts` counts the bookkeeping
 * transactions a real `runHrisSync` opens — on the failing arm AND on the
 * succeeding one, so the difference between them is pinned too — against the
 * same `MAX_SYNC_BOOKKEEPING_TXS` this file multiplies. Adding one to the long
 * path fails there even though it moves nothing here. The deadline's conduct
 * is proved in `tests/unit/roster-read-within-lock-lease.test.ts`.
 */
import {
    MAX_HTTP_REQUEST_MS,
    MAX_SYNC_BOOKKEEPING_TXS,
    MAX_SYNC_ROWS_PER_RUN,
    MAX_SYNC_WRITE_CHUNKS,
    ROSTER_READ_DEADLINE_MS,
    ROSTER_READ_PHASE_BUDGET_MS,
    SYNC_BOOKKEEPING_PHASE_BUDGET_MS,
    SYNC_BOOKKEEPING_TXS_AFTER_READ,
    SYNC_BOOKKEEPING_TXS_BEFORE_READ,
    SYNC_BOOKKEEPING_TX_TIMEOUT_MS,
    SYNC_LEASE_HELD_BUDGET_MS,
    SYNC_UPSERT_CHUNK_SIZE,
    SYNC_WRITE_PHASE_BUDGET_MS,
    SYNC_WRITE_TX_MAX_WAIT_MS,
    SYNC_WRITE_TX_OPTIONS,
    SYNC_BOOKKEEPING_TX_OPTIONS,
    SYNC_WRITE_TX_TIMEOUT_MS,
    chunk,
} from '@/app-layer/integrations/sync-transaction';
import { SYNC_LOCK_TTL_MS } from '@/app-layer/integrations/connection-lock';
import { DEFAULT_TIMEOUT_MS } from '@/app-layer/integrations/bounded-fetch';
import {
    MAX_ABSORBED_RETRY_AFTER_MS,
    MAX_HTTP_ATTEMPTS,
} from '@/app-layer/integrations/http-resilience';
import {
    WORKDAY_MAX_PAGES_PER_RUN,
    WORKDAY_MAX_PER_RUN,
    WORKDAY_PAGE_SIZE,
} from '@/app-layer/integrations/providers/workday/roster';
import * as fs from 'fs';
import * as path from 'path';
import { functionBodyOf } from '../helpers/source-blocks';

/**
 * Prisma 7.10.0's interactive-transaction default, restated here as the number
 * this change exists to stop inheriting. It is not imported because Prisma
 * does not export it — which is precisely why nobody chose it.
 */
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

describe('the write phase fits inside the lease it runs under', () => {
    it('leaves at least half the lock lease for the provider read', () => {
        // NECESSARY, NOT SUFFICIENT, and the difference is still worth
        // stating: this bounds the WRITE phase alone. The read phase is
        // bounded by the block below, and neither assertion implies the other
        // — this one would stay green if the read deadline were deleted.
        expect(SYNC_WRITE_PHASE_BUDGET_MS).toBeLessThanOrEqual(SYNC_LOCK_TTL_MS / 2);
    });

    it('derives the chunk count from the ceiling rather than restating it', () => {
        // A hand-written MAX_SYNC_WRITE_CHUNKS would drift silently the first
        // time somebody changed the chunk size, and the budget above would go
        // on reporting the old, comfortable number.
        expect(MAX_SYNC_WRITE_CHUNKS).toBe(Math.ceil(MAX_SYNC_ROWS_PER_RUN / SYNC_UPSERT_CHUNK_SIZE));
        // Two walks of the roster (upsert, then manager links) plus the
        // reconcile — the shape hris-sync actually has.
        expect(SYNC_WRITE_PHASE_BUDGET_MS).toBe((2 * MAX_SYNC_WRITE_CHUNKS + 1) * SYNC_WRITE_TX_TIMEOUT_MS);
    });

    it('covers the largest roster either provider can hand back in one run', () => {
        // HRIS MAX_EMPLOYEES is 10,000 and identity MAX_USERS is 5,000, so the
        // budget has to be derived from the worse of the two. A ceiling below
        // either would make the arithmetic above describe a run that cannot
        // happen.
        expect(MAX_SYNC_ROWS_PER_RUN).toBeGreaterThanOrEqual(10_000);
    });
});

describe('the READ phase fits inside the lease too (#2508)', () => {
    /**
     * What the read would cost with no deadline: every page burning a full
     * retry ladder. Computed here rather than exported from source, because it
     * is the DIAGNOSIS — the number the deadline exists to replace — and a
     * constant nothing consumes is the shape #1970 deleted.
     *
     * A LOWER bound on that cost, not the cost. `WORKDAY_MAX_PAGES_PER_RUN`
     * counts the pages needed to reach the ROW cap with no dropped rows, and
     * the reader drops rows with no work email, so a real report can page
     * further. That only makes the assertion below stronger: even the
     * optimistic figure already overruns the lease.
     */
    const UNBOUNDED_ROSTER_READ_MS = WORKDAY_MAX_PAGES_PER_RUN * MAX_HTTP_REQUEST_MS;

    it('composes read + write — the SUBTOTAL #2508 was opened for', () => {
        // Kept, and demoted. This was the headline assertion until #2522, and
        // it is now a term: read + write is the part of the lease-held total
        // these two budgets cover, and the block below asserts the total. Left
        // standing because it localises a failure — if the three-phase
        // assertion goes red and this one does not, the bookkeeping term is
        // what moved.
        expect(ROSTER_READ_PHASE_BUDGET_MS + SYNC_WRITE_PHASE_BUDGET_MS)
            .toBeLessThanOrEqual(SYNC_LOCK_TTL_MS);
    });

    it('derives one request from the three layers that bound it', () => {
        expect(MAX_HTTP_REQUEST_MS).toBe(
            MAX_HTTP_ATTEMPTS * DEFAULT_TIMEOUT_MS
                + (MAX_HTTP_ATTEMPTS - 1) * MAX_ABSORBED_RETRY_AFTER_MS,
        );
    });

    it('counts one FEWER sleep than attempt, because the last attempt throws', () => {
        // #2508's own description composed this as attempts × (timeout +
        // Retry-After) and came out 60 s per request high. `createResilientFetch`
        // throws on the final attempt instead of sleeping after it, so the
        // naive product is a strict over-estimate — asserted as a strict
        // inequality so re-deriving it the naive way fails here rather than
        // quietly inflating the read budget.
        expect(MAX_HTTP_REQUEST_MS).toBeLessThan(
            MAX_HTTP_ATTEMPTS * (DEFAULT_TIMEOUT_MS + MAX_ABSORBED_RETRY_AFTER_MS),
        );
    });

    it('allows exactly one in-flight request to finish after the deadline', () => {
        // The deadline is checked BETWEEN pages, never mid-request, so the
        // enforced ceiling is the deadline plus one full request. Omitting
        // that overshoot would make the composition above a claim the reader
        // does not honour.
        expect(ROSTER_READ_PHASE_BUDGET_MS).toBe(ROSTER_READ_DEADLINE_MS + MAX_HTTP_REQUEST_MS);
    });

    it('leaves room INSIDE the deadline for everything that precedes paging', () => {
        // Adding MAX_HTTP_REQUEST_MS once, rather than twice, holds only
        // because everything Workday does before the paging loop starts
        // completes before the deadline. Break this and a run could spend a
        // request reaching the loop and another leaving it, putting the real
        // worst case outside the budget above.
        //
        // TWO THINGS PRECEDE THE LOOP, not one, and #2522 found the second:
        // the OAuth token exchange, and the `persistSecret` callback it fires
        // on rotation — which is a BOOKKEEPING TRANSACTION, opened and
        // committed inside this window. Asserting the request alone described
        // a pre-loop cost 15 s smaller than the real one.
        //
        // STRICTLY less than. `toBeLessThanOrEqual` would be enough for that
        // arithmetic and would NOT be enough for the other claim the source
        // makes: the reader's check is `now >= deadline`, so on equality a
        // maximally slow token exchange lands exactly on the deadline and the
        // run reads zero pages. The strict form is what makes "every run
        // attempts at least one page" true.
        expect(MAX_HTTP_REQUEST_MS + SYNC_BOOKKEEPING_TX_TIMEOUT_MS)
            .toBeLessThan(ROSTER_READ_DEADLINE_MS);
    });

    /**
     * ═══ THE OVERSHOOT TERM IS A CLAIM ABOUT PROVIDER CODE, SO CHECK IT ═══
     *
     * Every assertion above is arithmetic over constants, and arithmetic cannot
     * notice when a provider stops honouring the shape the arithmetic assumes.
     * The budget adds ONE `MAX_HTTP_REQUEST_MS` because "a page is one request,
     * and the deadline is checked between pages". OrangeHRM broke that premise
     * (#2587): its page issues a list request plus two bounded-concurrency
     * fan-outs, up to 150 requests, and a page entered one millisecond before
     * the deadline would have run fourteen further request-times past it.
     *
     * The fix restored the premise rather than renegotiating the budget — the
     * fan-outs are parallel, so a batch costs one request-time, and each
     * consults the read budget before claiming more work. THAT is the property
     * this guard has to hold, because it is the one keeping the number above
     * honest, and it lives in provider source rather than in a constant.
     *
     * Bounded read: `functionBodyOf`, not the whole file — a needle satisfied
     * anywhere in a 700-line module would let the checked call be deleted while
     * a sibling kept this green.
     */
    it('every OrangeHRM fan-out inside the page loop yields to the read deadline', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/integrations/providers/orangehrm/roster.ts'),
            'utf-8',
        );
        const body = functionBodyOf(src, 'readOrangeHrmRoster');
        const fanOuts = body.match(/mapWithConcurrency\(/g) ?? [];
        // The page loop has exactly two: enrichment, then supervisor
        // resolution. A third that does not yield would reopen the overshoot.
        expect(fanOuts.length).toBeGreaterThan(0);
        const yields = body.match(/readBudgetSpent,/g) ?? [];
        expect(yields.length).toBe(fanOuts.length);
    });

    it('the deadline is not vacuous — the unbounded read really did overrun', () => {
        // Without this, a deadline set above the unbounded worst case would
        // satisfy every assertion here while bounding nothing at all. Both
        // halves are asserted: the read WAS longer than the lease, and the
        // deadline IS shorter than the read. Read against a LOWER bound (see
        // the constant above), so both hold a fortiori for the real read.
        expect(UNBOUNDED_ROSTER_READ_MS).toBeGreaterThan(SYNC_LOCK_TTL_MS);
        expect(ROSTER_READ_DEADLINE_MS).toBeLessThan(UNBOUNDED_ROSTER_READ_MS);
    });

    it('derives the page count from the row cap rather than restating it', () => {
        expect(WORKDAY_MAX_PAGES_PER_RUN).toBe(Math.ceil(WORKDAY_MAX_PER_RUN / WORKDAY_PAGE_SIZE));
        // Positive control on the population: a zero page count would make
        // UNBOUNDED_ROSTER_READ_MS zero and the non-vacuity test above would
        // fail loudly rather than silently — but assert it anyway, because a
        // ONE-page cap would keep that test passing while describing a
        // provider that never pages.
        expect(WORKDAY_MAX_PAGES_PER_RUN).toBeGreaterThan(1);
    });
});

describe('the THIRD phase is in the composition too (#2522)', () => {
    /**
     * WHAT THESE ASSERTIONS CERTIFY: that the constants compose — that the sum
     * of the three phase budgets is inside the lease.
     *
     * WHAT THEY DO NOT CERTIFY: that a run opens only the transactions this
     * sum counts. Adding a SIXTH bookkeeping transaction to the long path
     * moves no constant in this file, so every assertion here would stay
     * green — and that is exactly how the count sat on this branch one short,
     * at four against a reachable five, through a fully green CI run and every
     * mutation its author thought to run. Nor do they certify that a lease-held
     * transaction carries either of these two timeouts at all: one opened with
     * a third value is in no term of this sum and in no census. Both are
     * measured against a real run in
     * `tests/unit/sync-transaction-shape.test.ts`, which counts the
     * bookkeeping transactions `runHrisSync` actually opens against this same
     * `MAX_SYNC_BOOKKEEPING_TXS`, and asserts the timeout partition over the
     * long arms rather than over the short one.
     */
    it('composes read + write + BOOKKEEPING against the lease', () => {
        // The assertion #2522 was opened for. Every term is lease-held, so
        // whichever number has to move to keep this true is somebody's
        // decision — which is the whole job of this file.
        expect(SYNC_LEASE_HELD_BUDGET_MS).toBeLessThanOrEqual(SYNC_LOCK_TTL_MS);
    });

    it('the total is the SUM OF THREE terms, not two', () => {
        expect(SYNC_LEASE_HELD_BUDGET_MS).toBe(
            ROSTER_READ_PHASE_BUDGET_MS + SYNC_WRITE_PHASE_BUDGET_MS + SYNC_BOOKKEEPING_PHASE_BUDGET_MS,
        );
        // And the third term is really there. Dropping it would leave the
        // headline assertion above green — a two-phase subtotal fits the
        // lease, which is exactly the thing #2522 says is not enough — so the
        // strict inequality is what makes the omission fail rather than pass.
        expect(SYNC_LEASE_HELD_BUDGET_MS)
            .toBeGreaterThan(ROSTER_READ_PHASE_BUDGET_MS + SYNC_WRITE_PHASE_BUDGET_MS);
    });

    it('derives the bookkeeping term from a COUNT of transactions', () => {
        expect(MAX_SYNC_BOOKKEEPING_TXS)
            .toBe(SYNC_BOOKKEEPING_TXS_BEFORE_READ + SYNC_BOOKKEEPING_TXS_AFTER_READ);
        expect(SYNC_BOOKKEEPING_PHASE_BUDGET_MS)
            .toBe(MAX_SYNC_BOOKKEEPING_TXS * SYNC_BOOKKEEPING_TX_TIMEOUT_MS);
        // At least one of them is opened BEFORE the read clock starts — the
        // run-open, which commits the RUNNING row. The lock is taken in
        // `jobs/hris-sync.ts` before `runHrisSync` is called, and `start` is
        // taken after that transaction commits, so a zero here would claim the
        // lease and the read deadline start together. They do not, and that
        // gap is the half of #2522 no other budget can see.
        expect(SYNC_BOOKKEEPING_TXS_BEFORE_READ).toBeGreaterThanOrEqual(1);
    });

    it('the third term is not decorative — the subtotal is BLIND to it', () => {
        // Non-vacuity, in the shape the deadline's own test uses: show the
        // term changes a verdict. `SYNC_WRITE_PHASE_BUDGET_MS` never mentions
        // the bookkeeping timeout, so the two-phase subtotal is unmoved by ANY
        // value of it — including one that puts the real lease-held total over
        // the lease.
        const leaseHeldAt = (bookkeepingTimeoutMs: number) =>
            ROSTER_READ_PHASE_BUDGET_MS
            + SYNC_WRITE_PHASE_BUDGET_MS
            + MAX_SYNC_BOOKKEEPING_TXS * bookkeepingTimeoutMs;
        // Raising it is a REASONABLE change for a future author to make: the
        // constant's own comment says the failure mode of a number too small
        // is silence, which argues for a bigger one.
        const RAISED_MS = 45_000;
        expect(RAISED_MS).toBeGreaterThan(SYNC_BOOKKEEPING_TX_TIMEOUT_MS);
        // The subtotal: unchanged, and still comfortable.
        expect(ROSTER_READ_PHASE_BUDGET_MS + SYNC_WRITE_PHASE_BUDGET_MS)
            .toBeLessThanOrEqual(SYNC_LOCK_TTL_MS);
        // The real total at that timeout: over the lease, which is #2508's
        // corruption becoming reachable again with nothing red.
        expect(leaseHeldAt(RAISED_MS)).toBeGreaterThan(SYNC_LOCK_TTL_MS);
        // Tied back to the shipped constant, so the hypothetical above cannot
        // drift away from the number actually in force.
        expect(leaseHeldAt(SYNC_BOOKKEEPING_TX_TIMEOUT_MS)).toBe(SYNC_LEASE_HELD_BUDGET_MS);
    });

    it('leaves residual margin for the two transactions the sum does NOT carry', () => {
        // `jobs/hris-sync.ts` wraps `acquireSyncLock` and `releaseSyncLock` in
        // `runInTenantContext` with no options, so each inherits the same 5 s
        // default the block below refuses, and the lease clock starts at the
        // `syncLockedAt` acquire writes rather than at its commit. No constant
        // is folded in for them — nothing enforces one, and a constant with no
        // consumer is the ghost this file's header records. Asserting the
        // RESIDUAL instead keeps the omission honest: the margin under the TTL
        // has to be wide enough to hold both.
        expect(SYNC_LOCK_TTL_MS - SYNC_LEASE_HELD_BUDGET_MS)
            .toBeGreaterThanOrEqual(2 * PRISMA_DEFAULT_TX_TIMEOUT_MS);
    });
});

describe('no sync transaction inherits the default nobody chose', () => {
    it('both budgets are explicit and larger than Prisma 7.10.0 grants by default', () => {
        expect(SYNC_WRITE_TX_TIMEOUT_MS).toBeGreaterThan(PRISMA_DEFAULT_TX_TIMEOUT_MS);
        // The bookkeeping budget matters MOST here, because its transactions
        // are the ones whose whole job is to leave evidence. A bookkeeping
        // write that times out takes the record of the failure with it, and
        // the failure mode of that is silence — the thing #2501 is about.
        expect(SYNC_BOOKKEEPING_TX_TIMEOUT_MS).toBeGreaterThan(PRISMA_DEFAULT_TX_TIMEOUT_MS);
    });

    it('the exported options objects carry those numbers', () => {
        // The usecases pass these objects straight to `runInTenantContext`,
        // which forwards `timeout`/`maxWait` to `$transaction` only when
        // present — so an options object missing `timeout` silently restores
        // the 5 s default with no diff at the call site.
        expect(SYNC_WRITE_TX_OPTIONS.timeout).toBe(SYNC_WRITE_TX_TIMEOUT_MS);
        expect(SYNC_WRITE_TX_OPTIONS.maxWait).toBe(SYNC_WRITE_TX_MAX_WAIT_MS);
        expect(SYNC_BOOKKEEPING_TX_OPTIONS.timeout).toBe(SYNC_BOOKKEEPING_TX_TIMEOUT_MS);
    });
});

describe('chunk()', () => {
    it('opens no transaction for an empty roster', () => {
        // Relied on by both syncs: an empty page must not cost a pooled
        // connection, and the final run of a resumed pass legitimately reads
        // one.
        expect(chunk([], 10)).toEqual([]);
    });

    it('splits into consecutive groups of at most `size`', () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('refuses a size that would loop forever', () => {
        expect(() => chunk([1], 0)).toThrow(/chunk size/);
    });
});
