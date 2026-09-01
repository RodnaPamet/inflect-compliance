/**
 * API Key Management + Scope Enforcement Tests
 *
 * Verifies:
 * 1. Admin can create/list/revoke API keys
 * 2. Non-admin cannot manage API keys
 * 3. Revoked key fails auth
 * 4. Scope validation rejects invalid scopes
 * 5. scopesToPermissions maps correctly
 * 6. enforceApiKeyScope allows/blocks correctly
 * 7. Full-access scope grants everything
 * 8. Resource wildcard scopes work
 */
import { getPermissionsForRole, PERMISSION_SCHEMA } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';

// ─── Mock db-context ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => {
        return fn(mockTx);
    }),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

import {
    validateScopes,
    scopesToPermissions,
    enforceApiKeyScope,
    VALID_SCOPES,
} from '@/lib/auth/api-key-auth';

import {
    listApiKeys,
    createApiKey,
    revokeApiKey,
} from '@/app-layer/usecases/api-keys';

// ─── Helpers ───

function makeCtx(role: Role = 'ADMIN', overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
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
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
});

// ─── Scope Validation ───

describe('API Key Scopes — Validation', () => {
    it('accepts valid scopes', () => {
        expect(validateScopes(['controls:read'])).toEqual([]);
        expect(validateScopes(['*'])).toEqual([]);
        expect(validateScopes(['controls:read', 'evidence:write'])).toEqual([]);
        expect(validateScopes(['controls:*'])).toEqual([]);
    });

    it('rejects non-array', () => {
        expect(validateScopes('controls:read')).toContainEqual(expect.stringMatching(/array/i));
    });

    it('rejects empty array', () => {
        expect(validateScopes([])).toContainEqual(expect.stringMatching(/at least one/i));
    });

    it('rejects invalid scope strings', () => {
        const errors = validateScopes(['invalid:scope']);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('Invalid scope');
    });

    it('VALID_SCOPES contains expected scopes', () => {
        expect(VALID_SCOPES).toContain('*');
        expect(VALID_SCOPES).toContain('controls:read');
        expect(VALID_SCOPES).toContain('controls:write');
        expect(VALID_SCOPES).toContain('controls:*');
        expect(VALID_SCOPES).toContain('evidence:read');
        expect(VALID_SCOPES).toContain('admin:write');
    });
});

// ─── Scope to Permission Mapping ───

describe('API Key Scopes — scopesToPermissions', () => {
    it('full access (*) returns ADMIN permissions', () => {
        const perms = scopesToPermissions(['*']);
        const adminPerms = getPermissionsForRole('ADMIN');
        expect(perms).toEqual(adminPerms);
    });

    it('controls:read grants only controls.view', () => {
        const perms = scopesToPermissions(['controls:read']);
        expect(perms.controls.view).toBe(true);
        expect(perms.controls.create).toBe(false);
        expect(perms.controls.edit).toBe(false);
    });

    it('controls:write grants controls.create and controls.edit', () => {
        const perms = scopesToPermissions(['controls:write']);
        expect(perms.controls.create).toBe(true);
        expect(perms.controls.edit).toBe(true);
        expect(perms.controls.view).toBe(false); // read not included in write
    });

    it('controls:* grants all controls actions', () => {
        const perms = scopesToPermissions(['controls:*']);
        expect(perms.controls.view).toBe(true);
        expect(perms.controls.create).toBe(true);
        expect(perms.controls.edit).toBe(true);
    });

    it('evidence:read grants view and download', () => {
        const perms = scopesToPermissions(['evidence:read']);
        expect(perms.evidence.view).toBe(true);
        expect(perms.evidence.download).toBe(true);
        expect(perms.evidence.upload).toBe(false);
    });

    it('multiple scopes combine correctly', () => {
        const perms = scopesToPermissions(['controls:read', 'evidence:write']);
        expect(perms.controls.view).toBe(true);
        expect(perms.controls.create).toBe(false);
        expect(perms.evidence.upload).toBe(true);
        expect(perms.evidence.edit).toBe(true);
        expect(perms.evidence.view).toBe(false); // read not granted
    });

    it('grants nothing for empty scopes', () => {
        const perms = scopesToPermissions([]);
        // All should be false
        expect(perms.controls.view).toBe(false);
        expect(perms.evidence.upload).toBe(false);
        expect(perms.admin.manage).toBe(false);
    });
});

// ─── Scope Enforcement ───

describe('API Key Scopes — enforceApiKeyScope', () => {
    it('no-op for session-authenticated requests (no apiKeyId)', () => {
        const ctx = makeCtx();
        // Should not throw
        expect(() => enforceApiKeyScope(ctx, 'controls', 'read')).not.toThrow();
    });

    it('allows access when scope matches', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['controls:read', 'evidence:write'],
        });
        expect(() => enforceApiKeyScope(ctx, 'controls', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'evidence', 'write')).not.toThrow();
    });

    it('blocks access when scope is missing', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['controls:read'],
        });
        expect(() => enforceApiKeyScope(ctx, 'evidence', 'write')).toThrow(/does not have scope/);
        expect(() => enforceApiKeyScope(ctx, 'controls', 'write')).toThrow(/does not have scope/);
    });

    it('full access (*) allows everything', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['*'],
        });
        expect(() => enforceApiKeyScope(ctx, 'controls', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'admin', 'write')).not.toThrow();
    });

    it('resource wildcard (controls:*) allows all actions on resource', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['controls:*'],
        });
        expect(() => enforceApiKeyScope(ctx, 'controls', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'controls', 'write')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'evidence', 'read')).toThrow(/does not have scope/);
    });
});

// ─── API Key CRUD ───

describe('API Key Management — Authorization', () => {
    const NON_ADMIN_ROLES: Role[] = ['EDITOR', 'READER', 'AUDITOR'];

    NON_ADMIN_ROLES.forEach((role) => {
        it(`${role} cannot list API keys`, async () => {
            await expect(listApiKeys(makeCtx(role))).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot create API keys`, async () => {
            await expect(
                createApiKey(makeCtx(role), { name: 'Test', scopes: ['*'] })
            ).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot revoke API keys`, async () => {
            await expect(revokeApiKey(makeCtx(role), 'ak-1')).rejects.toThrow(/permission|admin/i);
        });
    });
});

describe('API Key Management — Create', () => {
    it('creates a key and returns plaintext', async () => {
        mockTx.tenantApiKey = {
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
                id: 'ak-1',
                name: data.name,
                keyPrefix: data.keyPrefix,
                scopes: data.scopes,
                expiresAt: null,
                createdAt: new Date(),
            })),
        };

        const result = await createApiKey(makeCtx(), {
            name: 'CI Key',
            scopes: ['controls:read'],
        });

        expect(result.name).toBe('CI Key');
        expect(result.plaintext).toBeDefined();
        expect(result.plaintext.startsWith('iflk_')).toBe(true);
        // The hash stored in DB should NOT be the plaintext
        const createCall = mockTx.tenantApiKey.create.mock.calls[0][0];
        expect(createCall.data.keyHash).not.toBe(result.plaintext);
    });

    it('rejects invalid scopes', async () => {
        await expect(
            createApiKey(makeCtx(), { name: 'Bad', scopes: ['invalid:scope'] })
        ).rejects.toThrow(/Invalid scopes/);
    });

    it('rejects empty name', async () => {
        await expect(
            createApiKey(makeCtx(), { name: '  ', scopes: ['*'] })
        ).rejects.toThrow(/name/i);
    });

    it('rejects past expiry', async () => {
        await expect(
            createApiKey(makeCtx(), {
                name: 'Expired',
                scopes: ['*'],
                expiresAt: new Date(Date.now() - 86400000).toISOString(),
            })
        ).rejects.toThrow(/future/i);
    });
});

describe('API Key Management — Revoke', () => {
    it('revokes an active key', async () => {
        mockTx.tenantApiKey = {
            findFirst: jest.fn(async () => ({
                id: 'ak-1', tenantId: 'tenant-1', name: 'Active Key', revokedAt: null,
            })),
            update: jest.fn(async () => ({
                id: 'ak-1', name: 'Active Key', keyPrefix: 'iflk_test', revokedAt: new Date(),
            })),
        };

        const result = await revokeApiKey(makeCtx(), 'ak-1');
        expect(result.revokedAt).toBeDefined();
    });

    it('rejects revoking already-revoked key', async () => {
        mockTx.tenantApiKey = {
            findFirst: jest.fn(async () => ({
                id: 'ak-1', tenantId: 'tenant-1', name: 'R Key', revokedAt: new Date(),
            })),
        };

        await expect(revokeApiKey(makeCtx(), 'ak-1')).rejects.toThrow(/already revoked/i);
    });

    it('rejects revoking non-existent key', async () => {
        mockTx.tenantApiKey = {
            findFirst: jest.fn(async () => null),
        };

        await expect(revokeApiKey(makeCtx(), 'missing')).rejects.toThrow(/not found/i);
    });
});


// ─── Scope coverage of PERMISSION_SCHEMA (#2225) ───

describe('API Key Scopes — every permission domain has a scope decision', () => {
    /**
     * `SCOPE_ACTION_MAP` cannot be DERIVED from `PERMISSION_SCHEMA` —
     * grouping a domain's actions into read / write / admin is an
     * editorial judgement, not bookkeeping. So this asserts COVERAGE
     * instead: both sides are read from their own source, and neither
     * list is restated here.
     *
     * `assets`, `personnel` and `incidents` were absent until #2225,
     * which left them reachable only by a `*` key — i.e. the only way
     * to give a key access to the asset register was to give it
     * everything. A future domain added to `PermissionSet` without a
     * scope decision fails this test rather than silently repeating
     * that.
     */

    /** Scopes are `resource:action`; the resource half is what we check. */
    const scopeResources = new Set(
        VALID_SCOPES.filter((s) => s !== '*').map((s) => s.split(':')[0]),
    );

    it('reads a non-trivial schema (guards the derivation itself)', () => {
        expect(Object.keys(PERMISSION_SCHEMA).length).toBeGreaterThan(10);
        expect(scopeResources.size).toBeGreaterThan(10);
    });

    it('every PermissionSet domain is reachable by a scoped key', () => {
        const unreachable = Object.keys(PERMISSION_SCHEMA).filter(
            (domain) => !scopeResources.has(domain),
        );
        expect(unreachable).toEqual([]);
    });

    it('the three domains #2225 measured as missing are now scopable', () => {
        for (const domain of ['assets', 'personnel', 'incidents']) {
            expect(VALID_SCOPES).toContain(`${domain}:read`);
            expect(VALID_SCOPES).toContain(`${domain}:*`);
        }
    });

    it('a scoped key for a new domain resolves only that domain', () => {
        const perms = scopesToPermissions(['assets:read']);

        expect(perms.assets).toEqual({ view: true, create: false, edit: false });
        // Nothing else leaks on.
        expect(perms.controls.view).toBe(false);
        expect(perms.personnel.view).toBe(false);
        expect(perms.incidents.view).toBe(false);
    });

    it('the privileged manage flags need an explicit admin-group scope', () => {
        expect(scopesToPermissions(['personnel:read']).personnel).toEqual({
            view: true, manage: false,
        });
        expect(scopesToPermissions(['personnel:admin']).personnel.manage).toBe(true);
        expect(scopesToPermissions(['incidents:admin']).incidents.manage).toBe(true);
    });

    it('adding domains did not change what an existing scope resolves to', () => {
        // The regression a reviewer will reasonably worry about. The
        // skeleton in `scopesToPermissions` comes from
        // `getPermissionsForRole('READER')`, not from SCOPE_ACTION_MAP,
        // so widening the map cannot subtract from an issued key.
        const perms = scopesToPermissions(['controls:read', 'evidence:read']);
        expect(perms.controls).toEqual({ view: true, create: false, edit: false });
        expect(perms.evidence).toEqual({
            view: true, upload: false, edit: false, download: true,
        });
    });

    it('no scope maps to an action the schema does not declare', () => {
        // Catches a typo in the map (e.g. `['veiw']`), which would
        // otherwise be a silently inert scope.
        const bogus: string[] = [];
        for (const domain of Object.keys(PERMISSION_SCHEMA)) {
            const resolved = scopesToPermissions([`${domain}:*`]) as unknown as
                Record<string, Record<string, boolean>>;
            for (const action of Object.keys(resolved[domain])) {
                if (!PERMISSION_SCHEMA[domain as keyof typeof PERMISSION_SCHEMA].includes(action)) {
                    bogus.push(`${domain}.${action}`);
                }
            }
        }
        expect(bogus).toEqual([]);
    });
});
