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
    integrationConnection: { findMany: jest.fn() },
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
