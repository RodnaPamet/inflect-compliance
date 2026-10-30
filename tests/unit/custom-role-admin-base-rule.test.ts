/**
 * Which permissions only an ADMIN-based custom role may hold (#4536, #4581 A).
 *
 * The rule's list is a decision per key, so this file holds that every
 * `admin` key IS one: each sits in exactly one of `ADMIN_BASE_ONLY_PERMISSIONS`
 * and `ADMIN_KEYS_ON_ANY_BASE`, and a key added to `PERMISSION_SCHEMA.admin`
 * fails here until somebody classifies it.
 *
 * It also holds what the list means for the built-in roles: no built-in role
 * below ADMIN holds any key on the list, so a preset never trips the rule.
 */
import { PERMISSION_SCHEMA, getPermissionsForRole } from '@/lib/permissions';
import {
    ADMIN_BASE_ONLY_PERMISSIONS,
    ADMIN_KEYS_ON_ANY_BASE,
    PERMISSION_NEEDS_ADMIN_BASE,
    adminBaseOnlyGrants,
    adminBaseRefusalPermissions,
    grantsNeedingAdminBase,
    mayHoldOnBase,
    needsAdminBase,
} from '@/lib/custom-role-admin-base-rule';

const adminOnly = ADMIN_BASE_ONLY_PERMISSIONS.filter((k) => k.startsWith('admin.')).map((k) => k.slice(6));

describe('every admin key is classified once', () => {
    test('the two lists together are exactly PERMISSION_SCHEMA.admin', () => {
        expect([...adminOnly, ...Object.keys(ADMIN_KEYS_ON_ANY_BASE)].sort()).toEqual([...PERMISSION_SCHEMA.admin].sort());
    });

    test('no key is in both', () => {
        expect(adminOnly.filter((k) => k in ADMIN_KEYS_ON_ANY_BASE)).toEqual([]);
    });

    test('every key on the list exists in the schema', () => {
        for (const key of ADMIN_BASE_ONLY_PERMISSIONS) {
            const [domain, action] = key.split('.');
            expect({ key, known: (PERMISSION_SCHEMA as Record<string, string[]>)[domain]?.includes(action) }).toEqual({ key, known: true });
        }
    });

    test('every key allowed on any base says why', () => {
        for (const [key, why] of Object.entries(ADMIN_KEYS_ON_ANY_BASE)) expect({ key, why: why.length > 10 }).toEqual({ key, why: true });
    });
});

describe('the built-in roles below ADMIN hold none of the list', () => {
    test.each(['EDITOR', 'AUDITOR', 'READER'] as const)('%s preset', (role) => {
        expect(grantsNeedingAdminBase(getPermissionsForRole(role), role)).toEqual([]);
        expect(adminBaseOnlyGrants(getPermissionsForRole(role))).toEqual([]);
    });

    test('the ADMIN preset holds all but the OWNER-only keys, and may', () => {
        expect(adminBaseOnlyGrants(getPermissionsForRole('ADMIN'))).toEqual(['admin.manage', 'admin.members', 'personnel.manage']);
        expect(grantsNeedingAdminBase(getPermissionsForRole('ADMIN'), 'ADMIN')).toEqual([]);
    });
});

describe('the helpers', () => {
    test('needsAdminBase and mayHoldOnBase', () => {
        expect(needsAdminBase('admin', 'manage')).toBe(true);
        expect(needsAdminBase('admin', 'view')).toBe(false);
        expect(needsAdminBase('personnel', 'manage')).toBe(true);
        expect(needsAdminBase('personnel', 'view')).toBe(false);
        expect(mayHoldOnBase('ADMIN', 'admin', 'tenant_lifecycle')).toBe(true);
        for (const base of ['EDITOR', 'AUDITOR', 'READER']) {
            expect(mayHoldOnBase(base, 'admin', 'tenant_lifecycle')).toBe(false);
            expect(mayHoldOnBase(base, 'admin', 'view')).toBe(true);
            expect(mayHoldOnBase(base, 'admin', 'agent_registry')).toBe(true);
        }
    });

    test('only a JSON true counts as a grant, and an absent domain grants nothing', () => {
        expect(adminBaseOnlyGrants({ admin: { manage: 'true', members: 1, owner_management: true } })).toEqual(['admin.owner_management']);
        expect(adminBaseOnlyGrants({})).toEqual([]);
        expect(adminBaseOnlyGrants(null)).toEqual([]);
    });

    test('a refusal body is read back to its keys, and anything else to null', () => {
        expect(adminBaseRefusalPermissions({ error: { details: { reason: PERMISSION_NEEDS_ADMIN_BASE, permissions: ['admin.manage', 3] } } })).toEqual(['admin.manage']);
        expect(adminBaseRefusalPermissions({ error: { details: { reason: PERMISSION_NEEDS_ADMIN_BASE } } })).toEqual([]);
        expect(adminBaseRefusalPermissions({ error: { details: { reason: 'OTHER' } } })).toBeNull();
        expect(adminBaseRefusalPermissions(null)).toBeNull();
    });
});
