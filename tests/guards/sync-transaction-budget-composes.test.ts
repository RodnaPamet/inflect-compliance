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
 */
import {
    MAX_SYNC_ROWS_PER_RUN,
    MAX_SYNC_WRITE_CHUNKS,
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

/**
 * Prisma 7.10.0's interactive-transaction default, restated here as the number
 * this change exists to stop inheriting. It is not imported because Prisma
 * does not export it — which is precisely why nobody chose it.
 */
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

describe('the write phase fits inside the lease it runs under', () => {
    it('leaves at least half the lock lease for the provider read', () => {
        // NECESSARY, NOT SUFFICIENT, and the difference is stated rather than
        // implied. This bounds the WRITE phase only. The roster read's own
        // worst case — MAX_HTTP_ATTEMPTS × (request timeout + absorbed
        // Retry-After), across up to ten sequential pages — is larger than the
        // whole lease on its own, and #2501 deliberately did not change it;
        // #2508 carries that half, including the lock comment that cites a
        // 120 s per-page budget no constant in the tree actually has.
        // What this asserts is that the half of the run this change DOES
        // govern cannot be the half that overruns the lease.
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
