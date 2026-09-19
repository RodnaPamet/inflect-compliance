/**
 * The audit write path's concurrency limits are DECLARED (#2653).
 *
 * The defect this pins is not a wrong number — it is an ABSENT one.
 * Before #2653 the product's supported audit concurrency was four
 * library defaults nobody had written down (node-postgres `max: 10` and
 * `connectionTimeoutMillis: undefined`; Prisma `maxWait: 2000` and
 * `timeout: 5000`), so the ceiling moved with the host and the
 * dependency version. The issue's acceptance is explicit: "a test must
 * fail if it is removed".
 *
 * So this suite asserts DECLARATION AT THE CALL SITE, not the presence
 * of a constant. A constants module whose values nothing passes to
 * `PrismaPg` or `$transaction` is exactly the failure mode, and
 * asserting on the exported constants alone would not see it. Both call
 * sites are therefore observed through doubles:
 *
 *   • `src/lib/prisma.ts`             → a recording `PrismaPg` double
 *   • `src/lib/audit/audit-writer.ts` → a stub client whose
 *                                       `$transaction` records its
 *                                       options argument
 *
 * Deleting `max`, `connectionTimeoutMillis`, or the options argument to
 * `$transaction` turns this suite red. Changing a number does NOT —
 * deliberately. The numbers are derived from a lower bound, not a
 * measured p99 (see `src/lib/db/concurrency-limits.ts`), so a future PR
 * that re-derives them from real telemetry is the expected outcome and
 * should not have to edit a test to do it. What it may not do is go
 * back to inheriting.
 *
 * The doubles are at the library boundary; the code under test — the
 * two call sites and the constants they pass — is real, and the double
 * can produce the failing input (an absent option reads as
 * `undefined`).
 *
 * No source text is read. Everything below is an imported value.
 */

// ─── Recording doubles for the Prisma boundary ────────────────────────
//
// Same shape as tests/unit/db/prisma-audit-extension.test.ts, which
// loads the real `src/lib/prisma.ts` this way. Importing that module
// builds a client at module scope, so the doubles must be registered
// before the import below.

interface RecordedPoolConfig {
    connectionString?: string;
    max?: number;
    connectionTimeoutMillis?: number;
}

const poolConfigs: RecordedPoolConfig[] = [];

jest.mock('@prisma/adapter-pg', () => ({
    PrismaPg: class PrismaPg {
        constructor(cfg: RecordedPoolConfig) {
            poolConfigs.push(cfg);
        }
    },
}));

jest.mock('@prisma/client', () => ({
    PrismaClient: class PrismaClient {
        $on(): void { /* the slow-query listener is another suite's */ }
        $extends(): this { return this; }
    },
}));

// The extension chain is not what this suite is about; identity stubs
// keep the module load cheap and pointed at the adapter construction.
jest.mock('@/lib/soft-delete', () => ({ withSoftDeleteExtension: <T>(c: T): T => c }));
jest.mock('@/lib/security/pii-middleware', () => ({ withPiiEncryptionExtension: <T>(c: T): T => c }));
jest.mock('@/lib/db/encryption-middleware', () => ({ withEncryptionExtension: <T>(c: T): T => c }));
jest.mock('@/lib/db/rls-middleware', () => ({ withRlsTripwireExtension: <T>(c: T): T => c }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/observability/metrics', () => ({ recordSlowQuery: jest.fn() }));
jest.mock('@/lib/audit-context', () => ({ getAuditContext: () => ({}) }));

// `appendAuditEntry` fires a best-effort stream after the transaction
// commits. Stubbed so this suite does not start the streamer's timers.
jest.mock('@/app-layer/events/audit-stream', () => ({ streamAuditEvent: jest.fn() }));

// Imported for the module-load side effect: constructing the client is
// what calls `new PrismaPg(...)`.
import '@/lib/prisma';

import type { PrismaClient } from '@prisma/client';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import {
    AUDIT_APPEND_DESIGN_POINT_CONCURRENCY,
    AUDIT_APPEND_MAX_WAIT_MS,
    AUDIT_APPEND_OBSERVED_LATENCY_FLOOR_MS,
    AUDIT_APPEND_TIMEOUT_MS,
    DB_POOL_CONNECTION_TIMEOUT_MS,
    DB_POOL_MAX,
} from '@/lib/db/concurrency-limits';

// ─── The defaults each limit had to displace ──────────────────────────
//
// node-postgres: measured on the installed `pg` (`new Pool({...})`
// reports max 10, connectionTimeoutMillis undefined).
// Prisma: documented on `PrismaClientOptions.transactionOptions`.
const NODE_POSTGRES_DEFAULT_MAX = 10;
const PRISMA_DEFAULT_MAX_WAIT_MS = 2_000;
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

/** The pool config `src/lib/prisma.ts` actually handed to `PrismaPg`. */
function primaryPoolConfig(): RecordedPoolConfig {
    if (poolConfigs.length === 0) {
        throw new Error('src/lib/prisma.ts constructed no PrismaPg adapter');
    }
    return poolConfigs[0];
}

/**
 * The options `appendAuditEntry` actually passed to `$transaction`.
 *
 * Drives the real function with a stub client. The stub does not run
 * the callback — the transaction BODY is covered by the DB-backed
 * suite in tests/unit/audit-trail/audit-writer.test.ts; what is under
 * test here is the second argument.
 */
async function observedTxOptions(): Promise<unknown> {
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

    await appendAuditEntry(
        {
            tenantId: 'tenant-A',
            userId: null,
            entity: 'Control',
            entityId: 'ctrl-1',
            action: 'CONTROL_CREATED',
        },
        client,
    );

    return seen;
}

describe('#2653 — the audit path declares its concurrency limits', () => {
    describe('pool limits reach the PrismaPg call site', () => {
        it('declares `max`, displacing node-postgres\'s default of 10', () => {
            const cfg = primaryPoolConfig();
            expect(typeof cfg.max).toBe('number');
            expect(cfg.max).toBe(DB_POOL_MAX);
            // An inherited ceiling is the defect, so the declared value
            // must not merely restate the default it replaced.
            expect(cfg.max).not.toBe(NODE_POSTGRES_DEFAULT_MAX);
        });

        it('declares `connectionTimeoutMillis`, displacing "wait forever"', () => {
            const cfg = primaryPoolConfig();
            expect(cfg.connectionTimeoutMillis).toBe(DB_POOL_CONNECTION_TIMEOUT_MS);
            expect(cfg.connectionTimeoutMillis).toBeDefined();
            expect(Number.isFinite(cfg.connectionTimeoutMillis)).toBe(true);
        });

        it('still passes a connectionString — the build-time fallback is intact', () => {
            // `src/lib/prisma.ts` falls back to `''` so Next's
            // "Collecting page data" phase can import route modules
            // without DATABASE_URL. Adding pool options to the same
            // object must not have displaced it.
            expect(primaryPoolConfig()).toHaveProperty('connectionString');
            expect(typeof primaryPoolConfig().connectionString).toBe('string');
        });
    });

    describe('transaction limits reach the $transaction call site', () => {
        it('declares `maxWait`, displacing the 2000 ms that #2653 exceeded', async () => {
            const opts = await observedTxOptions();
            expect(opts).toEqual(
                expect.objectContaining({ maxWait: AUDIT_APPEND_MAX_WAIT_MS }),
            );
            expect(AUDIT_APPEND_MAX_WAIT_MS).not.toBe(PRISMA_DEFAULT_MAX_WAIT_MS);
        });

        it('declares `timeout` — the advisory lock waits inside the body', async () => {
            // The lock is acquired INSIDE the transaction, so the queue
            // is charged to `timeout`, not `maxWait`. A declared
            // `maxWait` beside an inherited 5000 ms `timeout` would be
            // a budget the transaction cannot honour.
            const opts = await observedTxOptions();
            expect(opts).toEqual(
                expect.objectContaining({ timeout: AUDIT_APPEND_TIMEOUT_MS }),
            );
            expect(AUDIT_APPEND_TIMEOUT_MS).not.toBe(PRISMA_DEFAULT_TX_TIMEOUT_MS);
        });
    });

    describe('the limits are coherent with each other', () => {
        it('connectionTimeoutMillis >= maxWait, so the pool cannot preempt it', () => {
            // If node-postgres gives up first, Prisma's declared
            // `maxWait` never elapses and the declaration is dead: the
            // caller sees a pool error and the stated budget is fiction.
            expect(DB_POOL_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(
                AUDIT_APPEND_MAX_WAIT_MS,
            );
        });

        it('the pool can hold the whole design-point queue', () => {
            // N concurrent appends for one tenant hold N connections
            // simultaneously — all but one idle on the lock. A pool
            // smaller than the design point turns the lock queue into a
            // connection queue, which is #2653's observed failure.
            expect(DB_POOL_MAX).toBeGreaterThanOrEqual(
                AUDIT_APPEND_DESIGN_POINT_CONCURRENCY,
            );
        });

        it('timeout covers the design-point lock queue at the observed latency floor', () => {
            // The 25th append waits behind 24 predecessors before its
            // own work begins, and that whole wait is inside the
            // transaction body. 400 ms is a LOWER BOUND on per-append
            // latency, not a measured p99, so this is the weakest form
            // of the claim: the declared timeout must at least cover the
            // floor.
            const queueFloorMs =
                (AUDIT_APPEND_DESIGN_POINT_CONCURRENCY - 1) *
                AUDIT_APPEND_OBSERVED_LATENCY_FLOOR_MS;
            expect(AUDIT_APPEND_TIMEOUT_MS).toBeGreaterThanOrEqual(queueFloorMs);
        });
    });
});
