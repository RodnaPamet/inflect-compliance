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
 * `$transaction` turns this suite red.
 *
 * WHAT CHANGING A NUMBER DOES, precisely — an earlier draft of this
 * docblock said "changing a number does NOT" redden, and that is false in
 * two ways worth stating, because a future re-derivation PR reads this
 * paragraph to know what it is allowed to do:
 *
 *   • Re-deriving a limit to another DECLARED value is free. That is the
 *     expected outcome — the numbers come from a lower bound, not a
 *     measured p99 (see `src/lib/db/concurrency-limits.ts`) — and no test
 *     should have to be edited to do it.
 *   • Setting one back to its INHERITED DEFAULT reddens (`max` 10,
 *     `connectionTimeoutMillis` undefined, `maxWait` 2000, `timeout`
 *     5000). That is not an exception to the rule above, it IS the rule:
 *     reverting to the default is going back to inheriting by another
 *     route, and inheriting is the defect #2653 exists to close.
 *   • Breaking a RELATION reddens too — `connectionTimeoutMillis` must
 *     stay >= the largest `maxWait` or it silently becomes the real
 *     limit, and `timeout` must cover the design-point lock queue. Those
 *     assertions constrain the numbers jointly, not individually.
 *
 * So: re-derive freely, but the result must still be declared and still
 * satisfy the relations.
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
    TENANT_TX_MAX_WAIT_MS,
    TENANT_TX_OPTIONS,
    TENANT_TX_TIMEOUT_MS,
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

/**
 * #3266 — the same principle, one layer out.
 *
 * #2653 stated the budget for `appendAuditEntry`'s own transaction. The
 * transaction that has to START for any tenant-scoped read or write is the
 * one `db-context.ts` opens for RLS, and it was inheriting Prisma's defaults
 * at 1010 of 1018 call sites. These assertions are what makes the new numbers
 * un-removable rather than merely present.
 */
describe('#3266 — the tenant-context transaction declares its budget too', () => {
    it('`maxWait` actually displaces the inherited 2000 ms', () => {
        // The number the observed failure exceeded. A "declared" value equal
        // to the default would satisfy a presence check while changing
        // nothing, which is the shape #2653 warned about.
        expect(TENANT_TX_MAX_WAIT_MS).toBeGreaterThan(PRISMA_DEFAULT_MAX_WAIT_MS);
    });

    it('connectionTimeoutMillis >= maxWait, so the pool cannot preempt it', () => {
        // Identical invariant to the audit path's, and for the identical
        // reason: if node-postgres gives up first the declared budget is
        // fiction and the caller sees a pool error instead.
        expect(DB_POOL_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(
            TENANT_TX_MAX_WAIT_MS,
        );
    });

    it('`timeout` is STATED at Prisma’s default rather than inherited from it', () => {
        // Deliberately equal. The observed failure was at ACQUISITION, so
        // nothing measured argues for a longer body, and a longer body would
        // raise the worst-case time one caller holds a pooled connection —
        // the resource that was scarce. Stating it stops the value moving
        // when Prisma changes its mind.
        expect(TENANT_TX_TIMEOUT_MS).toBe(PRISMA_DEFAULT_TX_TIMEOUT_MS);
    });

    it('EVERY `$transaction` in db-context.ts is given the DECLARED budget', () => {
        // Two claims, because the first alone is aimed one level off the
        // defect. The original bug was `const txOptions = {}` — an options
        // object that is PASSED and carries nothing. A check for "has a
        // second argument" is satisfied by exactly that, which a mutation
        // run proved: reverting the spread to `{}` left this suite green.
        //
        // Parsed rather than grepped: a regex cannot tell a second ARGUMENT
        // from the identifier appearing in the comment above the call.
        const ts = require('typescript') as typeof import('typescript');
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const file = path.join(__dirname, '../../../src/lib/db-context.ts');
        const raw = fs.readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
        const lineOf = (n: import('typescript').Node): number =>
            sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

        const bareCalls: number[] = [];
        const unbudgeted: number[] = [];
        let calls = 0;
        let declarations = 0;

        const visit = (n: import('typescript').Node): void => {
            // (a) every `$transaction` receives a second argument at all
            if (
                ts.isCallExpression(n) &&
                ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === '$transaction'
            ) {
                calls += 1;
                if (n.arguments.length < 2) bareCalls.push(lineOf(n));
            }
            // (b) every `txOptions` starts FROM the declared budget, so an
            //     empty object cannot masquerade as a declared one
            if (
                ts.isVariableDeclaration(n) &&
                ts.isIdentifier(n.name) &&
                n.name.text === 'txOptions'
            ) {
                declarations += 1;
                const init = n.initializer;
                const spreadsBudget =
                    init !== undefined &&
                    ts.isObjectLiteralExpression(init) &&
                    init.properties.some(
                        (prop) =>
                            ts.isSpreadAssignment(prop) &&
                            ts.isIdentifier(prop.expression) &&
                            prop.expression.text === 'TENANT_TX_OPTIONS',
                    );
                if (!spreadsBudget) unbudgeted.push(lineOf(n));
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);

        // Denominators beside the results: a walker that found nothing would
        // report zero of both.
        expect(calls).toBeGreaterThanOrEqual(4);
        expect(declarations).toBeGreaterThanOrEqual(3);
        expect(bareCalls).toEqual([]);
        expect(unbudgeted).toEqual([]);
    });

    it('the TEST cleanup transaction declares it too — it is on the same pool', () => {
        // Why a src/ budget test reaches into tests/: the failure that opened
        // #3266 did not surface in src/. It surfaced as
        // `tests/integration/audit-hash-chain.test.ts` going red on an
        // assertion about chain validity, two tests away from the cleanup
        // that actually threw `Unable to start a transaction in the given
        // time`. The cleanup's rollback left the tampered rows in place and
        // the later test read them.
        //
        // That path runs through ONE helper, and it inherited the same
        // 2000 ms maxWait for the same reason db-context.ts did. Nothing else
        // in the repo asserts on it, so without this `it` a revert of the
        // helper is green here and comes back as a load-dependent flake in a
        // different file — the worst available failure mode, because the red
        // suite does not name the broken one.
        const ts = require('typescript') as typeof import('typescript');
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const file = path.join(__dirname, '../../helpers/audit-cleanup.ts');
        const raw = fs.readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);

        let fnFound = false;
        let budgetedCalls = 0;
        let bareCalls = 0;
        // The interface the helper types its client with. Narrowing it back to
        // a single parameter would make the budget un-passable, so the arity
        // is part of the claim rather than a detail the call site implies.
        let txParams = -1;

        const visit = (n: import('typescript').Node): void => {
            if (
                ts.isFunctionDeclaration(n) &&
                n.name?.text === 'withAuditTriggersDisabled'
            ) {
                fnFound = true;
                const inner = (m: import('typescript').Node): void => {
                    if (
                        ts.isCallExpression(m) &&
                        ts.isPropertyAccessExpression(m.expression) &&
                        m.expression.name.text === '$transaction'
                    ) {
                        const second = m.arguments[1];
                        const isBudget =
                            second !== undefined &&
                            ts.isIdentifier(second) &&
                            second.text === 'TENANT_TX_OPTIONS';
                        if (isBudget) budgetedCalls += 1;
                        else bareCalls += 1;
                    }
                    ts.forEachChild(m, inner);
                };
                ts.forEachChild(n, inner);
            }
            if (
                ts.isInterfaceDeclaration(n) &&
                n.name.text === 'RawSqlClient'
            ) {
                for (const member of n.members) {
                    if (
                        ts.isMethodSignature(member) &&
                        ts.isIdentifier(member.name) &&
                        member.name.text === '$transaction'
                    ) {
                        txParams = member.parameters.length;
                    }
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);

        // The denominator first: a renamed function or a moved file would
        // otherwise make every count below zero and pass silently.
        expect(fnFound).toBe(true);
        expect(budgetedCalls).toBe(1);
        expect(bareCalls).toBe(0);
        expect(txParams).toBeGreaterThanOrEqual(2);
    });

    it('the declared options are the ones the call sites spread', () => {
        expect(TENANT_TX_OPTIONS).toEqual({
            maxWait: TENANT_TX_MAX_WAIT_MS,
            timeout: TENANT_TX_TIMEOUT_MS,
        });
    });
});
