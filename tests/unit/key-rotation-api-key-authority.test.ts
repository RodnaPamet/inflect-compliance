/**
 * A key rotation started with an API KEY stops if the key no longer
 * authorises the route by the time the worker runs it (#4386).
 *
 * `POST …/admin/key-rotation` accepts an `admin:write` key. The job runs as a
 * system job and does only what was asked, but it enqueued no trace of the
 * key, so a key revoked or expired while the rotation was queued still had it
 * run. The route now hands the job the key's id, and the job re-reads the key
 * (`resolveKeyInitiatorContext`, #4382) and asks the route's `admin.manage` of
 * the key ∧ its user before it writes the started row or touches any key
 * material. A rotation with no key id runs exactly as before.
 */
import { strictMock } from '../helpers/strict-mock';

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

const appendAuditEntryMock = jest.fn(async (_entry: { action: string }) => undefined);
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: (entry: { action: string }) => appendAuditEntryMock(entry),
}));
// The AUTHZ_DENIED row an agent-bound key whose principal left writes.
const mockAppendAuditEntry = jest.fn(async (_entry: unknown) => undefined);
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (entry: unknown) => mockAppendAuditEntry(entry),
    }),
);

jest.mock('@/lib/security/tenant-key-manager', () => ({ clearTenantDekCache: jest.fn() }));

const prismaMock = {
    tenant: { findUnique: jest.fn(), update: jest.fn() },
    tenantMembership: { findFirst: jest.fn(), findUnique: jest.fn() },
    tenantApiKey: { findUnique: jest.fn(), update: jest.fn() },
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

import { runKeyRotation, _resetKeyRotationForTests } from '@/app-layer/jobs/key-rotation';

function keyRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'key-1',
        tenantId: 'tenant-A',
        name: 'ops',
        keyPrefix: 'iflk_abcd',
        keyHash: 'h'.repeat(64),
        scopes: ['admin:write'],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdById: 'admin-1',
        agentId: null,
        maxAutonomyLevel: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        tenant: { id: 'tenant-A', slug: 'acme', deletedAt: null },
        ...overrides,
    };
}

const SESSION_OPTIONS = { tenantId: 'tenant-A', initiatedByUserId: 'admin-1', requestId: 'req-1' };
const KEY_OPTIONS = { ...SESSION_OPTIONS, apiKeyId: 'key-1' };

/** Did the rotation start: the started row, then the DEK read? */
function rotationStarted(): boolean {
    return appendAuditEntryMock.mock.calls.some(([e]) => e.action === 'KEY_ROTATION_STARTED');
}

beforeEach(() => {
    jest.clearAllMocks();
    _resetKeyRotationForTests();
    // A tenant with no DEK and nothing in v1: the rotation itself is a no-op
    // walk, so each test is about whether it STARTED.
    prismaMock.tenant.findUnique.mockImplementation(async (args: { select?: unknown }) =>
        args.select ? { encryptedDek: null } : { id: 'tenant-A', slug: 'acme', deletedAt: null },
    );
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow());
    prismaMock.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });
});

describe('a key that no longer authorises the route stops the rotation, by name', () => {
    it.each([
        ['revoked', keyRow({ revokedAt: new Date('2026-10-01') })],
        ['expired', keyRow({ expiresAt: new Date('2020-01-01') })],
        ['not_found', null],
        ['tenant_deleted', keyRow({ tenant: { id: 'tenant-A', slug: 'acme', deletedAt: new Date('2026-10-01') } })],
        ['other_tenant', keyRow({ tenantId: 'tenant-B', tenant: { id: 'tenant-B', slug: 'other', deletedAt: null } })],
        ['other_user', keyRow({ createdById: 'someone-else' })],
    ])('%s: before the started row or any key material', async (reason, row) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(row);

        await expect(runKeyRotation(KEY_OPTIONS)).rejects.toThrow(
            `key-rotation: API key key-1 that started this rotation is refused (${reason}) on tenant tenant-A`,
        );
        expect(rotationStarted()).toBe(false);
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(prismaMock.tenant.update).not.toHaveBeenCalled();
        expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('a key whose user is no longer a member', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runKeyRotation(KEY_OPTIONS)).rejects.toThrow(/refused \(initiator_not_a_member\)/);
        expect(rotationStarted()).toBe(false);
    });

    it('an agent-bound key whose principal left, with the denial a request writes', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ agentId: 'agent-1' }));
        prismaMock.tenantMembership.findUnique.mockResolvedValue(null);

        await expect(runKeyRotation(KEY_OPTIONS)).rejects.toThrow(/refused \(principal_unresolved\)/);
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTHZ_DENIED' }));
        expect(rotationStarted()).toBe(false);
    });
});

describe('the route\'s permission is asked again of the key and its user', () => {
    it('a key without admin:write is refused', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['evidence:write'] }));

        await expect(runKeyRotation(KEY_OPTIONS)).rejects.toThrow(
            'key-rotation: user admin-1 with API key key-1 lacks admin.manage on tenant tenant-A',
        );
        expect(rotationStarted()).toBe(false);
    });

    it('an admin:write key whose user no longer holds admin.manage is refused', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });

        await expect(runKeyRotation(KEY_OPTIONS)).rejects.toThrow(/lacks admin\.manage/);
        expect(rotationStarted()).toBe(false);
    });
});

describe('a key that still authorises the route runs the rotation as before', () => {
    it.each([['admin:write'], ['*']])('a key scoped %s, of an ADMIN', async (scope) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: [scope] }));

        const r = await runKeyRotation(KEY_OPTIONS);

        expect(r.tenantId).toBe('tenant-A');
        expect(appendAuditEntryMock.mock.calls.map(([e]) => e.action)).toEqual([
            'KEY_ROTATION_STARTED',
            'KEY_ROTATION_COMPLETED',
        ]);
        // Still a system job, attributed to its initiator, as before.
        expect(appendAuditEntryMock.mock.calls[0][0]).toMatchObject({ userId: 'admin-1', actorType: 'SYSTEM' });
        // The job's re-read of the key is not a use of it.
        expect(prismaMock.tenantApiKey.update).not.toHaveBeenCalled();
    });
});

describe('a rotation with no key id is not asked anything', () => {
    it('a session-started rotation never reads a key or a membership', async () => {
        await runKeyRotation(SESSION_OPTIONS);

        expect(rotationStarted()).toBe(true);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(prismaMock.tenantMembership.findFirst).not.toHaveBeenCalled();
    });

    it('a payload queued before the route carried the key id runs as before', async () => {
        // The registry hands the job `apiKeyId: payload.apiKeyId`, which is
        // undefined for a payload with no such member.
        const queuedBefore = JSON.parse(JSON.stringify(SESSION_OPTIONS));
        await runKeyRotation({ ...queuedBefore, apiKeyId: queuedBefore.apiKeyId });

        expect(rotationStarted()).toBe(true);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
    });
});
