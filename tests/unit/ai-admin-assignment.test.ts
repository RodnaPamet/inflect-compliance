/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * Assigning the AI_ADMIN role (#3699 deploy 2) — the two rules the owner set on
 * its two writers, the members-page role change and an Entra group mapping:
 *
 *   1. OWNER-only, in BOTH directions. Moving a member into or out of AI_ADMIN
 *      needs `admin.owner_management`, as promoting to OWNER does; so does
 *      creating, changing or deleting a group mapping that yields it. An ADMIN
 *      can do neither.
 *   2. No custom role on an AI_ADMIN membership. A custom role is not assigned
 *      to one, and a member carrying a custom role is not promoted into it —
 *      refused with a named reason, never repaired on the caller's behalf.
 *
 * The census of who may write the role at all is
 * `tests/unit/ai-admin-role-writers.test.ts`; the real-DB proof is
 * `tests/integration/ai-admin-assignment.test.ts`.
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
import { BUILT_IN_SCOPE_REFUSAL } from '@/lib/roles';
import { ConflictError, ForbiddenError } from '@/lib/errors/types';
import { updateTenantMemberRole } from '@/app-layer/usecases/tenant-admin';
import { assignCustomRole } from '@/app-layer/usecases/custom-roles';
import {
    createEntraGroupMapping,
    deleteEntraGroupMapping,
    updateEntraGroupMapping,
} from '@/app-layer/usecases/entra-group-mappings';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });
const admin = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });
const OWNER_ONLY = /Only an OWNER can assign or remove the AI_ADMIN role/;

/** A transaction client holding one ACTIVE membership, recording writes. */
function membershipDb(membership: { role: string; customRoleId?: string | null }) {
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
            count: jest.fn().mockResolvedValue(2),
            update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
                ...row,
                ...args.data,
                customRole: null,
            })),
        },
        tenantCustomRole: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'cr-1',
                tenantId: 'tenant-1',
                baseRole: 'READER',
                permissionsJson: {},
                isActive: true,
            }),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async () => {
        throw new Error('the database was reached');
    });
});

describe('the members-page role change — OWNER-only, in both directions', () => {
    it('an ADMIN cannot move a member INTO AI_ADMIN — refused before the membership is read', async () => {
        await expect(updateTenantMemberRole(admin(), { membershipId: 'm-1', role: 'AI_ADMIN' })).rejects.toThrow(
            OWNER_ONLY,
        );
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('an ADMIN cannot move a member OUT of AI_ADMIN', async () => {
        const db = membershipDb({ role: 'AI_ADMIN' });
        const err = await updateTenantMemberRole(admin(), { membershipId: 'm-1', role: 'READER' }).catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err.message).toBe('Only an OWNER can assign or remove the AI_ADMIN role.');
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an OWNER moves a member out of AI_ADMIN', async () => {
        const db = membershipDb({ role: 'AI_ADMIN' });
        await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'EDITOR' });
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'm-1' }, data: { role: 'EDITOR' } }),
        );
    });

    it('a custom role carrying owner_management on an ADMIN base is what the gate reads, not the built-in role', async () => {
        const db = membershipDb({ role: 'READER' });
        const ctx = admin();
        ctx.appPermissions = { ...ctx.appPermissions, admin: { ...ctx.appPermissions.admin, owner_management: true } };
        await updateTenantMemberRole(ctx, { membershipId: 'm-1', role: 'AI_ADMIN' });
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: 'AI_ADMIN' } }),
        );
    });

    it('an ADMIN’s ordinary role changes are unaffected', async () => {
        const db = membershipDb({ role: 'READER' });
        await updateTenantMemberRole(admin(), { membershipId: 'm-1', role: 'EDITOR' });
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: 'EDITOR' } }),
        );
    });
});

describe('no custom role on an AI_ADMIN membership — refused, never repaired', () => {
    it('promoting a member who carries a custom role is refused with the named reason', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: 'cr-1' });
        const err = await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'AI_ADMIN' }).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(err.message).toMatch(/Remove this member's custom role first/);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('assigning a custom role to an AI_ADMIN membership is refused with the same reason', async () => {
        const db = membershipDb({ role: 'AI_ADMIN' });
        const err = await assignCustomRole(owner(), 'm-1', 'cr-1').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('removing a custom role is always allowed — it is how a member becomes promotable', async () => {
        const db = membershipDb({ role: 'AI_ADMIN' });
        await assignCustomRole(owner(), 'm-1', null);
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { customRoleId: null } }),
        );
    });

    it('other roles still take custom roles', async () => {
        const db = membershipDb({ role: 'EDITOR' });
        await assignCustomRole(owner(), 'm-1', 'cr-1');
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { customRoleId: 'cr-1' } }),
        );
    });
});

describe('PATCH /api/t/:slug/admin/members/:membershipId, end to end', () => {
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

    it('refuses AI_ADMIN together with a custom role in one body, before either write', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'AI_ADMIN', customRoleId: 'cr-1' }), args);
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain(BUILT_IN_SCOPE_REFUSAL);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('an ADMIN asking for AI_ADMIN gets a 403', async () => {
        getTenantCtxMock.mockResolvedValue(admin());
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'AI_ADMIN' }), args);
        expect(res.status).toBe(403);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('an OWNER asking for AI_ADMIN gets it', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const db = membershipDb({ role: 'READER' });
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'AI_ADMIN' }), args);
        expect(res.status).toBe(200);
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: 'AI_ADMIN' } }),
        );
    });
});

describe('Entra group mappings that yield AI_ADMIN — OWNER-only', () => {
    const GUID = '11111111-1111-4111-8111-111111111111';

    function mappingDb(existingRole: string) {
        const db = {
            tenantEntraGroupMapping: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'map-1',
                    tenantId: 'tenant-1',
                    aadGroupId: GUID,
                    aadGroupName: null,
                    role: existingRole,
                    priority: 0,
                }),
                create: jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'map-1', ...a.data })),
                update: jest.fn(async (a: { data: Record<string, unknown> }) => ({
                    id: 'map-1',
                    aadGroupId: GUID,
                    role: existingRole,
                    priority: 0,
                    aadGroupName: null,
                    ...a.data,
                })),
                delete: jest.fn().mockResolvedValue({}),
            },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        return db.tenantEntraGroupMapping;
    }

    it('an ADMIN cannot create one; an OWNER can', async () => {
        const table = mappingDb('READER');
        await expect(createEntraGroupMapping(admin(), { aadGroupId: GUID, role: 'AI_ADMIN' })).rejects.toThrow(
            OWNER_ONLY,
        );
        expect(table.create).not.toHaveBeenCalled();
        await createEntraGroupMapping(owner(), { aadGroupId: GUID, role: 'AI_ADMIN' });
        expect(table.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'AI_ADMIN' }) }));
    });

    it.each([
        ['retarget another mapping to it', 'READER', { role: 'AI_ADMIN' }],
        ['retarget it to another role', 'AI_ADMIN', { role: 'EDITOR' }],
        ['re-prioritise it', 'AI_ADMIN', { priority: 9 }],
    ] as const)('an ADMIN cannot %s', async (_label, existingRole, patchBody) => {
        const table = mappingDb(existingRole);
        await expect(updateEntraGroupMapping(admin(), 'map-1', patchBody)).rejects.toThrow(OWNER_ONLY);
        expect(table.update).not.toHaveBeenCalled();
    });

    it('an OWNER can change one, and an ADMIN can still change every other mapping', async () => {
        const table = mappingDb('AI_ADMIN');
        await updateEntraGroupMapping(owner(), 'map-1', { priority: 9 });
        expect(table.update).toHaveBeenCalledTimes(1);
        const other = mappingDb('READER');
        await updateEntraGroupMapping(admin(), 'map-1', { role: 'EDITOR' });
        expect(other.update).toHaveBeenCalledTimes(1);
    });

    it('an ADMIN cannot delete one; an OWNER can', async () => {
        const table = mappingDb('AI_ADMIN');
        await expect(deleteEntraGroupMapping(admin(), 'map-1')).rejects.toThrow(OWNER_ONLY);
        expect(table.delete).not.toHaveBeenCalled();
        await deleteEntraGroupMapping(owner(), 'map-1');
        expect(table.delete).toHaveBeenCalledTimes(1);
    });
});
