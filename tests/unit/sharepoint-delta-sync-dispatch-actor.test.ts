/**
 * The scheduled SharePoint sync's actor is the oldest active OWNER/ADMIN whose
 * RESOLVED permissions let them run it (#4362, owner decision 2026-10-26).
 *
 * The dispatcher took the oldest active OWNER/ADMIN by built-in role. Once the
 * sync job honoured custom roles, an oldest ADMIN whose custom role withholds
 * `evidence.upload` made that tenant's scheduled sync fail every four hours
 * with the job's own refusal. The dispatcher now resolves each candidate the
 * way a request does (`initiatorAuthority`) and asks the job's own predicate
 * (`mayRunDeltaSync`); a connection with nobody qualifying is not queued, and
 * is reported with a named reason.
 */
const prismaMock = {
    // `updateMany` is the connection-health write: the dispatcher records the
    // block on the CONNECTION, because the result and the warn line it already
    // produced are read by nobody (#4389).
    integrationConnection: { findMany: jest.fn(), updateMany: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const enqueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }));

const warnMock = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: (...a: unknown[]) => warnMock(...a), error: jest.fn(), debug: jest.fn() },
}));

import { runSharePointDeltaSyncDispatch, DELTA_SYNC_UNROUTABLE } from '@/app-layer/jobs/sharepoint-delta-sync';
import { getPermissionsForRole } from '@/lib/permissions';

const ADMIN = getPermissionsForRole('ADMIN');
const READER = getPermissionsForRole('READER');

/** An ADMIN-based custom role that withholds `evidence.upload`. */
const withoutUpload = { baseRole: 'ADMIN', permissionsJson: { evidence: { ...ADMIN.evidence, upload: false } } };

const member = (tenantId: string, userId: string, role: string, customRole: unknown = null) => ({
    tenantId,
    userId,
    role,
    customRole,
});

/** The actor each enqueued sync names, keyed by connection. */
const actors = () =>
    Object.fromEntries(
        enqueueMock.mock.calls.map(([, payload]) => [payload.connectionId, payload.actorUserId]),
    );

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.integrationConnection.updateMany.mockResolvedValue({ count: 0 });
    enqueueMock.mockResolvedValue({ id: 'job' });
    prismaMock.integrationConnection.findMany.mockResolvedValue([{ id: 'conn-A', tenantId: 'tenant-A' }]);
});

describe('the actor is the oldest OWNER/ADMIN whose resolved permissions hold evidence.upload', () => {
    it('passes over an oldest ADMIN whose custom role withholds evidence.upload, for the next one', async () => {
        // Returned oldest first, as the query orders them.
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'oldest-custom-admin', 'ADMIN', withoutUpload),
            member('tenant-A', 'next-admin', 'ADMIN'),
            member('tenant-A', 'newest-owner', 'OWNER'),
        ]);

        const r = await runSharePointDeltaSyncDispatch({} as never);

        expect(actors()).toEqual({ 'conn-A': 'next-admin' });
        expect(r).toMatchObject({ connections: 1, dispatched: 1, failed: 0, unroutable: [] });
        expect(prismaMock.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: { in: ['tenant-A'] }, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
            }),
        );
    });

    it('still takes the oldest when it qualifies, a built-in OWNER or ADMIN', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'oldest-owner', 'OWNER'),
            member('tenant-A', 'next-admin', 'ADMIN'),
        ]);

        await runSharePointDeltaSyncDispatch({} as never);

        expect(actors()).toEqual({ 'conn-A': 'oldest-owner' });
    });

    it('accepts an ADMIN whose custom role grants evidence.upload over a READER base, as the job does', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'reader-based-admin', 'ADMIN', {
                baseRole: 'READER',
                permissionsJson: { evidence: { ...READER.evidence, upload: true } },
            }),
        ]);

        await runSharePointDeltaSyncDispatch({} as never);

        expect(actors()).toEqual({ 'conn-A': 'reader-based-admin' });
    });
});

describe('a connection with nobody qualifying is not queued, and says why', () => {
    it('NO_ADMIN_WITH_EVIDENCE_UPLOAD when every OWNER/ADMIN withholds it', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'admin-1', 'ADMIN', withoutUpload),
            member('tenant-A', 'admin-2', 'ADMIN', withoutUpload),
        ]);

        const r = await runSharePointDeltaSyncDispatch({} as never);

        expect(enqueueMock).not.toHaveBeenCalled();
        expect(r.dispatched).toBe(0);
        expect(r.unroutable).toEqual([
            { tenantId: 'tenant-A', connectionId: 'conn-A', reason: DELTA_SYNC_UNROUTABLE.NO_ADMIN_WITH_EVIDENCE_UPLOAD },
        ]);
        expect(warnMock).toHaveBeenCalledWith(
            'sharepoint-delta-sync-dispatch: connection not dispatched',
            expect.objectContaining({
                tenantId: 'tenant-A',
                connectionId: 'conn-A',
                reason: 'NO_ADMIN_WITH_EVIDENCE_UPLOAD',
            }),
        );
    });

    it('NO_ACTIVE_ADMIN when the tenant has no active OWNER or ADMIN at all', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([]);

        const r = await runSharePointDeltaSyncDispatch({} as never);

        expect(enqueueMock).not.toHaveBeenCalled();
        expect(r.unroutable).toEqual([
            { tenantId: 'tenant-A', connectionId: 'conn-A', reason: DELTA_SYNC_UNROUTABLE.NO_ACTIVE_ADMIN },
        ]);
    });

    it('does not stop the other tenants, and does not read as an enqueue failure', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            { id: 'conn-A', tenantId: 'tenant-A' },
            { id: 'conn-B', tenantId: 'tenant-B' },
        ]);
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'admin-a', 'ADMIN', withoutUpload),
            member('tenant-B', 'admin-b', 'ADMIN'),
        ]);

        const r = await runSharePointDeltaSyncDispatch({} as never);

        expect(actors()).toEqual({ 'conn-B': 'admin-b' });
        expect(r).toMatchObject({ connections: 2, dispatched: 1, failed: 0 });
        expect(r.unroutable.map((u) => [u.connectionId, u.reason])).toEqual([
            ['conn-A', 'NO_ADMIN_WITH_EVIDENCE_UPLOAD'],
        ]);
    });
});

/**
 * The block reaches the CONNECTION, which is the only place an admin looks
 * (#4389).
 *
 * Before this, an unsyncable connection was reported in the dispatch result and
 * a `warn` line and nowhere else, so the integrations page showed no sign that
 * it had stopped syncing. Writing an `IntegrationExecution` row instead would
 * have been worse than silence: `getConnectionsHealth` takes `lastActivity`
 * from the most recent execution of ANY status, so a row every four hours would
 * have cleared the stale flag and made it read as healthy.
 */
describe('the dispatcher records the block on the connection', () => {
    /** The connection-health writes, in call order. */
    const healthWrites = () =>
        prismaMock.integrationConnection.updateMany.mock.calls.map(([args]) => args);

    it('marks an unroutable connection with its own reason', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'admin-1', 'ADMIN', withoutUpload),
        ]);

        await runSharePointDeltaSyncDispatch({} as never);

        const marks = healthWrites().filter((a) => a.data.syncBlockedAt instanceof Date);
        expect(marks).toHaveLength(1);
        expect(marks[0].where.id).toEqual({ in: ['conn-A'] });
        expect(marks[0].data.syncBlockedReason).toBe(DELTA_SYNC_UNROUTABLE.NO_ADMIN_WITH_EVIDENCE_UPLOAD);
    });

    it('does not re-stamp a block that is already recorded with the same reason', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([]);

        await runSharePointDeltaSyncDispatch({} as never);

        // The predicate is what makes "blocked since" mean since: a dispatcher
        // on `0 */4 * * *` would otherwise move the timestamp forever.
        const [mark] = healthWrites().filter((a) => a.data.syncBlockedAt instanceof Date);
        expect(mark.where.OR).toEqual([
            { syncBlockedAt: null },
            { syncBlockedReason: { not: DELTA_SYNC_UNROUTABLE.NO_ACTIVE_ADMIN } },
        ]);
    });

    it('clears the block for a connection it CAN route, so the banner cannot outlive its cause', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'good-admin', 'ADMIN'),
        ]);

        await runSharePointDeltaSyncDispatch({} as never);

        const clears = healthWrites().filter((a) => a.data.syncBlockedAt === null);
        expect(clears).toHaveLength(1);
        expect(clears[0].where).toEqual({ id: { in: ['conn-A'] }, syncBlockedAt: { not: null } });
        expect(clears[0].data).toEqual({ syncBlockedAt: null, syncBlockedReason: null });
    });

    it('marks nothing when every connection routes', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('tenant-A', 'good-admin', 'ADMIN'),
        ]);

        await runSharePointDeltaSyncDispatch({} as never);

        expect(healthWrites().filter((a) => a.data.syncBlockedAt instanceof Date)).toEqual([]);
    });
});
