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
 */
import {
    MAX_HTTP_REQUEST_MS,
    MAX_SYNC_ROWS_PER_RUN,
    MAX_SYNC_WRITE_CHUNKS,
    ROSTER_READ_DEADLINE_MS,
    ROSTER_READ_PHASE_BUDGET_MS,
    SYNC_BOOKKEEPING_TX_TIMEOUT_MS,
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

    it('composes read + write against the lease, which is the whole ask', () => {
        // The assertion #2508 was opened for. Whichever of the four numbers
        // has to move to keep this true is then somebody's decision.
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

    it('leaves room INSIDE the deadline for the pre-paging token exchange', () => {
        // Adding MAX_HTTP_REQUEST_MS once, rather than twice, holds only
        // because Workday's OAuth token exchange — issued before the paging
        // loop starts — always completes before the deadline. Break this and
        // a run could spend a request reaching the loop and another leaving
        // it, putting the real worst case outside the budget above.
        //
        // STRICTLY less than. `toBeLessThanOrEqual` would be enough for that
        // arithmetic and would NOT be enough for the other claim the source
        // makes: the reader's check is `now >= deadline`, so on equality a
        // maximally slow token exchange lands exactly on the deadline and the
        // run reads zero pages. The strict form is what makes "every run
        // attempts at least one page" true.
        expect(MAX_HTTP_REQUEST_MS).toBeLessThan(ROSTER_READ_DEADLINE_MS);
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
