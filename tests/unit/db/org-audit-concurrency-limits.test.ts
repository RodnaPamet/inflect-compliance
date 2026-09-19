/**
 * #2661 — the ORG audit path declares its concurrency limits.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT THIS TEST IS FOR
 * ═══════════════════════════════════════════════════════════════════
 *
 * `src/lib/audit/org-audit-writer.ts` had the identical defect #2653
 * closed one file over: `$transaction` with no options object, so
 * `maxWait` and `timeout` were whatever Prisma happened to default to.
 * Inheriting a limit is not choosing one, and the numbers that
 * actually bound the org audit write path were therefore undeclared.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT MAKES IT A PROOF RATHER THAN A GREEN TEST
 * ═══════════════════════════════════════════════════════════════════
 *
 * Two properties, and the second is the one that matters:
 *
 *   • Deleting the second argument to `$transaction` reddens — the
 *     options are read from the REAL `appendOrgAuditEntry`, driven
 *     with a stub client that records what it was handed. Asserting
 *     against `AUDIT_APPEND_TX_OPTIONS` directly would pass forever
 *     with the call site reverted, because the constant would still
 *     be there; it is the CALL SITE that has to be observed.
 *
 *   • Reverting a value to its INHERITED DEFAULT reddens (`maxWait`
 *     2000, `timeout` 5000). A test that only asserted "some number
 *     is present" would accept the exact defaults this issue exists
 *     to displace, which is a gate narrow enough to always pass.
 *
 * The stub does NOT run the callback. The transaction body is covered
 * by the DB-backed org audit suite; what is under test here is the
 * second argument, and running the body would only couple this to a
 * database it does not need.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY IT SHARES THE TENANT PATH'S CONSTANTS
 * ═══════════════════════════════════════════════════════════════════
 *
 * Deliberately the same `AUDIT_APPEND_TX_OPTIONS`, not a parallel set.
 * Both writers serialise on a per-key `pg_advisory_xact_lock` taken
 * INSIDE the transaction, for a body of the same shape, so the queue
 * the budgets must cover is the same queue. A second copy of the
 * numbers would be a second source of truth, and would drift the first
 * time only one was revised.
 *
 * The consequence worth stating: this file and
 * `audit-concurrency-limits.test.ts` both fail if someone edits the
 * shared constants. That is correct — they are shared, and a change to
 * them IS a change to both paths.
 */

import type { PrismaClient } from '@prisma/client';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import {
    AUDIT_APPEND_MAX_WAIT_MS,
    AUDIT_APPEND_TIMEOUT_MS,
    AUDIT_APPEND_TX_OPTIONS,
} from '@/lib/db/concurrency-limits';

// ─── The defaults these limits had to displace ────────────────────────
//
// Documented on Prisma's `PrismaClientOptions.transactionOptions`, and
// the 2000 is the number the observed CI failure in #2653 exceeded.
const PRISMA_DEFAULT_MAX_WAIT_MS = 2_000;
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

/**
 * The options `appendOrgAuditEntry` actually passed to `$transaction`.
 *
 * Drives the REAL function. The recorded value is the second argument
 * as the call site handed it over — not a re-import of the constant.
 */
async function observedOrgTxOptions(): Promise<unknown> {
    let seen: unknown = 'no $transaction call';
    const client = {
        $transaction: (
            _fn: (tx: unknown) => Promise<unknown>,
            options?: unknown,
        ): Promise<unknown> => {
            seen = options;
            return Promise.resolve({
                id: 'stub-id',
                entryHash: 'stub-hash',
                previousHash: null,
            });
        },
    } as unknown as PrismaClient;

    await appendOrgAuditEntry(
        {
            organizationId: 'org-A',
            actorUserId: null,
            action: 'ORG_MEMBER_ADDED',
        },
        client,
    );

    return seen;
}

describe('#2661 — the org audit path declares its concurrency limits', () => {
    describe('transaction limits reach the $transaction call site', () => {
        it('passes an options object at all — not an inherited default', async () => {
            const opts = await observedOrgTxOptions();

            // The failure mode this replaces is `$transaction(fn)` with
            // no second argument, which arrives here as `undefined`.
            expect(opts).toBeDefined();
            expect(opts).not.toBe('no $transaction call');
            expect(typeof opts).toBe('object');
        });

        it('declares `maxWait`, displacing the 2000 ms default', async () => {
            const opts = (await observedOrgTxOptions()) as {
                maxWait?: number;
            };

            expect(opts.maxWait).toBe(AUDIT_APPEND_MAX_WAIT_MS);
            // Reverting the constant to Prisma's default reddens here.
            expect(AUDIT_APPEND_MAX_WAIT_MS).not.toBe(PRISMA_DEFAULT_MAX_WAIT_MS);
        });

        it('declares `timeout` — the advisory lock waits inside the body', async () => {
            const opts = (await observedOrgTxOptions()) as {
                timeout?: number;
            };

            // `timeout` is the load-bearing one: the per-org advisory
            // lock is acquired inside the transaction, so the whole
            // lock queue is charged here rather than to `maxWait`.
            expect(opts.timeout).toBe(AUDIT_APPEND_TIMEOUT_MS);
            expect(AUDIT_APPEND_TIMEOUT_MS).not.toBe(PRISMA_DEFAULT_TX_TIMEOUT_MS);
        });

        it('hands over the SHARED options, not a private copy', async () => {
            const opts = await observedOrgTxOptions();

            // Identity, not equality. A local object with the same two
            // numbers would satisfy every assertion above while being
            // exactly the second source of truth #2661 set out to
            // avoid — this is the assertion that rejects it.
            expect(opts).toBe(AUDIT_APPEND_TX_OPTIONS);
        });
    });

    describe('the tenant path is unchanged by sharing', () => {
        it('still exposes both budgets as numbers', () => {
            // A guard against the shared constants being narrowed to
            // the org path's needs alone. Cheap, and it names the
            // coupling that this file introduces.
            expect(typeof AUDIT_APPEND_MAX_WAIT_MS).toBe('number');
            expect(typeof AUDIT_APPEND_TIMEOUT_MS).toBe('number');
            expect(AUDIT_APPEND_TIMEOUT_MS).toBeGreaterThanOrEqual(
                AUDIT_APPEND_MAX_WAIT_MS,
            );
        });
    });
});
