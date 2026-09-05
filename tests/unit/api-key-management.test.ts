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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
    it('full access (*) returns ADMIN permissions apart from the agent-governance flags', () => {
        const perms = scopesToPermissions(['*']);
        const adminPerms = getPermissionsForRole('ADMIN');
        // Every domain but `admin` is ADMIN exactly.
        const { admin: starAdmin, ...starRest } = perms;
        const { admin: adminAdmin, ...adminRest } = adminPerms;
        expect(starRest).toEqual(adminRest);
        // And `admin` differs in exactly two places — asserted as a whole
        // object, so a THIRD divergence appearing later fails here rather than
        // slipping past two named checks.
        expect(starAdmin).toEqual({
            ...adminAdmin,
            agent_registry: false,
            agent_tool_exposure: false,
        });
    });

    it('full access (*) cannot decide which agents may act, or what they may reach', () => {
        // ADMIN holds both of these, so unlike the two OWNER-only actions below
        // they are denied to `*` explicitly. The reason is a composition: a `*`
        // key CARRIED BY an agent could otherwise activate its own registration
        // and grant itself every MCP tool, and a deny-by-default allowlist its
        // own subject can widen is not an allowlist.
        const star = scopesToPermissions(['*']);
        expect(star.admin.agent_registry).toBe(false);
        expect(star.admin.agent_tool_exposure).toBe(false);
        // The contrast that makes it a decision rather than an omission: a human
        // ADMIN session holds both.
        expect(getPermissionsForRole('ADMIN').admin.agent_registry).toBe(true);
        expect(getPermissionsForRole('ADMIN').admin.agent_tool_exposure).toBe(true);
        // And the asymmetry is deliberate — `*` still reaches the privileged
        // DATA operations. Without this the assertions above would also pass on
        // a `*` that had quietly stopped granting anything at all.
        expect(star.admin.compliance_dsar_manage).toBe(true);
        expect(star.reports.schedule_external).toBe(true);
    });

    it('full access (*) still does NOT reach the two OWNER-only actions', () => {
        // The consequence of the assertion above, named rather than implied.
        // `perms === ADMIN` is a shape fact; a reader has to already know that
        // ADMIN denies these to get the security property out of it — and the
        // module docblock got it exactly backwards for that reason, telling
        // operators a `*` key "still reaches them" and is therefore the grant to
        // make consciously. It reaches neither. Deleting a tenant, rotating a
        // DEK and managing OWNERs need a real OWNER session; no bearer token,
        // however scoped, can do them.
        const star = scopesToPermissions(['*']);
        expect(star.admin.tenant_lifecycle).toBe(false);
        expect(star.admin.owner_management).toBe(false);
        // Paired positive, so it cannot pass on a permission set that denies
        // everything — `*` really is the widest key there is.
        expect(star.admin.manage).toBe(true);
        // And the contrast that makes the point: OWNER has them.
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
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

// ─── The operator-facing half of the same mirror (#2197) ───

describe('API Key Scopes — every domain the auth layer accepts is offerable', () => {
    /**
     * `SCOPE_GROUPS` in the admin api-keys page is the SECOND hand-written
     * mirror the `PERMISSION_SCHEMA` docstring names, and that docstring
     * claimed the coverage of BOTH was asserted "so a missing entry fails a
     * test rather than shipping". Only `SCOPE_ACTION_MAP` had such a test. So a
     * domain could be scopable by the auth layer and invisible in the only UI
     * that grants scopes — the #2225 defect, one layer along.
     *
     * Read from SOURCE rather than imported: the page is a `'use client'`
     * module and `SCOPE_GROUPS` is not exported. That makes this a text scan,
     * with the weakness text scans have — it would not notice the constant
     * being renamed. So the parse asserts it found something first, and the
     * failure mode is a red test rather than a vacuous pass.
     */
    const PAGE = path.join(
        __dirname,
        '../../src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx',
    );
    const pageSrc = fs.readFileSync(PAGE, 'utf8');
    const block = pageSrc.slice(
        pageSrc.indexOf('const SCOPE_GROUPS'),
        pageSrc.indexOf('const EXPIRY_OPTIONS'),
    );
    const declared = [...block.matchAll(/^ {4}(\w+):\s*\{/gm)].map((m) => m[1]);
    const offered = [...block.matchAll(/'([a-z_]+:[a-z*]+)'/g)].map((m) => m[1]);

    it('the parse found the map (guards the scan itself)', () => {
        expect(block.length).toBeGreaterThan(200);
        expect(declared.length).toBeGreaterThan(10);
        expect(offered.length).toBeGreaterThan(10);
    });

    it('every PermissionSet domain has an operator-facing group', () => {
        const missing = Object.keys(PERMISSION_SCHEMA).filter(
            (domain) => !declared.includes(domain),
        );
        expect(missing).toEqual([]);
    });

    it('every scope the UI offers is one validateScopes accepts', () => {
        // The mirror's other failure direction: a checkbox writing a scope the
        // API then rejects, so key creation 400s with no clue why.
        const bogus = offered.filter((s) => !VALID_SCOPES.includes(s));
        expect(bogus).toEqual([]);
    });
});
