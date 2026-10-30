/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Custom Role CRUD Usecase Tests
 *
 * Verifies:
 * 1. Admin can create a valid custom role
 * 2. Invalid permissions JSON is rejected
 * 3. Admin can update a custom role
 * 4. Admin can delete (soft-delete) a custom role
 * 5. Admin can assign/unassign a custom role
 * 6. Non-admin cannot access role management
 * 7. Duplicate role names rejected
 * 8. Deleting clears customRoleId on members
 */
import { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole, PERMISSION_SCHEMA } from '@/lib/permissions';
import type { Role } from '@prisma/client';
import { ADMIN_BASE_ONLY_PERMISSIONS } from '@/lib/custom-role-admin-base-rule';

// ─── Mock db-context ───
const mockTx: Record<string, any> = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => {
        return fn(mockTx);
    }),
}));

// ─── Mock audit ───
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

import {
    listCustomRoles,
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    assignCustomRole,
} from '@/app-layer/usecases/custom-roles';

// ─── Helpers ───

function makeCtx(role: Role = 'ADMIN', userId = 'user-1'): RequestContext {
    return {
        requestId: 'req-test',
        userId,
        tenantId: 'tenant-1',
        tenantSlug: 'acme-co',
        role,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: role === 'ADMIN',
            canAudit: role === 'ADMIN' || role === 'AUDITOR',
            canExport: role !== 'READER',
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const VALID_PERMISSIONS = getPermissionsForRole('EDITOR');

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
    // The carriage check's reads (2026-10-30): no member carries the role
    // being saved, and the custom role being assigned is read for its base and
    // blob. Tests that drive that rule are tests/unit/custom-role-carriage-writers.test.ts.
    mockTx.tenantMembership = { groupBy: jest.fn(async () => []) };
});

// ─── Authorization Tests ───

describe('Custom Roles — Authorization', () => {
    const NON_ADMIN_ROLES: Role[] = ['EDITOR', 'READER', 'AUDITOR'];

    NON_ADMIN_ROLES.forEach((role) => {
        it(`${role} cannot list custom roles`, async () => {
            await expect(listCustomRoles(makeCtx(role))).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot create custom roles`, async () => {
            await expect(
                createCustomRole(makeCtx(role), {
                    name: 'Test Role',
                    baseRole: 'READER',
                    permissionsJson: VALID_PERMISSIONS,
                })
            ).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot update custom roles`, async () => {
            await expect(
                updateCustomRole(makeCtx(role), 'role-1', { name: 'New Name' })
            ).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot delete custom roles`, async () => {
            await expect(deleteCustomRole(makeCtx(role), 'role-1')).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot assign custom roles`, async () => {
            await expect(assignCustomRole(makeCtx(role), 'm-1', 'role-1')).rejects.toThrow(/permission|admin/i);
        });
    });
});

// ─── Create Tests ───

describe('Custom Roles — Create', () => {
    it('creates a valid custom role', async () => {
        const created = {
            id: 'cr-1',
            tenantId: 'tenant-1',
            name: 'Compliance Lead',
            description: 'Lead for compliance team',
            baseRole: 'EDITOR',
            permissionsJson: VALID_PERMISSIONS,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null), // no duplicate
            create: jest.fn(async () => created),
        };

        const result = await createCustomRole(makeCtx(), {
            name: 'Compliance Lead',
            description: 'Lead for compliance team',
            baseRole: 'EDITOR',
            permissionsJson: VALID_PERMISSIONS,
        });

        expect(result.name).toBe('Compliance Lead');
        expect(mockTx.tenantCustomRole.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    tenantId: 'tenant-1',
                    name: 'Compliance Lead',
                    baseRole: 'EDITOR',
                }),
            })
        );
    });

    it('rejects invalid permissions JSON', async () => {
        await expect(
            createCustomRole(makeCtx(), {
                name: 'Bad Role',
                baseRole: 'READER',
                permissionsJson: { controls: 'not-an-object' },
            })
        ).rejects.toThrow(/Invalid permissions/);
    });

    it('rejects empty name', async () => {
        await expect(
            createCustomRole(makeCtx(), {
                name: '   ',
                baseRole: 'READER',
                permissionsJson: VALID_PERMISSIONS,
            })
        ).rejects.toThrow(/name/i);
    });

    it('rejects duplicate name within tenant', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({ id: 'existing' })), // duplicate exists
        };

        await expect(
            createCustomRole(makeCtx(), {
                name: 'Duplicate Role',
                baseRole: 'READER',
                permissionsJson: VALID_PERMISSIONS,
            })
        ).rejects.toThrow(/already exists/);
    });

    // #4467 — a deleted (isActive false) role frees its name. The check asks
    // the partial unique index's own question: live roles only.
    it('the duplicate-name check on create looks at LIVE roles only', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async ({ data }: any) => ({ id: 'cr-new', ...data })),
        };

        await createCustomRole(makeCtx(), {
            name: 'Compliance Lead',
            baseRole: 'READER',
            permissionsJson: VALID_PERMISSIONS,
        });

        expect(mockTx.tenantCustomRole.findFirst).toHaveBeenCalledTimes(1);
        expect(mockTx.tenantCustomRole.findFirst.mock.calls[0][0].where).toEqual({
            tenantId: 'tenant-1',
            name: 'Compliance Lead',
            isActive: true,
        });
    });

    it('rejects missing permission domains', async () => {
        await expect(
            createCustomRole(makeCtx(), {
                name: 'Incomplete',
                baseRole: 'READER',
                permissionsJson: { controls: { view: true, create: false, edit: false } },
            })
        ).rejects.toThrow(/Invalid permissions/);
    });
});

// ─── Update Tests ───

describe('Custom Roles — Update', () => {
    const existingRole = {
        id: 'cr-1',
        tenantId: 'tenant-1',
        name: 'Old Name',
        baseRole: 'READER',
        isActive: true,
    };

    it('updates a custom role name', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn()
                .mockResolvedValueOnce(existingRole) // find existing
                .mockResolvedValueOnce(null), // no duplicate
            update: jest.fn(async () => ({ ...existingRole, name: 'New Name' })),
        };

        const result = await updateCustomRole(makeCtx(), 'cr-1', { name: 'New Name' });
        expect(result.name).toBe('New Name');
    });

    it('the duplicate-name check on rename looks at LIVE roles only, other than this one (#4467)', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn()
                .mockResolvedValueOnce(existingRole)
                .mockResolvedValueOnce(null),
            update: jest.fn(async () => ({ ...existingRole, name: 'New Name' })),
        };

        await updateCustomRole(makeCtx(), 'cr-1', { name: 'New Name' });

        expect(mockTx.tenantCustomRole.findFirst.mock.calls[1][0].where).toEqual({
            tenantId: 'tenant-1',
            name: 'New Name',
            isActive: true,
            id: { not: 'cr-1' },
        });
    });

    it('updates permissions with validation', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => existingRole),
            update: jest.fn(async () => ({ ...existingRole, permissionsJson: VALID_PERMISSIONS })),
        };

        const result = await updateCustomRole(makeCtx(), 'cr-1', {
            permissionsJson: VALID_PERMISSIONS,
        });
        expect(result.permissionsJson).toEqual(VALID_PERMISSIONS);
    });

    it('rejects invalid permissions on update', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => existingRole),
        };

        await expect(
            updateCustomRole(makeCtx(), 'cr-1', {
                permissionsJson: { controls: 'invalid' },
            })
        ).rejects.toThrow(/Invalid permissions/);
    });

    it('rejects update with no fields', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => existingRole),
        };

        await expect(
            updateCustomRole(makeCtx(), 'cr-1', {})
        ).rejects.toThrow(/No fields/);
    });

    it('returns not found for missing role', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
        };

        await expect(
            updateCustomRole(makeCtx(), 'missing', { name: 'X' })
        ).rejects.toThrow(/not found/i);
    });
});

// ─── Delete Tests ───

describe('Custom Roles — Delete', () => {
    it('soft-deletes a role and clears member assignments', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({
                id: 'cr-1',
                tenantId: 'tenant-1',
                name: 'To Delete',
                isActive: true,
            })),
            update: jest.fn(async () => ({ id: 'cr-1', isActive: false })),
        };
        mockTx.tenantMembership = {
            updateMany: jest.fn(async () => ({ count: 3 })),
        };

        const result = await deleteCustomRole(makeCtx(), 'cr-1');
        expect(result.deleted.isActive).toBe(false);
        expect(result.membersCleared).toBe(3);
        expect(mockTx.tenantMembership.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ customRoleId: 'cr-1' }),
                data: { customRoleId: null },
            })
        );
    });

    it('returns not found for missing role', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
        };

        await expect(deleteCustomRole(makeCtx(), 'missing')).rejects.toThrow(/not found/i);
    });
});

// ─── Assign Tests ───

describe('Custom Roles — Assign', () => {
    const activeMembership = {
        id: 'm-1',
        tenantId: 'tenant-1',
        userId: 'user-2',
        role: 'READER',
        customRoleId: null,
        status: 'ACTIVE',
        user: { id: 'user-2', name: 'Test', email: 'test@t.com' },
    };

    it('assigns a custom role to a member', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => activeMembership),
            update: jest.fn(async () => ({
                ...activeMembership,
                customRoleId: 'cr-1',
                customRole: { id: 'cr-1', name: 'Compliance Lead' },
            })),
        };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({ id: 'cr-1', tenantId: 'tenant-1', isActive: true })),
            findMany: jest.fn(async () => []),
        };

        const result = await assignCustomRole(makeCtx(), 'm-1', 'cr-1');
        expect(result.customRoleId).toBe('cr-1');
        expect(mockTx.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { customRoleId: 'cr-1' },
            })
        );
    });

    it('unassigns a custom role (null)', async () => {
        const memberWithRole = { ...activeMembership, customRoleId: 'cr-1' };
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => memberWithRole),
            update: jest.fn(async () => ({
                ...memberWithRole,
                customRoleId: null,
                customRole: null,
            })),
        };

        const result = await assignCustomRole(makeCtx(), 'm-1', null);
        expect(result.customRoleId).toBeNull();
    });

    it('rejects assigning an inactive custom role', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => activeMembership),
        };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null), // not found or inactive
        };

        await expect(
            assignCustomRole(makeCtx(), 'm-1', 'cr-inactive')
        ).rejects.toThrow(/not found|inactive/i);
    });

    it('rejects assigning to a non-existent member', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => null),
        };

        await expect(
            assignCustomRole(makeCtx(), 'missing', 'cr-1')
        ).rejects.toThrow(/not found/i);
    });
});

// ─── Privilege escalation ────────────────────────────────────────────

/**
 * "You cannot grant what you do not hold."
 *
 * Custom roles are the one path where a permission set is authored by
 * hand rather than derived from the Role enum, so it is the one path that
 * can hand out MORE authority than its author has.
 *
 * Every entrypoint is gated on `assertCanAdmin`, which an ADMIN satisfies.
 * But ADMIN deliberately lacks `admin.tenant_lifecycle` and
 * `admin.owner_management` — the OWNER-only flags gating tenant deletion,
 * tenant-DEK rotation and OWNER management. Before this guard an ADMIN
 * could author (or simply assign) a role holding those and escalate to
 * OWNER on the next request, bypassing a distinction the enum path
 * enforces at compile time.
 */
describe('Custom Roles — privilege escalation', () => {
    /** OWNER context: the base helper only sets canAdmin for 'ADMIN'. */
    function ownerCtx(): RequestContext {
        const base = makeCtx('ADMIN');
        return {
            ...base,
            role: 'OWNER' as Role,
            appPermissions: getPermissionsForRole('OWNER'),
        };
    }

    /** A permission set holding the two OWNER-only admin flags. */
    const OWNER_ONLY_PERMISSIONS = getPermissionsForRole('OWNER');

    it('ADMIN cannot CREATE a role granting OWNER-only permissions', async () => {
        mockTx.tenantCustomRole = { findFirst: jest.fn(async () => null), create: jest.fn() };

        await expect(
            createCustomRole(makeCtx('ADMIN'), {
                name: 'Sneaky Owner',
                baseRole: 'ADMIN',
                permissionsJson: OWNER_ONLY_PERMISSIONS,
            }),
        ).rejects.toThrow(/cannot grant permissions you do not hold/i);

        // The role must never reach the database.
        expect(mockTx.tenantCustomRole.create).not.toHaveBeenCalled();
    });

    it('names the offending permissions so the admin can correct the input', async () => {
        mockTx.tenantCustomRole = { findFirst: jest.fn(async () => null), create: jest.fn() };

        await expect(
            createCustomRole(makeCtx('ADMIN'), {
                name: 'Sneaky Owner',
                baseRole: 'ADMIN',
                permissionsJson: OWNER_ONLY_PERMISSIONS,
            }),
        ).rejects.toThrow(/admin\.tenant_lifecycle|admin\.owner_management/);
    });

    it('carries a reason and the keys in details, so the page can name them by label (#4467)', async () => {
        mockTx.tenantCustomRole = { findFirst: jest.fn(async () => null), create: jest.fn() };

        const err: any = await createCustomRole(makeCtx('ADMIN'), {
            name: 'Sneaky Owner',
            baseRole: 'ADMIN',
            permissionsJson: OWNER_ONLY_PERMISSIONS,
        }).catch((e) => e);

        expect(err.status).toBe(403);
        expect(err.details).toEqual({
            reason: 'CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER',
            exceeded: ['admin.tenant_lifecycle', 'admin.owner_management', 'admin.agent_ownership'],
        });
    });

    it('ADMIN cannot UPDATE an existing role to add OWNER-only permissions', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({
                id: 'cr-1',
                tenantId: 'tenant-1',
                name: 'Compliance Lead',
                baseRole: 'ADMIN',
                permissionsJson: getPermissionsForRole('ADMIN'),
                isActive: true,
            })),
            update: jest.fn(),
        };

        await expect(
            updateCustomRole(makeCtx('ADMIN'), 'cr-1', {
                permissionsJson: OWNER_ONLY_PERMISSIONS,
            }),
        ).rejects.toThrow(/cannot grant permissions you do not hold/i);
        expect(mockTx.tenantCustomRole.update).not.toHaveBeenCalled();
    });

    it('ADMIN cannot ASSIGN an existing over-privileged role — the loophole', async () => {
        // The role already exists (seeded, or authored by an OWNER), so
        // blocking authorship alone would not close the escalation: the
        // ADMIN just hands it to themselves.
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                role: 'ADMIN',
                customRoleId: null,
                status: 'ACTIVE',
                user: { id: 'user-1', name: 'Self', email: 'admin@t.com' },
            })),
            update: jest.fn(),
        };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({
                id: 'cr-owner',
                tenantId: 'tenant-1',
                isActive: true,
                baseRole: 'ADMIN',
                permissionsJson: OWNER_ONLY_PERMISSIONS,
            })),
        };

        await expect(
            assignCustomRole(makeCtx('ADMIN'), 'm-1', 'cr-owner'),
        ).rejects.toThrow(/cannot grant permissions you do not hold/i);
        expect(mockTx.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('OWNER CAN create a role granting OWNER-only permissions (they hold them)', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => ({ id: 'cr-2', name: 'Deputy Owner' })),
        };

        await expect(
            createCustomRole(ownerCtx(), {
                name: 'Deputy Owner',
                baseRole: 'ADMIN',
                permissionsJson: OWNER_ONLY_PERMISSIONS,
            }),
        ).resolves.toBeDefined();
        expect(mockTx.tenantCustomRole.create).toHaveBeenCalled();
    });

    it('granting LESS than you hold is still allowed (no false positives)', async () => {
        // Revoking is not escalation — the guard must not block an ADMIN
        // from authoring an ordinary, narrower role.
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => ({ id: 'cr-3', name: 'Read Only Plus' })),
        };

        await expect(
            createCustomRole(makeCtx('ADMIN'), {
                name: 'Read Only Plus',
                baseRole: 'READER',
                permissionsJson: getPermissionsForRole('READER'),
            }),
        ).resolves.toBeDefined();
    });

    it('unassigning (null) is always allowed — it grants nothing', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => ({
                id: 'm-1',
                tenantId: 'tenant-1',
                userId: 'user-2',
                role: 'READER',
                customRoleId: 'cr-owner',
                status: 'ACTIVE',
                user: { id: 'user-2', name: 'T', email: 't@t.com' },
            })),
            update: jest.fn(async () => ({
                id: 'm-1',
                customRoleId: null,
                role: 'READER',
                user: { id: 'user-2', name: 'T', email: 't@t.com' },
                customRole: null,
            })),
        };

        await expect(
            assignCustomRole(makeCtx('ADMIN'), 'm-1', null),
        ).resolves.toBeDefined();
    });
});


// ─── List normalisation (#2225) ───

describe('listCustomRoles — permissionsJson normalisation', () => {
    /**
     * `permissionsJson` is a `Json` column. A row written before a
     * domain existed simply has no key for it, and `PermissionSet`
     * grows over time — `assets`, `personnel`, `incidents` and
     * `reports.schedule_external` all arrived after the model shipped.
     *
     * The list endpoint used to return the column RAW. The admin roles
     * page counts granted flags per row and seeds its editor from that
     * same object, both via `permissions[domain][action]` — so a row
     * missing a domain is `undefined[action]`, a TypeError, not a blank
     * cell. Normalising through `parsePermissionsJson` (which the
     * runtime authorization path already applies to the same row)
     * makes the response complete.
     */
    function seedRoleRow(permissionsJson: unknown, baseRole: Role = 'READER') {
        mockTx.tenantCustomRole = {
            findMany: jest.fn(async () => [
                {
                    id: 'cr-1',
                    tenantId: 'tenant-1',
                    name: 'Legacy Role',
                    description: null,
                    baseRole,
                    permissionsJson,
                    isActive: true,
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                    _count: { memberships: 2 },
                },
            ]),
        };
    }

    /** A stored blob predating three of today's domains. */
    function legacyBlob(): Record<string, unknown> {
        const full = getPermissionsForRole('EDITOR') as unknown as Record<string, unknown>;
        const partial: Record<string, unknown> = { ...full };
        delete partial.assets;
        delete partial.personnel;
        delete partial.incidents;
        return partial;
    }

    it('counts the members carrying each role whose built-in role is not ADMIN (2026-10-30)', async () => {
        seedRoleRow(getPermissionsForRole('READER'));
        mockTx.tenantMembership = {
            groupBy: jest.fn(async () => [
                { customRoleId: 'cr-1', role: 'EDITOR', _count: { _all: 2 } },
                { customRoleId: 'cr-1', role: 'AUDITOR', _count: { _all: 1 } },
                { customRoleId: 'cr-1', role: 'ADMIN', _count: { _all: 5 } },
                { customRoleId: 'cr-other', role: 'READER', _count: { _all: 9 } },
            ]),
        };

        const roles = await listCustomRoles(makeCtx('ADMIN'));

        expect(roles[0].nonAdminCarriers).toBe(3);
        expect(mockTx.tenantMembership.groupBy).toHaveBeenCalledWith(
            expect.objectContaining({
                by: ['customRoleId', 'role'],
                where: { tenantId: 'tenant-1', customRoleId: { not: null } },
            }),
        );
    });

    it('a role nobody carries counts no non-ADMIN carrier', async () => {
        seedRoleRow(getPermissionsForRole('READER'));
        const roles = await listCustomRoles(makeCtx('ADMIN'));
        expect(roles[0].nonAdminCarriers).toBe(0);
    });

    it('returns every PERMISSION_SCHEMA domain even when the stored JSON omits some', async () => {
        seedRoleRow(legacyBlob(), 'EDITOR');

        const roles = await listCustomRoles(makeCtx('ADMIN'));

        expect(roles).toHaveLength(1);
        const perms = roles[0].permissionsJson as unknown as Record<string, unknown>;

        const missing = Object.keys(PERMISSION_SCHEMA).filter(
            (domain) => perms[domain] === undefined || perms[domain] === null,
        );
        expect(missing).toEqual([]);
    });

    it('fills an absent domain from the row baseRole rather than inventing false', async () => {
        seedRoleRow(legacyBlob(), 'EDITOR');

        const roles = await listCustomRoles(makeCtx('ADMIN'));
        const perms = roles[0].permissionsJson;

        // EDITOR grants assets view/create/edit and incidents view only. Its
        // personnel domain is all-false (OWNER/ADMIN only since 2026-10-29),
        // so the personnel line can no longer tell a fill from an invented
        // `false`; the assets and incidents lines still can.
        expect(perms.assets).toEqual(getPermissionsForRole('EDITOR').assets);
        expect(perms.personnel).toEqual(getPermissionsForRole('EDITOR').personnel);
        expect(perms.incidents).toEqual(getPermissionsForRole('EDITOR').incidents);
    });

    it('does not lose the explicit grants the stored JSON DID carry', async () => {
        const blob = legacyBlob();
        // A deliberate deviation from the base role — this must survive.
        blob.policies = { view: true, create: false, edit: false, approve: true };
        seedRoleRow(blob, 'EDITOR');

        const roles = await listCustomRoles(makeCtx('ADMIN'));

        expect(roles[0].permissionsJson.policies).toEqual({
            view: true, create: false, edit: false, approve: true,
        });
    });

    it('every returned domain carries every action the schema declares', async () => {
        // A blob missing an ACTION rather than a whole domain — the case
        // the grid's `?? false` already tolerated, asserted here so the
        // normalisation does not regress it.
        const blob = legacyBlob();
        blob.reports = { view: true, export: true }; // no schedule_external
        seedRoleRow(blob, 'EDITOR');

        const roles = await listCustomRoles(makeCtx('ADMIN'));
        const perms = roles[0].permissionsJson as unknown as Record<string, Record<string, unknown>>;

        const missing: string[] = [];
        for (const [domain, actions] of Object.entries(PERMISSION_SCHEMA)) {
            for (const action of actions) {
                if (typeof perms[domain]?.[action] !== 'boolean') {
                    missing.push(`${domain}.${action}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('preserves the non-permission fields the page needs', async () => {
        seedRoleRow(legacyBlob(), 'EDITOR');

        const roles = await listCustomRoles(makeCtx('ADMIN'));

        expect(roles[0]).toMatchObject({
            id: 'cr-1',
            name: 'Legacy Role',
            baseRole: 'EDITOR',
            isActive: true,
            _count: { memberships: 2 },
        });
    });
});

// ─── Admin-base-only permissions (#4536, #4581 A) ───

describe('Custom Roles — the Admin-base-only permissions need an ADMIN base (#4536, #4581 A)', () => {
    /** A preset's blob with `domain.action` set as given. */
    const withKey = (base: Role, key: string, value: boolean) => {
        const [domain, action] = key.split('.');
        const p = getPermissionsForRole(base) as unknown as Record<string, Record<string, boolean>>;
        return { ...p, [domain]: { ...p[domain], [action]: value } };
    };
    const refusedFor = (...permissions: string[]) => ({
        details: { reason: 'PERMISSION_NEEDS_ADMIN_BASE', permissions },
    });
    /** An OWNER: holds every key, so only this rule can refuse. */
    const owner = (): RequestContext => ({ ...makeCtx('ADMIN'), role: 'OWNER', appPermissions: getPermissionsForRole('OWNER') });

    describe.each(ADMIN_BASE_ONLY_PERMISSIONS.map((k) => [k]))('%s', (key) => {
        it.each<Role>(['READER', 'EDITOR', 'AUDITOR'])('refuses to create a %s-based role holding it', async (base) => {
            mockTx.tenantCustomRole = { findFirst: jest.fn(async () => null), create: jest.fn() };
            await expect(
                createCustomRole(owner(), { name: 'R', baseRole: base, permissionsJson: withKey(base, key, true) }),
            ).rejects.toMatchObject(refusedFor(key));
            expect(mockTx.tenantCustomRole.create).not.toHaveBeenCalled();
        });

        it('creates an ADMIN-based role holding it', async () => {
            mockTx.tenantCustomRole = {
                findFirst: jest.fn(async () => null),
                create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cr-9', ...data })),
            };
            await createCustomRole(owner(), { name: 'R', baseRole: 'ADMIN', permissionsJson: withKey('ADMIN', key, true) });
            expect(mockTx.tenantCustomRole.create).toHaveBeenCalled();
        });
    });

    it('names every refused key, not just the first', async () => {
        mockTx.tenantCustomRole = { findFirst: jest.fn(async () => null), create: jest.fn() };
        const editor = getPermissionsForRole('EDITOR');
        const blob = { ...editor, admin: { ...editor.admin, manage: true, members: true } };
        await expect(
            createCustomRole(owner(), { name: 'R', baseRole: 'EDITOR', permissionsJson: blob }),
        ).rejects.toMatchObject(refusedFor('admin.manage', 'admin.members'));
    });

    it('allows the admin keys a custom role may hold on any base', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cr-9', ...data })),
        };
        const reader = getPermissionsForRole('READER');
        const blob = { ...reader, admin: { ...reader.admin, view: true, agent_registry: true, compliance_dsar_manage: true } };
        await createCustomRole(owner(), { name: 'Agent reviewer', baseRole: 'READER', permissionsJson: blob });
        expect(mockTx.tenantCustomRole.create).toHaveBeenCalled();
    });

    it('refuses an update that grants one on a READER base, and one that moves an ADMIN role holding one to READER', async () => {
        const update = jest.fn();
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({ id: 'cr-1', tenantId: 'tenant-1', name: 'R', baseRole: 'READER', isActive: true, permissionsJson: getPermissionsForRole('READER') })),
            update,
        };
        await expect(
            updateCustomRole(makeCtx(), 'cr-1', { permissionsJson: withKey('READER', 'admin.manage', true) }),
        ).rejects.toMatchObject(refusedFor('admin.manage'));

        mockTx.tenantCustomRole.findFirst = jest.fn(async () => ({ id: 'cr-1', tenantId: 'tenant-1', name: 'R', baseRole: 'ADMIN', isActive: true, permissionsJson: withKey('ADMIN', 'personnel.manage', true) }));
        // The ADMIN preset carries three of the list; the move names each.
        await expect(updateCustomRole(makeCtx(), 'cr-1', { baseRole: 'READER' })).rejects.toMatchObject(
            refusedFor('admin.manage', 'admin.members', 'personnel.manage'),
        );
        expect(update).not.toHaveBeenCalled();
    });

    it('a rename of a legacy role still holding one is not refused for a grant the rename does not touch', async () => {
        const legacy = { id: 'cr-1', tenantId: 'tenant-1', name: 'Old', baseRole: 'READER', isActive: true, permissionsJson: withKey('READER', 'admin.members', true) };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn().mockResolvedValueOnce(legacy).mockResolvedValueOnce(null),
            update: jest.fn(async () => ({ ...legacy, name: 'New' })),
        };
        await expect(updateCustomRole(makeCtx(), 'cr-1', { name: 'New' })).resolves.toMatchObject({ name: 'New' });
    });

    it('switching it off on a legacy role is accepted', async () => {
        const legacy = { id: 'cr-1', tenantId: 'tenant-1', name: 'Old', baseRole: 'READER', isActive: true, permissionsJson: withKey('READER', 'admin.members', true) };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => legacy),
            update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...legacy, ...data })),
        };
        await expect(
            updateCustomRole(makeCtx(), 'cr-1', { permissionsJson: withKey('READER', 'admin.members', false) }),
        ).resolves.toBeDefined();
    });
});
