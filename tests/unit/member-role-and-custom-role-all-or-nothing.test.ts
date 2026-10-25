/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * The members page's Save sends a role and a custom role in one PATCH, and the
 * server applies the two together or not at all (#4118).
 *
 * The route used to run them as two usecases, role first, each in its own
 * transaction. A custom role the caller may not grant — or one deleted since
 * the page loaded — was refused AFTER the role change had committed, so the
 * page reported a failure while the member's role had moved. Now every check
 * of both halves runs before either write, and the audit rows are written
 * after both writes.
 *
 * Driven through the real route, so the dispatch to the combined usecase is
 * what is under test, not only the usecase.
 */
import { strictMock } from '../helpers/strict-mock';

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn().mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null }),
        appendAuditEntryOrQueue: jest.fn().mockResolvedValue({ recorded: 'chain', auditId: 'a' }),
    }),
);
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';

import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });
const admin = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });

/**
 * A transaction client holding one ACTIVE READER membership and, unless
 * `customRole` is null, one custom role. Every transaction the route opens
 * gets the same client, so a write in a first transaction is still visible.
 */
function membershipDb(customRole: Record<string, unknown> | null) {
    const row = {
        id: 'm-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        role: 'READER',
        status: 'ACTIVE',
        customRoleId: null,
        user: { id: 'u-1', name: 'U', email: 'u@example.com' },
    };
    const db = {
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(row),
            count: jest.fn().mockResolvedValue(2),
            update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
                ...row,
                ...args.data,
                customRole: customRole ? { id: customRole.id, name: customRole.name } : null,
            })),
        },
        tenantCustomRole: { findFirst: jest.fn().mockResolvedValue(customRole) },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

const REVIEWERS = {
    id: 'cr-1',
    tenantId: 'tenant-1',
    name: 'Reviewers',
    baseRole: 'READER',
    permissionsJson: {},
    isActive: true,
};

const patch = (body: unknown) =>
    new NextRequest('http://localhost/api/t/acme/admin/members/m-1', {
        method: 'PATCH',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
const args = { params: Promise.resolve({ tenantSlug: 'acme', membershipId: 'm-1' }) };
const route = () =>
    import('@/app/api/t/[tenantSlug]/admin/members/[membershipId]/route') as Promise<{
        PATCH: (r: NextRequest, a: unknown) => Promise<Response>;
    }>;

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async () => {
        throw new Error('the database was reached');
    });
});

describe('PATCH { role, customRoleId } — all or nothing', () => {
    it('a custom role that no longer exists refuses the whole request: the role is not written', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const db = membershipDb(null);
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'EDITOR', customRoleId: 'cr-gone' }), args);
        expect(res.status).toBe(404);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('a custom role the caller may not grant refuses the whole request: the role is not written', async () => {
        getTenantCtxMock.mockResolvedValue(admin());
        // An ADMIN does not hold `admin.tenant_lifecycle`, so cannot hand it out.
        const db = membershipDb({ ...REVIEWERS, permissionsJson: { admin: { tenant_lifecycle: true } } });
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'EDITOR', customRoleId: 'cr-1' }), args);
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).toContain('Cannot grant permissions you do not hold');
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('a refused role change writes no custom role either', async () => {
        getTenantCtxMock.mockResolvedValue(admin());
        const db = membershipDb(REVIEWERS);
        // The only ADMIN, moved to EDITOR: the last-admin rule refuses it.
        db.tenantMembership.findFirst.mockResolvedValue({
            id: 'm-1',
            userId: 'u-1',
            role: 'ADMIN',
            status: 'ACTIVE',
            customRoleId: null,
            user: { id: 'u-1', name: 'U', email: 'u@example.com' },
        });
        db.tenantMembership.count.mockResolvedValue(1);
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'EDITOR', customRoleId: 'cr-1' }), args);
        expect(res.status).toBe(403);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('when both pass, both are written in ONE transaction, and both audit rows follow both writes', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const db = membershipDb(REVIEWERS);
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'EDITOR', customRoleId: 'cr-1' }), args);
        expect(res.status).toBe(200);
        expect(mockRunInTx).toHaveBeenCalledTimes(1);

        const updates = db.tenantMembership.update.mock.calls.map((c: any[]) => c[0].data);
        expect(updates).toEqual([{ role: 'EDITOR' }, { customRoleId: 'cr-1' }]);

        const audits = (logEvent as jest.Mock).mock.calls.map((c) => c[2]);
        expect(audits.map((a) => a.action)).toEqual(['MEMBER_ROLE_CHANGED', 'MEMBER_CUSTOM_ROLE_CHANGED']);
        expect(audits[0].detailsJson).toMatchObject({ fromStatus: 'READER', toStatus: 'EDITOR' });
        expect(audits[1].detailsJson).toMatchObject({ fromStatus: 'none', toStatus: 'cr-1' });

        const lastWrite = Math.max(...db.tenantMembership.update.mock.invocationCallOrder);
        const firstAudit = Math.min(...(logEvent as jest.Mock).mock.invocationCallOrder);
        expect(firstAudit).toBeGreaterThan(lastWrite);
    });

    it('the custom-role half is judged against the role the member is about to hold', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const db = membershipDb(REVIEWERS);
        const { PATCH } = await route();
        // Clearing names the NEW role in its audit sentence, not the old one.
        const res = await PATCH(patch({ role: 'AUDITOR', customRoleId: null }), args);
        expect(res.status).toBe(200);
        expect(db.tenantMembership.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
            { role: 'AUDITOR' },
            { customRoleId: null },
        ]);
        const custom = (logEvent as jest.Mock).mock.calls.map((c) => c[2]).find((a) => a.action === 'MEMBER_CUSTOM_ROLE_CHANGED');
        expect(custom.details).toContain('fallback to AUDITOR');
    });
});

describe('a body naming one half is unchanged', () => {
    it.each([
        [{ role: 'EDITOR' }, [{ role: 'EDITOR' }], ['MEMBER_ROLE_CHANGED']],
        [{ customRoleId: 'cr-1' }, [{ customRoleId: 'cr-1' }], ['MEMBER_CUSTOM_ROLE_CHANGED']],
    ])('%j writes %j', async (body, writes, actions) => {
        getTenantCtxMock.mockResolvedValue(owner());
        const db = membershipDb(REVIEWERS);
        const { PATCH } = await route();
        const res = await PATCH(patch(body), args);
        expect(res.status).toBe(200);
        expect(db.tenantMembership.update.mock.calls.map((c: any[]) => c[0].data)).toEqual(writes);
        expect((logEvent as jest.Mock).mock.calls.map((c) => c[2].action)).toEqual(actions);
    });
});
