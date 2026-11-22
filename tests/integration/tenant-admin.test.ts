/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Tenant Admin Usecase Integration Tests
 *
 * Tests the admin usecases with mocked Prisma to verify:
 * 1. Only ADMIN can perform admin actions
 * 2. Self-demotion is blocked
 * 3. Last-admin protection works
 * 4. Deactivated members cannot resolve context
 */
import { RequestContext } from '@/app-layer/types';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

// Mock appendAuditEntry to avoid Prisma dependency
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(async () => ({
        id: 'audit-1',
        entryHash: 'hash-abc',
        previousHash: null,
    })),
}));

// Mock db-context to provide a mock PrismaTx
const mockTx: Record<string, any> = {};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => {
        return fn(mockTx);
    }),
}));

import {
    listTenantMembers,
    inviteTenantMember,
    updateTenantMemberRole,
    deactivateTenantMember,
    getTenantAdminSettings,
} from '@/app-layer/usecases/tenant-admin';

// ─── Helpers ───

function makeCtx(role: Role, userId = 'user-1'): RequestContext {
    return {
        requestId: 'req-test',
        userId,
        tenantId: 'tenant-1',
        tenantSlug: 'acme-co',
        role,
        permissions: computePermissions(role),
        appPermissions: getPermissionsForRole(role),
    };
}

// ─── Reset mocks ───

beforeEach(() => {
    jest.clearAllMocks();
    // Reset mockTx
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
    // The tenant's owner lock every member change takes first (#5388).
    mockTx.$executeRawUnsafe = jest.fn(async () => 0);
});

// ─── Authorization Tests ───

describe('Tenant Admin — Authorization', () => {
    const NON_ADMIN_ROLES: Role[] = ['EDITOR', 'READER', 'AUDITOR'];

    NON_ADMIN_ROLES.forEach((role) => {
        it(`${role} cannot list members`, async () => {
            await expect(listTenantMembers(makeCtx(role))).rejects.toThrow(/permission/i);
        });

        it(`${role} cannot invite members`, async () => {
            await expect(
                inviteTenantMember(makeCtx(role), { email: 'test@test.com', role: 'READER' })
            ).rejects.toThrow(/permission/i);
        });

        it(`${role} cannot update member roles`, async () => {
            await expect(
                updateTenantMemberRole(makeCtx(role), { membershipId: 'm-1', role: 'EDITOR' })
            ).rejects.toThrow(/permission/i);
        });

        it(`${role} cannot deactivate members`, async () => {
            await expect(
                deactivateTenantMember(makeCtx(role), { membershipId: 'm-1' })
            ).rejects.toThrow(/permission/i);
        });

        it(`${role} cannot view admin settings`, async () => {
            await expect(getTenantAdminSettings(makeCtx(role))).rejects.toThrow(/permission/i);
        });
    });
});

// ─── ADMIN Success Tests ───

describe('Tenant Admin — ADMIN operations', () => {
    it('ADMIN can list members', async () => {
        mockTx.tenantMembership = {
            findMany: jest.fn(async () => [
                { id: 'm-1', userId: 'u-1', role: 'ADMIN', status: 'ACTIVE', user: { id: 'u-1', name: 'Admin', email: 'a@t.com' } },
            ]),
        };

        const result = await listTenantMembers(makeCtx('ADMIN'));
        expect(result).toHaveLength(1);
        expect(mockTx.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-1' }),
            })
        );
    });

    it('ADMIN can update another member role', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-2',
                userId: 'user-2',
                role: 'READER',
                status: 'ACTIVE',
                user: { id: 'user-2', name: 'Test', email: 'test@t.com' },
            })),
            count: jest.fn(async () => 2),
            update: jest.fn(async () => ({
                id: 'm-2',
                userId: 'user-2',
                role: 'EDITOR',
                user: { id: 'user-2', name: 'Test', email: 'test@t.com' },
            })),
        };

        const result = await updateTenantMemberRole(makeCtx('ADMIN'), {
            membershipId: 'm-2',
            role: 'EDITOR',
        });
        expect(result.role).toBe('EDITOR');
    });
});

// ─── Safety Invariant Tests ───

describe('Tenant Admin — Safety Invariants', () => {
    it('ADMIN cannot demote themselves', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-1',
                userId: 'user-1',
                role: 'ADMIN',
                status: 'ACTIVE',
                user: { id: 'user-1', name: 'Admin', email: 'admin@t.com' },
            })),
        };

        await expect(
            updateTenantMemberRole(makeCtx('ADMIN', 'user-1'), {
                membershipId: 'm-1',
                role: 'EDITOR',
            })
        ).rejects.toThrow(/demote yourself/i);
    });

    it('ADMIN cannot deactivate themselves', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-1',
                userId: 'user-1',
                role: 'ADMIN',
                status: 'ACTIVE',
                user: { id: 'user-1', name: 'Admin', email: 'admin@t.com' },
            })),
        };

        await expect(
            deactivateTenantMember(makeCtx('ADMIN', 'user-1'), {
                membershipId: 'm-1',
            })
        ).rejects.toThrow(/deactivate your own/i);
    });

    it('cannot demote last admin', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-last',
                userId: 'last-admin',
                role: 'ADMIN',
                status: 'ACTIVE',
                user: { id: 'last-admin', name: 'Last Admin', email: 'last@t.com' },
            })),
            count: jest.fn(async () => 1), // only 1 admin
        };

        await expect(
            updateTenantMemberRole(makeCtx('ADMIN', 'other-admin'), {
                membershipId: 'm-last',
                role: 'EDITOR',
            })
        ).rejects.toThrow(/last admin/i);
    });

    it('cannot deactivate last admin', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-last',
                userId: 'last-admin',
                role: 'ADMIN',
                status: 'ACTIVE',
                user: { id: 'last-admin', name: 'Last Admin', email: 'last@t.com' },
            })),
            count: jest.fn(async () => 1),
        };

        await expect(
            deactivateTenantMember(makeCtx('ADMIN', 'other-admin'), {
                membershipId: 'm-last',
            })
        ).rejects.toThrow(/last admin/i);
    });
});
