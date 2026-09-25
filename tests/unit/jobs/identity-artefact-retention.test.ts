/**
 * The two JML artefacts stop being kept forever (#2843 finding 27).
 *
 * `IdentityWriteJournal` holds `externalUserId` and `priorStateJson` —
 * directory identifiers for real people — and `IntegrationExecution` holds the
 * run record beside it. Neither had any retention at all: the answer was
 * "forever", which is a data-minimisation exposure as much as a growth one.
 *
 * What this suite pins is the two decisions that are easy to get wrong and
 * invisible once wrong: WHICH COLUMN the age is measured on, and WHAT the
 * attestation carries.
 */
import {
    purgeIdentityArtefactsOlderThan,
    DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS,
} from '@/app-layer/jobs/data-lifecycle';

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: (_name: string, fn: () => unknown) => fn(),
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));

const NOW = new Date('2026-09-25T00:00:00.000Z');

/**
 * Argument types declared on the fakes, not left to inference.
 *
 * `jest.fn(async () => …)` infers a ZERO-argument signature, so `mock.calls[0]`
 * is a 0-tuple and every read of `[0][0]` is a type error. Declaring the
 * parameter is also the more honest fixture: it says what the production code
 * is expected to pass.
 */
type Where = { where: Record<string, { lt: Date }> };
type AuditArg = { data: { tenantId: string; entityId: string; details: string } };

function fakeDb(journal: { tenantId: string; n: number }[], execs: { tenantId: string; n: number }[]) {
    const group = (rows: { tenantId: string; n: number }[]) =>
        jest.fn(async (_args: Where) =>
            rows.map((r) => ({ tenantId: r.tenantId, _count: { _all: r.n } })),
        );
    return {
        identityWriteJournal: {
            groupBy: group(journal),
            deleteMany: jest.fn(async (_a: Where) => ({ count: 0 })),
        },
        integrationExecution: {
            groupBy: group(execs),
            deleteMany: jest.fn(async (_a: Where) => ({ count: 0 })),
        },
        auditLog: { create: jest.fn(async (_a: AuditArg) => ({ id: 'a1' })) },
    };
}

describe('identity artefact retention', () => {
    it('defaults to 730 days, matching the repo for a compliance artefact', () => {
        // Two audit cycles: an auditor sampling a 12-month period in early
        // 2026 needs early-2025 rows present.
        expect(DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS).toBe(730);
    });

    it('measures the journal on attemptedAt, not settledAt', async () => {
        // `settledAt` is NULL on a row that never settled. Pruning on it would
        // keep the unsettled rows forever — and those are exactly the ones an
        // operator most wants bounded.
        const db = fakeDb([{ tenantId: 't1', n: 3 }], []);
        await purgeIdentityArtefactsOlderThan({ db: db as never, now: NOW });

        const where = db.identityWriteJournal.groupBy.mock.calls[0][0].where;
        expect(Object.keys(where)).toContain('attemptedAt');
        expect(Object.keys(where)).not.toContain('settledAt');
    });

    it('cuts at now minus the retention window', async () => {
        const db = fakeDb([{ tenantId: 't1', n: 1 }], []);
        await purgeIdentityArtefactsOlderThan({ db: db as never, now: NOW, retentionDays: 10 });

        const cutoff = db.identityWriteJournal.groupBy.mock.calls[0][0].where.attemptedAt.lt;
        expect(cutoff.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    });

    it('deletes per tenant and attests per tenant', async () => {
        // `AuditLog.tenantId` is required, so a global run cannot attest with
        // one row — and should not: an attestation names whose data went.
        const db = fakeDb([{ tenantId: 't1', n: 2 }, { tenantId: 't2', n: 5 }], []);
        await purgeIdentityArtefactsOlderThan({ db: db as never, now: NOW });

        expect(db.identityWriteJournal.deleteMany).toHaveBeenCalledTimes(2);
        expect(db.auditLog.create).toHaveBeenCalledTimes(2);
        const tenants = db.auditLog.create.mock.calls.map((c) => c[0].data.tenantId);
        expect(tenants.sort()).toEqual(['t1', 't2']);
    });

    it('attests with COUNTS and never with an identifier', async () => {
        // The load-bearing one. Naming each purged record — which the sibling
        // evidence purge does — would copy `externalUserId` into a row that
        // outlives the journal, retaining the very data being removed.
        const db = fakeDb([{ tenantId: 't1', n: 4 }], []);
        await purgeIdentityArtefactsOlderThan({ db: db as never, now: NOW });

        const data = db.auditLog.create.mock.calls[0][0].data;
        expect(JSON.parse(data.details)).toMatchObject({ purged: 4, retentionDays: 730 });
        expect(data.entityId).not.toContain('user');
        expect(data.details).not.toMatch(/externalUserId|priorState/);
    });

    it('a dry run counts and writes nothing', async () => {
        const db = fakeDb([{ tenantId: 't1', n: 9 }], [{ tenantId: 't1', n: 2 }]);
        const r = await purgeIdentityArtefactsOlderThan({ db: db as never, now: NOW, dryRun: true });

        expect(db.identityWriteJournal.deleteMany).not.toHaveBeenCalled();
        expect(db.integrationExecution.deleteMany).not.toHaveBeenCalled();
        expect(db.auditLog.create).not.toHaveBeenCalled();
        expect(r.find((x) => x.model === 'IdentityWriteJournal')).toMatchObject({
            scanned: 9,
            purged: 0,
        });
    });

    it('writes no attestation when nothing aged out', async () => {
        const db = fakeDb([], []);
        await purgeIdentityArtefactsOlderThan({ db: db as never, now: NOW });

        expect(db.auditLog.create).not.toHaveBeenCalled();
        expect(db.identityWriteJournal.deleteMany).not.toHaveBeenCalled();
    });
});
