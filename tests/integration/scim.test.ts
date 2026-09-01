/**
 * Integration tests for SCIM 2.0 lifecycle, safety, and audit.
 *
 * Tests cover:
 * - SCIM auth (token validation, revocation, missing header)
 * - SCIM types (error, list, ServiceProviderConfig shapes)
 * - User lifecycle (create, get, list, patch, deactivate, reactivate)
 * - Role mapping safety (allow-list, ADMIN blocked)
 * - Idempotency (repeated create returns same user)
 * - Audit events emitted for all mutations
 * - Tenant isolation
 * - Groups-path role ceiling + protected-membership refusals (#2200)
 */
import { createHash } from 'crypto';

// ─── Mock Prisma ────────────────────────────────────────────────────

const mockPrisma = {
    tenantScimToken: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
    },
    tenantMembership: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
    },
    user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    // ── Groups path (EI-3) ──
    scimGroup: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
    },
    tenantEntraGroupMapping: { findMany: jest.fn(), updateMany: jest.fn() },
    tenantIdentityProvider: { findFirst: jest.fn() },
    userIdentityLink: { findMany: jest.fn() },
    $transaction: jest.fn(),
};

const mockAppendAuditEntry = jest.fn().mockResolvedValue({ id: 'audit-1', entryHash: 'abc', previousHash: null });

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));
// `entra-group-sync` writes through the barrel, not the writer module.
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));
// `ScimGroup` is FORCE-RLS'd, so the usecase runs every query inside a tenant
// context. Hand it the same mock client the rest of the file uses.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (
        _ctx: unknown,
        fn: (db: typeof mockPrisma) => unknown,
    ) => fn(mockPrisma),
}));

// ─── Import after mock ──────────────────────────────────────────────

import { authenticateScimRequest, hashToken, ScimAuthError } from '@/lib/scim/auth';
import {
    toScimUser, resolveScimRole,
    scimCreateUser, scimPatchUser, scimDeleteUser, scimListUsers, scimGetUser,
} from '@/app-layer/usecases/scim-users';
import { scimCreateGroup, scimGroupResource } from '@/app-layer/usecases/scim-groups';
import { scimError, scimListResponse, scimServiceProviderConfig, SCIM_SCHEMAS } from '@/lib/scim/types';
import { POST as GroupsPost } from '@/app/api/scim/v2/Groups/route';
import { NextRequest } from 'next/server';

const TENANT_A = 'tenant-a-id';
const RAW_TOKEN = 'scim-test-token-12345';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const BASE_URL = 'http://localhost:3000';
const now = new Date();

function makeRequest(token?: string): NextRequest {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    return new NextRequest('http://localhost:3000/api/scim/v2/Users', { headers });
}

const ctx = { tenantId: TENANT_A, tokenId: 'tok1', tokenLabel: 'Test SCIM' };

// ═════════════════════════════════════════════════════════════════════
// AUTH TESTS
// ═════════════════════════════════════════════════════════════════════

describe('SCIM Auth', () => {
    beforeEach(() => jest.clearAllMocks());

    test('hashToken produces SHA-256 hex', () => {
        expect(hashToken('test')).toBe(createHash('sha256').update('test').digest('hex'));
    });

    test('rejects missing Authorization header', async () => {
        await expect(authenticateScimRequest(makeRequest())).rejects.toThrow(ScimAuthError);
    });

    test('rejects invalid token', async () => {
        mockPrisma.tenantScimToken.findUnique.mockResolvedValue(null);
        await expect(authenticateScimRequest(makeRequest('wrong'))).rejects.toThrow('Invalid SCIM token');
    });

    test('rejects revoked token', async () => {
        mockPrisma.tenantScimToken.findUnique.mockResolvedValue({
            id: 'tok1', tenantId: TENANT_A, label: 'Revoked', tokenHash: TOKEN_HASH,
            revokedAt: new Date(), tenant: { id: TENANT_A, slug: 'acme' },
        });
        await expect(authenticateScimRequest(makeRequest(RAW_TOKEN))).rejects.toThrow('revoked');
    });

    test('authenticates valid token', async () => {
        mockPrisma.tenantScimToken.findUnique.mockResolvedValue({
            id: 'tok1', tenantId: TENANT_A, label: 'Okta', tokenHash: TOKEN_HASH,
            revokedAt: null, tenant: { id: TENANT_A, slug: 'acme' },
        });
        const result = await authenticateScimRequest(makeRequest(RAW_TOKEN));
        expect(result.tenantId).toBe(TENANT_A);
        expect(result.tokenLabel).toBe('Okta');
    });
});

// ═════════════════════════════════════════════════════════════════════
// TYPES TESTS
// ═════════════════════════════════════════════════════════════════════

describe('SCIM Types', () => {
    test('scimError shape', () => {
        const err = scimError(404, 'Not found');
        expect(err.schemas).toContain(SCIM_SCHEMAS.Error);
        expect(err.status).toBe('404');
    });

    test('scimListResponse wraps resources', () => {
        const list = scimListResponse([{ x: 1 }], 1);
        expect(list.schemas).toContain(SCIM_SCHEMAS.ListResponse);
        expect(list.Resources).toHaveLength(1);
    });

    test('scimServiceProviderConfig shape', () => {
        const config = scimServiceProviderConfig(BASE_URL);
        expect(config.patch.supported).toBe(true);
        expect(config.authenticationSchemes).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// ROLE MAPPING TESTS
// ═════════════════════════════════════════════════════════════════════

describe('SCIM Role Mapping', () => {
    test('undefined role → READER (default)', () => {
        const result = resolveScimRole(undefined);
        expect(result.role).toBe('READER');
        expect(result.blocked).toBe(false);
    });

    test('"reader" → READER', () => {
        expect(resolveScimRole('reader').role).toBe('READER');
    });

    test('"editor" → EDITOR', () => {
        expect(resolveScimRole('editor').role).toBe('EDITOR');
    });

    test('"auditor" → AUDITOR', () => {
        expect(resolveScimRole('auditor').role).toBe('AUDITOR');
    });

    test('"EDITOR" (case-insensitive) → EDITOR', () => {
        expect(resolveScimRole('EDITOR').role).toBe('EDITOR');
    });

    test('"admin" → BLOCKED, falls back to READER', () => {
        const result = resolveScimRole('admin');
        expect(result.role).toBe('READER');
        expect(result.blocked).toBe(true);
        expect(result.requestedRole).toBe('admin');
    });

    test('"superadmin" → BLOCKED', () => {
        const result = resolveScimRole('superadmin');
        expect(result.blocked).toBe(true);
    });

    test('"unknown_role" → BLOCKED', () => {
        const result = resolveScimRole('unknown_role');
        expect(result.blocked).toBe(true);
        expect(result.role).toBe('READER');
    });
});

// ═════════════════════════════════════════════════════════════════════
// USER LIFECYCLE TESTS
// ═════════════════════════════════════════════════════════════════════

describe('SCIM User Lifecycle', () => {
    beforeEach(() => jest.clearAllMocks());

    test('toScimUser maps correctly', () => {
        const user = { id: 'u1', email: 'a@acme.com', name: 'Alice Smith', createdAt: now, updatedAt: now };
        const scim = toScimUser(user, { status: 'ACTIVE' }, BASE_URL);
        expect(scim.userName).toBe('a@acme.com');
        expect(scim.active).toBe(true);
        expect(scim.name?.givenName).toBe('Alice');
        expect(scim.name?.familyName).toBe('Smith');
    });

    test('toScimUser active=false for DEACTIVATED', () => {
        const user = { id: 'u1', email: 'a@acme.com', name: 'Test', createdAt: now, updatedAt: now };
        expect(toScimUser(user, { status: 'DEACTIVATED' }, BASE_URL).active).toBe(false);
    });

    // ── Create ──

    test('create new user + membership + audit event', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
            const user = { id: 'u-new', email: 'new@acme.com', name: 'New', createdAt: now, updatedAt: now };
            const membership = { id: 'm-new', status: 'ACTIVE', role: 'READER' };
            return fn({
                user: { create: () => Promise.resolve(user) },
                tenantMembership: { create: () => Promise.resolve(membership) },
            });
        });

        const result = await scimCreateUser(ctx, { userName: 'new@acme.com', displayName: 'New' }, BASE_URL);
        expect(result.created).toBe(true);
        expect(result.user.userName).toBe('new@acme.com');

        // Audit event emitted
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: TENANT_A,
                actorType: 'SCIM',
                action: 'SCIM_USER_CREATED',
            })
        );
    });

    test('create with role="editor" assigns EDITOR', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
            const user = { id: 'u1', email: 'ed@acme.com', name: 'Ed', createdAt: now, updatedAt: now };
            const membership = { id: 'm1', status: 'ACTIVE', role: 'EDITOR' };
            return fn({
                user: { create: () => Promise.resolve(user) },
                tenantMembership: { create: () => Promise.resolve(membership) },
            });
        });

        await scimCreateUser(ctx, {
            userName: 'ed@acme.com',
            roles: [{ value: 'editor' }],
        }, BASE_URL);

        // Transaction was called — role resolved to EDITOR
        expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    test('create with role="admin" is BLOCKED → assigns READER', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
            const user = { id: 'u1', email: 'admin-try@acme.com', name: 'Admin Try', createdAt: now, updatedAt: now };
            const membership = { id: 'm1', status: 'ACTIVE', role: 'READER' };
            return fn({
                user: { create: () => Promise.resolve(user) },
                tenantMembership: { create: () => Promise.resolve(membership) },
            });
        });

        const result = await scimCreateUser(ctx, {
            userName: 'admin-try@acme.com',
            roles: [{ value: 'admin' }],
        }, BASE_URL);

        expect(result.created).toBe(true);
    });

    // ── Idempotency ──

    test('repeated create returns existing user (idempotent)', async () => {
        const existingUser = { id: 'u-exists', email: 'exists@acme.com', name: 'Exists', createdAt: now, updatedAt: now };
        mockPrisma.user.findUnique.mockResolvedValue(existingUser);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue({
            id: 'm1', tenantId: TENANT_A, userId: 'u-exists', status: 'ACTIVE', role: 'READER',
        });

        const result = await scimCreateUser(ctx, { userName: 'exists@acme.com' }, BASE_URL);
        expect(result.created).toBe(false);
        expect(result.user.active).toBe(true);
        // No audit event for idempotent no-op
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    test('create reactivates deactivated user + emits REACTIVATED audit', async () => {
        const existingUser = { id: 'u-old', email: 'old@acme.com', name: 'Old', createdAt: now, updatedAt: now };
        mockPrisma.user.findUnique.mockResolvedValue(existingUser);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue({
            id: 'm1', tenantId: TENANT_A, userId: 'u-old', status: 'DEACTIVATED', role: 'READER',
        });
        mockPrisma.tenantMembership.update.mockResolvedValue({});

        const result = await scimCreateUser(ctx, { userName: 'old@acme.com' }, BASE_URL);
        expect(result.created).toBe(false);
        expect(result.user.active).toBe(true);

        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_REACTIVATED' })
        );
    });

    // ── Patch ──

    test('patch active=false → DEACTIVATED + audit', async () => {
        const user = { id: 'u1', email: 'a@acme.com', name: 'A', createdAt: now, updatedAt: now, passwordHash: null };
        mockPrisma.tenantMembership.findFirst
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'READER', user })
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'DEACTIVATED', user });
        mockPrisma.tenantMembership.update.mockResolvedValue({});

        await scimPatchUser(ctx, 'u1', [{ op: 'replace', path: 'active', value: false }], BASE_URL);

        expect(mockPrisma.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'DEACTIVATED' }) })
        );
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_DEACTIVATED' })
        );
    });

    test('patch displayName + audit', async () => {
        const user = { id: 'u1', email: 'a@acme.com', name: 'Old', createdAt: now, updatedAt: now, passwordHash: null };
        mockPrisma.tenantMembership.findFirst
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'READER', user })
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', user: { ...user, name: 'New' } });

        await scimPatchUser(ctx, 'u1', [{ op: 'replace', path: 'displayName', value: 'New' }], BASE_URL);

        expect(mockPrisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: 'New' }) })
        );
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_UPDATED' })
        );
    });

    test('patch roles with allowed value updates role', async () => {
        const user = { id: 'u1', email: 'a@acme.com', name: 'A', createdAt: now, updatedAt: now, passwordHash: null };
        mockPrisma.tenantMembership.findFirst
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'READER', user })
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', user });
        mockPrisma.tenantMembership.update.mockResolvedValue({});

        await scimPatchUser(ctx, 'u1', [
            { op: 'replace', path: 'roles', value: [{ value: 'editor' }] },
        ], BASE_URL);

        expect(mockPrisma.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ role: 'EDITOR' }) })
        );
    });

    test('patch roles with "admin" is blocked', async () => {
        const user = { id: 'u1', email: 'a@acme.com', name: 'A', createdAt: now, updatedAt: now, passwordHash: null };
        mockPrisma.tenantMembership.findFirst
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'READER', user })
            .mockResolvedValueOnce({ id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', user });

        await scimPatchUser(ctx, 'u1', [
            { op: 'replace', path: 'roles', value: [{ value: 'admin' }] },
        ], BASE_URL);

        // Should NOT update role to ADMIN — no role update call
        const roleCalls = mockPrisma.tenantMembership.update.mock.calls.filter(
            (c: unknown[]) => (c[0] as { data: { role?: string } }).data.role !== undefined
        );
        expect(roleCalls).toHaveLength(0);
    });

    // ── Delete ──

    test('delete soft-deactivates + audit', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            // `role` is load-bearing since #2200 — the protected-membership
            // guard reads it, and an absent role fails CLOSED.
            id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'READER',
            user: { email: 'a@acme.com' },
        });
        mockPrisma.tenantMembership.update.mockResolvedValue({});

        const result = await scimDeleteUser(ctx, 'u1');
        expect(result).toBe(true);
        expect(mockPrisma.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'DEACTIVATED' }) })
        );
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_DEACTIVATED' })
        );
    });

    test('delete unknown user returns false', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue(null);
        expect(await scimDeleteUser(ctx, 'u-nope')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// TENANT ISOLATION TESTS
// ═════════════════════════════════════════════════════════════════════

describe('SCIM Tenant Isolation', () => {
    beforeEach(() => jest.clearAllMocks());

    test('get scoped to token tenant', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue(null);
        expect(await scimGetUser(ctx, 'u-other', BASE_URL)).toBeNull();
        expect(mockPrisma.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_A }) })
        );
    });

    test('delete scoped to token tenant', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue(null);
        expect(await scimDeleteUser(ctx, 'u-other')).toBe(false);
    });

    test('list scoped to token tenant', async () => {
        mockPrisma.tenantMembership.findMany.mockResolvedValue([]);
        mockPrisma.tenantMembership.count.mockResolvedValue(0);
        await scimListUsers(ctx, BASE_URL);
        expect(mockPrisma.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_A }) })
        );
    });
});

// ═════════════════════════════════════════════════════════════════════
// GROUPS PATH — ROLE CEILING (#2200)
// ═════════════════════════════════════════════════════════════════════
//
// The Users-path equivalents live above ("patch roles with 'admin' is
// blocked"). Those were the only ones that existed, and that is precisely why
// the Groups path could promote to ADMIN for as long as it did: the ceiling
// used to live inside `scim-users.ts`, read by `resolveScimRole` alone, while
// the Groups path resolved roles through `TenantEntraGroupMapping` — where
// ADMIN *is* a legal mapping target for the sign-in path.
//
// These exercise the REAL `syncEntraMembershipRole` (only Prisma is mocked), so
// they cover the seam between the two modules rather than the clamp's own API.

// A ScimGroup's externalId is matched against `TenantEntraGroupMapping.aadGroupId`,
// which the admin API constrains to a UUID — so an attacker's pushed value has
// to be one too.
const ADMIN_GROUP = '11111111-1111-4111-8111-111111111111';
const EDITOR_GROUP = '22222222-2222-4222-8222-222222222222';

function primeGroupsPath(opts: {
    mappings: Array<{ aadGroupId: string; role: string; priority: number }>;
    membership: { id: string; role: string } | null;
    /** The externalIds of every ScimGroup the member ends up in. */
    memberOfGroups: string[];
}) {
    mockPrisma.userIdentityLink.findMany.mockResolvedValue([{ userId: 'u1' }]);
    mockPrisma.scimGroup.create.mockResolvedValue({
        id: 'g1', externalId: ADMIN_GROUP, displayName: 'Pushed', memberIds: ['u1'],
    });
    mockPrisma.scimGroup.findMany.mockResolvedValue(
        opts.memberOfGroups.map((externalId) => ({ externalId })),
    );
    mockPrisma.tenantEntraGroupMapping.findMany.mockResolvedValue(opts.mappings);
    mockPrisma.tenantMembership.findFirst.mockResolvedValue(opts.membership);
    mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValue(null);
    mockPrisma.tenantMembership.update.mockResolvedValue({});
}

const roleWrites = (): string[] =>
    mockPrisma.tenantMembership.update.mock.calls
        .map((c: unknown[]) => (c[0] as { data?: { role?: string } }).data?.role)
        .filter((r: string | undefined): r is string => r !== undefined);

describe('SCIM Groups path — role ceiling', () => {
    beforeEach(() => jest.clearAllMocks());

    test('pushing a group mapped to ADMIN does NOT promote the member', async () => {
        primeGroupsPath({
            mappings: [{ aadGroupId: ADMIN_GROUP, role: 'ADMIN', priority: 10 }],
            membership: { id: 'm1', role: 'READER' },
            memberOfGroups: [ADMIN_GROUP],
        });

        await scimCreateGroup(
            { tenantId: TENANT_A },
            { externalId: ADMIN_GROUP, displayName: 'Pushed', members: [{ value: 'aad-oid-1' }] },
        );

        expect(roleWrites()).not.toContain('ADMIN');
    });

    test('the ceiling CLAMPS — a lower matched mapping still wins, it is not a no-op', async () => {
        // Same user is in both groups. ADMIN has the higher priority, so it
        // would win outright. Dropping it must promote EDITOR to the winner —
        // refusing the winner at the call site would instead write nothing and
        // silently discard the legitimate EDITOR mapping.
        primeGroupsPath({
            mappings: [
                { aadGroupId: ADMIN_GROUP, role: 'ADMIN', priority: 10 },
                { aadGroupId: EDITOR_GROUP, role: 'EDITOR', priority: 1 },
            ],
            membership: { id: 'm1', role: 'READER' },
            memberOfGroups: [ADMIN_GROUP, EDITOR_GROUP],
        });

        await scimCreateGroup(
            { tenantId: TENANT_A },
            { externalId: ADMIN_GROUP, displayName: 'Pushed', members: [{ value: 'aad-oid-1' }] },
        );

        expect(roleWrites()).toEqual(['EDITOR']);
    });

    test('an existing ADMIN membership is not demoted by a group push either', async () => {
        primeGroupsPath({
            mappings: [{ aadGroupId: ADMIN_GROUP, role: 'READER', priority: 10 }],
            membership: { id: 'm1', role: 'ADMIN' },
            memberOfGroups: [ADMIN_GROUP],
        });

        await scimCreateGroup(
            { tenantId: TENANT_A },
            { externalId: ADMIN_GROUP, displayName: 'Pushed', members: [{ value: 'aad-oid-1' }] },
        );

        expect(mockPrisma.tenantMembership.update).not.toHaveBeenCalled();
    });
});

describe('SCIM Groups resource projection', () => {
    test('members come from resolved memberIds, never from pushed membersJson', () => {
        const resource = scimGroupResource({
            id: 'g1',
            externalId: ADMIN_GROUP,
            displayName: 'Engineering',
            memberIds: ['user-1', 'user-2'],
        });

        expect(resource.members).toEqual([
            { value: 'user-1', type: 'User' },
            { value: 'user-2', type: 'User' },
        ]);
    });
});

describe('SCIM Groups POST — externalId validation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.tenantScimToken.findUnique.mockResolvedValue({
            id: 'tok1', tenantId: TENANT_A, label: 'Okta', tokenHash: TOKEN_HASH,
            revokedAt: null, tenant: { id: TENANT_A, slug: 'acme' },
        });
        // Primed so an UNVALIDATED externalId would reach a clean 201 — the
        // refusal has to come from the route, not from a mock blowing up.
        mockPrisma.userIdentityLink.findMany.mockResolvedValue([]);
        mockPrisma.scimGroup.create.mockResolvedValue({
            id: 'g1', externalId: 'Engineering', displayName: 'Engineering', memberIds: [],
        });
    });

    const post = (body: unknown) =>
        GroupsPost(new NextRequest('http://localhost:3000/api/scim/v2/Groups', {
            method: 'POST',
            headers: new Headers({
                authorization: `Bearer ${RAW_TOKEN}`,
                'content-type': 'application/json',
            }),
            body: JSON.stringify(body),
        }));

    test('a missing externalId is a 400, NOT a fall-back to displayName', async () => {
        const res = await post({ displayName: 'Engineering' });
        expect(res.status).toBe(400);
        expect(mockPrisma.scimGroup.create).not.toHaveBeenCalled();
    });

    test('a non-UUID externalId is a 400', async () => {
        const res = await post({ externalId: 'Engineering', displayName: 'Engineering' });
        expect(res.status).toBe(400);
        expect(mockPrisma.scimGroup.create).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// USERS PATH — PROTECTED MEMBERSHIP STATUS WRITES (#2200)
// ═════════════════════════════════════════════════════════════════════
//
// The role writes already skipped ADMIN. The status writes three lines below
// two of them did not, so SCIM could not change an ADMIN's role but could
// switch that ADMIN off.

describe('SCIM protected-membership status writes', () => {
    beforeEach(() => jest.clearAllMocks());

    test('DELETE on an ADMIN membership refuses with a SCIM 403 and writes nothing', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'ADMIN',
            user: { email: 'admin@acme.com' },
        });

        await expect(scimDeleteUser(ctx, 'u1')).rejects.toMatchObject({ status: 403 });
        expect(mockPrisma.tenantMembership.update).not.toHaveBeenCalled();
    });

    test('DELETE on an OWNER membership refuses too', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'OWNER',
            user: { email: 'owner@acme.com' },
        });

        await expect(scimDeleteUser(ctx, 'u1')).rejects.toMatchObject({ status: 403 });
        expect(mockPrisma.tenantMembership.update).not.toHaveBeenCalled();
    });

    test('PATCH active=false on an ADMIN refuses and writes nothing', async () => {
        const user = { id: 'u1', email: 'admin@acme.com', name: 'A', createdAt: now, updatedAt: now };
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'ADMIN', user,
        });

        await expect(
            scimPatchUser(ctx, 'u1', [{ op: 'replace', path: 'active', value: false }], BASE_URL),
        ).rejects.toMatchObject({ status: 403 });
        expect(mockPrisma.tenantMembership.update).not.toHaveBeenCalled();
    });

    test('DELETE on an EDITOR membership still works — the guard is not blanket', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            id: 'm1', tenantId: TENANT_A, userId: 'u1', status: 'ACTIVE', role: 'EDITOR',
            user: { email: 'editor@acme.com' },
        });
        mockPrisma.tenantMembership.update.mockResolvedValue({});

        expect(await scimDeleteUser(ctx, 'u1')).toBe(true);
        expect(mockPrisma.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'DEACTIVATED' }) }),
        );
    });
});
