/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * The workspace's only ACTIVE ADMIN cannot be removed (#4118).
 *
 * Moving the only ADMIN to another role, or deactivating them, was refused;
 * removing them was allowed, so the rule had a door beside it. Removal now
 * asks the same check — one helper, `assertNotLastActiveAdmin`, which all
 * three ask — and, like the last-OWNER rule, only for an ACTIVE target: a
 * DEACTIVATED admin is not counted, so removing one changes nothing.
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

import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { ForbiddenError } from '@/lib/errors/types';
import {
    deactivateTenantMember,
    removeTenantMember,
    updateTenantMemberRole,
} from '@/app-layer/usecases/tenant-admin';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });

/** A transaction client holding one ADMIN membership in a tenant with `admins` ACTIVE ADMINs. */
function adminDb(status: 'ACTIVE' | 'DEACTIVATED', admins: number) {
    const row = {
        id: 'm-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        status,
        customRoleId: null,
        user: { id: 'u-1', name: 'U', email: 'u@example.com' },
    };
    const db = {
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(row),
            count: jest.fn().mockResolvedValue(admins),
            update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ ...row, ...args.data })),
            delete: jest.fn().mockResolvedValue(row),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

const ACTIVE_ADMIN_COUNT = { where: { tenantId: 'tenant-1', role: 'ADMIN', status: 'ACTIVE' } };

beforeEach(() => jest.clearAllMocks());

describe('removing the last ACTIVE ADMIN', () => {
    it('is refused, and nothing is deleted', async () => {
        const db = adminDb('ACTIVE', 1);
        const err = await removeTenantMember(owner(), { membershipId: 'm-1' }).catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err.message).toBe('Cannot remove the last admin. Promote another member first.');
        expect(db.tenantMembership.count).toHaveBeenCalledWith(ACTIVE_ADMIN_COUNT);
        expect(db.tenantMembership.delete).not.toHaveBeenCalled();
    });

    it('is allowed while another ACTIVE ADMIN remains', async () => {
        const db = adminDb('ACTIVE', 2);
        await removeTenantMember(owner(), { membershipId: 'm-1' });
        expect(db.tenantMembership.delete).toHaveBeenCalledTimes(1);
    });

    it('a DEACTIVATED admin is not counted, so removing one is allowed', async () => {
        const db = adminDb('DEACTIVATED', 1);
        await removeTenantMember(owner(), { membershipId: 'm-1' });
        expect(db.tenantMembership.count).not.toHaveBeenCalled();
        expect(db.tenantMembership.delete).toHaveBeenCalledTimes(1);
    });
});

describe('the same check, asked by all three', () => {
    it.each([
        ['the role change', () => updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'EDITOR' })],
        ['the deactivation', () => deactivateTenantMember(owner(), { membershipId: 'm-1' })],
        ['the removal', () => removeTenantMember(owner(), { membershipId: 'm-1' })],
    ])('%s reads the ACTIVE ADMIN count and refuses at one', async (_label, run) => {
        const db = adminDb('ACTIVE', 1);
        await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
        expect(db.tenantMembership.count).toHaveBeenCalledWith(ACTIVE_ADMIN_COUNT);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(db.tenantMembership.delete).not.toHaveBeenCalled();
    });
});
