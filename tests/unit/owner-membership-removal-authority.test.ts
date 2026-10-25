/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * Only an OWNER deactivates or removes an OWNER or an AI_ADMIN membership.
 *
 * The members page lets an ADMIN deactivate and remove members, and both
 * usecases guarded only the LAST active OWNER. So whenever a tenant had two
 * OWNERs, an ADMIN — who cannot even change an OWNER's role — could switch
 * one off or delete their membership. `admin.owner_management` is the key the
 * role change already asks for an OWNER target; deactivate and remove now ask
 * it too, before any write. The last-OWNER guard is unchanged and still
 * applies to an OWNER doing it.
 *
 * AI_ADMIN joined the rule in #4118 (owner decision): an ADMIN can neither
 * assign nor remove the role, and could still deactivate or remove the
 * membership holding it. Both refusals carry the same named reason,
 * `ENDING_OWNER_MANAGED_MEMBERSHIP_IS_OWNER_TIER`.
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
import { OWNER_MANAGED_MEMBERSHIP_END_REFUSAL } from '@/lib/roles';
import { deactivateTenantMember, removeTenantMember } from '@/app-layer/usecases/tenant-admin';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });
const admin = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });

/** A transaction client holding one membership in a tenant with `owners` ACTIVE OWNERs. */
function membershipDb(membership: { role: string; status?: string }, owners = 2) {
    const row = {
        id: 'm-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        status: 'ACTIVE',
        customRoleId: null,
        user: { id: 'u-1', name: 'U', email: 'u@example.com' },
        ...membership,
    };
    const db = {
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(row),
            count: jest.fn().mockResolvedValue(owners),
            update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ ...row, ...args.data })),
            delete: jest.fn().mockResolvedValue(row),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

beforeEach(() => jest.clearAllMocks());

describe('deactivating an OWNER', () => {
    it('is refused to an ADMIN even when another OWNER remains, and nothing is written', async () => {
        const db = membershipDb({ role: 'OWNER' }, 2);
        await expect(deactivateTenantMember(admin(), { membershipId: 'm-1' })).rejects.toThrow(ForbiddenError);
        await expect(deactivateTenantMember(admin(), { membershipId: 'm-1' })).rejects.toThrow(
            /Only OWNERs can deactivate an OWNER membership/,
        );
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('is allowed to an OWNER when another OWNER remains', async () => {
        const db = membershipDb({ role: 'OWNER' }, 2);
        await deactivateTenantMember(owner(), { membershipId: 'm-1' });
        expect(db.tenantMembership.update).toHaveBeenCalledTimes(1);
    });

    it('still refuses the last OWNER, to an OWNER too', async () => {
        const db = membershipDb({ role: 'OWNER' }, 1);
        await expect(deactivateTenantMember(owner(), { membershipId: 'm-1' })).rejects.toThrow(
            /Cannot deactivate the last OWNER/,
        );
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });
});

describe('removing an OWNER', () => {
    it.each(['ACTIVE', 'DEACTIVATED'])('is refused to an ADMIN for a %s OWNER, and nothing is deleted', async (status) => {
        const db = membershipDb({ role: 'OWNER', status }, 2);
        await expect(removeTenantMember(admin(), { membershipId: 'm-1' })).rejects.toThrow(
            /Only OWNERs can remove an OWNER membership/,
        );
        expect(db.tenantMembership.delete).not.toHaveBeenCalled();
    });

    it('is allowed to an OWNER when another OWNER remains', async () => {
        const db = membershipDb({ role: 'OWNER' }, 2);
        await removeTenantMember(owner(), { membershipId: 'm-1' });
        expect(db.tenantMembership.delete).toHaveBeenCalledTimes(1);
    });
});

describe('ending an AI_ADMIN membership (#4118)', () => {
    it('deactivating one is refused to an ADMIN with the named reason, and nothing is written', async () => {
        const db = membershipDb({ role: 'AI_ADMIN' }, 2);
        const err = await deactivateTenantMember(admin(), { membershipId: 'm-1' }).catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err.message).toBe('Only an OWNER can deactivate an AI_ADMIN membership.');
        expect(err.details).toEqual({ reason: OWNER_MANAGED_MEMBERSHIP_END_REFUSAL });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it.each(['ACTIVE', 'DEACTIVATED'])('removing a %s one is refused to an ADMIN, and nothing is deleted', async (status) => {
        const db = membershipDb({ role: 'AI_ADMIN', status }, 2);
        const err = await removeTenantMember(admin(), { membershipId: 'm-1' }).catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err.message).toBe('Only an OWNER can remove an AI_ADMIN membership.');
        expect(err.details).toEqual({ reason: OWNER_MANAGED_MEMBERSHIP_END_REFUSAL });
        expect(db.tenantMembership.delete).not.toHaveBeenCalled();
    });

    it('an OWNER deactivates and removes one', async () => {
        const db = membershipDb({ role: 'AI_ADMIN' }, 2);
        await deactivateTenantMember(owner(), { membershipId: 'm-1' });
        expect(db.tenantMembership.update).toHaveBeenCalledTimes(1);
        await removeTenantMember(owner(), { membershipId: 'm-1' });
        expect(db.tenantMembership.delete).toHaveBeenCalledTimes(1);
    });

    it('the OWNER refusals carry the same reason', async () => {
        membershipDb({ role: 'OWNER' }, 2);
        for (const run of [deactivateTenantMember, removeTenantMember]) {
            const err = await run(admin(), { membershipId: 'm-1' }).catch((e) => e);
            expect(err.details).toEqual({ reason: OWNER_MANAGED_MEMBERSHIP_END_REFUSAL });
        }
    });
});

describe('members below OWNER are unchanged', () => {
    it.each(['EDITOR', 'READER', 'AUDITOR'])('an ADMIN still deactivates and removes a %s', async (role) => {
        const db = membershipDb({ role }, 2);
        await deactivateTenantMember(admin(), { membershipId: 'm-1' });
        expect(db.tenantMembership.update).toHaveBeenCalledTimes(1);
        await removeTenantMember(admin(), { membershipId: 'm-1' });
        expect(db.tenantMembership.delete).toHaveBeenCalledTimes(1);
    });
});
