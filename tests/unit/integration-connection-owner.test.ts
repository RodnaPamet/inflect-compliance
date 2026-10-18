/**
 * Naming the person accountable for an external agent connection — the source
 * of integration passport field P11 (#3672).
 *
 * The properties, each one an edit away from being lost:
 *
 *  - ADMIN authority, the connection-write floor the upsert holds.
 *  - Only an `mcp-server` connection has an owner; any other id is a 404.
 *  - The owner must hold an ACTIVE membership of THIS tenant. The foreign key
 *    would accept any user of any tenant, so a membership check is the gate.
 *  - The write touches `ownerUserId` and NOTHING else. The connection upsert
 *    computes `isEnabled ?? true`, so routing an owner change through it would
 *    re-enable a disabled connection as a side effect.
 *  - An unchanged owner writes nothing and audits nothing; a change audits
 *    `INTEGRATION_CONNECTION_OWNER_SET` with from → to ids, which is the entry
 *    the passport's OWNER_CHANGED finding cites.
 */
const connections: Array<{ id: string; tenantId: string; provider: string; ownerUserId: string | null; isEnabled: boolean }> = [];
const memberships: Array<{ tenantId: string; userId: string; status: string }> = [];

const integrationConnection = {
    // Each predicate applies only when the query states it, so a usecase that
    // DROPS a filter reads a wider set here, as it would against Postgres.
    findFirst: jest.fn(async (args: { where: { id: string; tenantId?: string; provider?: string } }) => {
        const row = connections.find(
            (c) =>
                c.id === args.where.id
                && (args.where.tenantId === undefined || c.tenantId === args.where.tenantId)
                && (args.where.provider === undefined || c.provider === args.where.provider),
        );
        return row ? { id: row.id, ownerUserId: row.ownerUserId } : null;
    }),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = connections.find((c) => c.id === args.where.id)!;
        Object.assign(row, args.data);
        return row;
    }),
};
const tenantMembership = {
    findFirst: jest.fn(async (args: { where: { userId: string; tenantId: string; status: string } }) => {
        const m = memberships.find(
            (x) => x.userId === args.where.userId && x.tenantId === args.where.tenantId && x.status === args.where.status,
        );
        return m ? { id: `m-${m.userId}` } : null;
    }),
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb({ integrationConnection, tenantMembership }),
}));

const logEventMock = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));

import { setIntegrationConnectionOwner } from '@/app-layer/usecases/integration-passport';
import { makeRequestContext } from '../helpers/make-context';

const T = 'tenant-owner';
const OTHER_T = 'tenant-other';
const CONN = 'cmconnowner000000000000';
const ctx = () => makeRequestContext('ADMIN', { tenantId: T, userId: 'admin-1' });

beforeEach(() => {
    jest.clearAllMocks();
    connections.length = 0;
    memberships.length = 0;
    connections.push(
        { id: CONN, tenantId: T, provider: 'mcp-server', ownerUserId: null, isEnabled: false },
        { id: 'cmconnslack0000000000000', tenantId: T, provider: 'slack', ownerUserId: null, isEnabled: true },
    );
    memberships.push(
        { tenantId: T, userId: 'owner-a', status: 'ACTIVE' },
        { tenantId: T, userId: 'owner-b', status: 'ACTIVE' },
        { tenantId: T, userId: 'departed', status: 'DEACTIVATED' },
        { tenantId: OTHER_T, userId: 'elsewhere', status: 'ACTIVE' },
    );
});

describe('who may name an owner', () => {
    it('refuses a caller without admin authority, and writes nothing', async () => {
        await expect(
            setIntegrationConnectionOwner(makeRequestContext('EDITOR', { tenantId: T }), CONN, 'owner-a'),
        ).rejects.toThrow(/Admin only/);
        expect(integrationConnection.update).not.toHaveBeenCalled();
    });
});

describe('which connection may have one', () => {
    it('only an external agent connection — any other provider is a 404', async () => {
        await expect(setIntegrationConnectionOwner(ctx(), 'cmconnslack0000000000000', 'owner-a')).rejects.toMatchObject({
            status: 404,
        });
        expect(integrationConnection.update).not.toHaveBeenCalled();
    });

    it("another tenant's connection id is a 404, by the tenant filter", async () => {
        await expect(
            setIntegrationConnectionOwner(makeRequestContext('ADMIN', { tenantId: OTHER_T }), CONN, 'elsewhere'),
        ).rejects.toMatchObject({ status: 404 });
        expect(integrationConnection.update).not.toHaveBeenCalled();
    });
});

describe('who may be named', () => {
    it.each([
        ['a member of another tenant', 'elsewhere'],
        ['a member whose membership is not ACTIVE', 'departed'],
        ['a user with no membership at all', 'stranger'],
    ])('refuses %s, and writes nothing', async (_label, userId) => {
        await expect(setIntegrationConnectionOwner(ctx(), CONN, userId)).rejects.toMatchObject({ status: 400 });
        expect(integrationConnection.update).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });
});

describe('the write', () => {
    it('sets ownerUserId ONLY — a disabled connection stays disabled', async () => {
        const result = await setIntegrationConnectionOwner(ctx(), CONN, 'owner-a');

        expect(result).toEqual({ connectionId: CONN, ownerUserId: 'owner-a', changed: true });
        expect(integrationConnection.update).toHaveBeenCalledTimes(1);
        expect(integrationConnection.update.mock.calls[0][0].data).toEqual({ ownerUserId: 'owner-a' });
        expect(connections[0].isEnabled).toBe(false);
    });

    it('audits the change as INTEGRATION_CONNECTION_OWNER_SET, from → to, ids only', async () => {
        await setIntegrationConnectionOwner(ctx(), CONN, 'owner-a');
        await setIntegrationConnectionOwner(ctx(), CONN, 'owner-b');

        expect(logEventMock).toHaveBeenCalledTimes(2);
        const second = logEventMock.mock.calls[1][2];
        expect(second).toMatchObject({
            action: 'INTEGRATION_CONNECTION_OWNER_SET',
            entityType: 'IntegrationConnection',
            entityId: CONN,
            detailsJson: { category: 'custom', from: 'owner-a', to: 'owner-b' },
        });
    });

    it('an unchanged owner writes nothing and audits nothing', async () => {
        connections[0].ownerUserId = 'owner-a';
        const result = await setIntegrationConnectionOwner(ctx(), CONN, 'owner-a');

        expect(result.changed).toBe(false);
        expect(integrationConnection.update).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });

    it('null clears the owner, with no membership check, and is audited', async () => {
        connections[0].ownerUserId = 'owner-a';
        const result = await setIntegrationConnectionOwner(ctx(), CONN, null);

        expect(result).toEqual({ connectionId: CONN, ownerUserId: null, changed: true });
        expect(tenantMembership.findFirst).not.toHaveBeenCalled();
        expect(connections[0].ownerUserId).toBeNull();
        expect(logEventMock.mock.calls[0][2].detailsJson).toMatchObject({ from: 'owner-a', to: null });
    });
});
