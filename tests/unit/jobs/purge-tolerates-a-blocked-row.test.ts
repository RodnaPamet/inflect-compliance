/**
 * ONE BLOCKED ROW MUST NOT STOP THE PLATFORM-WIDE PURGE — #5083.
 *
 * Several child FKs onto the soft-delete models are ON DELETE RESTRICT
 * (`ControlTestRun`, `ControlTestPlan`, `ControlException`,
 * `RiskTreatmentPlan`, and the registered-agent and A2A-peer vendor
 * references), and the soft-delete usecases leave those children in place. So
 * an ordinary deleted control that once had a test run raised SQLSTATE 23503
 * in the per-row DELETE ninety days later, `runJob` rethrew, and this sweep
 * has NO tenant filter — one row stopped the purge for EVERY tenant, and
 * everything the executor awaits after it never ran: the remaining
 * soft-delete models, the expired-evidence purge, the identity and
 * legacy-snapshot retention purges, `runRetentionSweep`, and the soft-deleted
 * TENANT purge. The row stayed, so it recurred every day.
 *
 * Driven through the injected `db` rather than a real FK, because the
 * properties under test are control flow — continue, count, and RETHROW
 * anything that is not an FK violation — and the last of those cannot be
 * arranged with a real constraint.
 */
import { purgeSoftDeletedOlderThan } from '@/app-layer/jobs/data-lifecycle';
import { SOFT_DELETE_MODELS } from '@/lib/soft-delete';

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const MODELS = [...SOFT_DELETE_MODELS] as string[];
const keyOf = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);

/** A row per soft-delete model, so every model has something to purge. */
function makeDb(onDelete: (sql: string, id: string) => void) {
    const db: Record<string, unknown> = {
        $executeRawUnsafe: jest.fn(async (sql: string, id: string) => {
            onDelete(sql, id);
            return 1;
        }),
        auditLog: { create: jest.fn(async () => ({})) },
    };
    for (const model of MODELS) {
        db[keyOf(model)] = {
            findMany: jest.fn(async () => [{ id: `${model}-1`, tenantId: 't-1' }]),
            update: jest.fn(async () => ({})),
        };
    }
    return db;
}

function fkError(): Error & { code: string } {
    const err = new Error('update or delete on table violates foreign key constraint') as Error & {
        code: string;
    };
    err.code = '23503';
    return err;
}

describe('purgeSoftDeletedOlderThan — a RESTRICT child does not stop the sweep (#5083)', () => {
    it('keeps purging every LATER model after one row is blocked', async () => {
        // The blocked row is on the FIRST model, so a sweep that aborts would
        // purge nothing at all — which is what it used to do.
        const blockedModel = MODELS[0];
        const db = makeDb((sql) => {
            if (sql.includes(`"${blockedModel}"`)) throw fkError();
        });

        const results = await purgeSoftDeletedOlderThan({
            db: db as never,
            now: new Date('2030-01-01T00:00:00Z'),
        });

        const blocked = results.find((r) => r.model === blockedModel)!;
        expect({ purged: blocked.purged, blocked: blocked.blocked })
            .toEqual({ purged: 0, blocked: 1 });

        // Every other model still ran and still purged its row.
        const others = results.filter((r) => r.model !== blockedModel);
        expect(others.length).toBeGreaterThan(5);
        for (const r of others) {
            expect({ model: r.model, purged: r.purged }).toEqual({ model: r.model, purged: 1 });
        }
    });

    it('reports the blocked COUNT, so a standing refusal is visible', async () => {
        // A blocked row is retried every pass. A count that stays non-zero is
        // the signal that an edge needs deciding, not retrying — so it has to
        // be reported rather than swallowed.
        const db = makeDb(() => { throw fkError(); });
        const results = await purgeSoftDeletedOlderThan({
            db: db as never,
            now: new Date('2030-01-01T00:00:00Z'),
        });
        expect(results.every((r) => r.blocked === 1)).toBe(true);
        expect(results.every((r) => r.purged === 0)).toBe(true);
    });

    it('writes NO audit row for a row it did not purge', async () => {
        // A DATA_PURGED entry for a row that is still there would be a false
        // record in a hash-chained log.
        const db = makeDb(() => { throw fkError(); });
        await purgeSoftDeletedOlderThan({
            db: db as never,
            now: new Date('2030-01-01T00:00:00Z'),
        });
        const auditCreate = (db.auditLog as { create: jest.Mock }).create;
        expect(auditCreate).not.toHaveBeenCalled();
    });

    it('RETHROWS anything that is not a foreign-key violation', async () => {
        // The property that keeps this a narrow tolerance rather than a
        // blanket "ignore errors": a connection failure or a permission error
        // must still stop the job loudly.
        const boom = new Error('connection terminated unexpectedly');
        const db = makeDb(() => { throw boom; });
        await expect(
            purgeSoftDeletedOlderThan({ db: db as never, now: new Date('2030-01-01T00:00:00Z') }),
        ).rejects.toThrow(/connection terminated/);
    });

    it('purges normally when nothing is blocked', async () => {
        // The positive control: the try/catch must not change the happy path.
        const db = makeDb(() => {});
        const results = await purgeSoftDeletedOlderThan({
            db: db as never,
            now: new Date('2030-01-01T00:00:00Z'),
        });
        expect(results.every((r) => r.purged === 1 && r.blocked === 0)).toBe(true);
    });
});
