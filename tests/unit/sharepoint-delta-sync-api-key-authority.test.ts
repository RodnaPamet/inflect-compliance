/**
 * A SharePoint "Sync now" started with an API KEY runs as the key and its
 * user, not as the user alone (#4386).
 *
 * The route is gated on `evidence.upload`, which for a key request is checked
 * against the key's scopes. It enqueued the sync with `actorUserId` only, and
 * the worker rebuilt that user's whole membership, so a sync started with an
 * `evidence:read` key re-imported evidence, and a key revoked while the sync
 * was queued still had it run.
 *
 * The route now hands the job the key's id, and the worker re-reads the key
 * through the tail a request runs (`resolveKeyInitiatorContext`, #4382). A
 * payload with no key id — a session click, every scheduled sync, and one
 * queued before the route carried the id — runs as the actor, as before.
 */
import { NextRequest } from 'next/server';

const prismaMock = {
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findFirst: jest.fn(), findUnique: jest.fn() },
    tenantApiKey: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const acquireSyncLock = jest.fn();
const releaseSyncLock = jest.fn();
jest.mock('@/app-layer/integrations/connection-lock', () => ({
    acquireSyncLock: (...a: unknown[]) => acquireSyncLock(...a),
    releaseSyncLock: (...a: unknown[]) => releaseSyncLock(...a),
}));

const runSharePointDeltaSync = jest.fn();
jest.mock('@/app-layer/integrations/providers/sharepoint/import', () => ({
    runSharePointDeltaSync: (...a: unknown[]) => runSharePointDeltaSync(...a),
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

// The AUTHZ_DENIED row an agent-bound key whose principal left writes.
const mockAppendAuditEntry = jest.fn(async (_entry: unknown) => undefined);
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (entry: unknown) => mockAppendAuditEntry(entry),
    appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain', auditId: 'a' })),
}));

// The route half.
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
const enqueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    __esModule: true,
    enqueue: (...a: unknown[]) => enqueueMock(...a),
}));

import { runSharePointDeltaSyncJob } from '@/app-layer/jobs/sharepoint-delta-sync';
import { POST } from '@/app/api/t/[tenantSlug]/integrations/sharepoint/sync/route';
import type { SharePointDeltaSyncPayload } from '@/app-layer/jobs/types';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';

/** A `TenantApiKey` row with its tenant, as the job's re-read loads it. */
function keyRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'key-1',
        tenantId: 'tenant-A',
        name: 'CI',
        keyPrefix: 'iflk_abcd',
        keyHash: 'h'.repeat(64),
        scopes: ['evidence:write'],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdById: 'actor-1',
        agentId: null,
        maxAutonomyLevel: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        tenant: { id: 'tenant-A', slug: 'acme', deletedAt: null },
        ...overrides,
    };
}

const SESSION_PAYLOAD: SharePointDeltaSyncPayload = {
    tenantId: 'tenant-A',
    connectionId: 'conn-1',
    actorUserId: 'actor-1',
    triggeredBy: 'manual',
};
const KEY_PAYLOAD: SharePointDeltaSyncPayload = { ...SESSION_PAYLOAD, apiKeyId: 'key-1' };

/** The context the sync usecase was handed. */
const syncCtx = (): RequestContext => runSharePointDeltaSync.mock.calls[0][0] as RequestContext;

beforeEach(() => {
    jest.clearAllMocks();
    acquireSyncLock.mockResolvedValue('token-1');
    releaseSyncLock.mockResolvedValue(undefined);
    runSharePointDeltaSync.mockResolvedValue({ drivesSynced: 1, reimported: 2, staled: 0 });
    prismaMock.tenantApiKey.update.mockResolvedValue({});
    // The actor is an OWNER, so every refusal below is the KEY's: the user
    // alone may run the sync.
    prismaMock.tenantMembership.findFirst.mockResolvedValue({ role: 'OWNER', customRole: null });
    prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow());
});

describe('the key bounds the sync: a key that cannot upload evidence is refused', () => {
    it('refuses an evidence:read key before taking the lock or reaching SharePoint', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['evidence:read'] }));

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(
            'sharepoint-delta-sync: actor with API key key-1 lacks evidence.upload on tenant tenant-A',
        );
        expect(acquireSyncLock).not.toHaveBeenCalled();
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });

    it('hands the sync the key ∧ actor context, so a re-import cannot link a control the key may not edit', async () => {
        await runSharePointDeltaSyncJob(KEY_PAYLOAD);

        const ctx = syncCtx();
        expect(ctx.appPermissions.evidence.upload).toBe(true);
        // The OWNER may edit controls; the evidence-only key may not.
        expect(ctx.appPermissions.controls.edit).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
    });
});

describe('a key that no longer authorises a request no longer runs its queued sync', () => {
    it.each([
        ['revoked', keyRow({ revokedAt: new Date('2026-10-01') })],
        ['expired', keyRow({ expiresAt: new Date('2020-01-01') })],
        ['not_found', null],
        ['tenant_deleted', keyRow({ tenant: { id: 'tenant-A', slug: 'acme', deletedAt: new Date('2026-10-01') } })],
        ['other_tenant', keyRow({ tenantId: 'tenant-B', tenant: { id: 'tenant-B', slug: 'other', deletedAt: null } })],
        ['other_user', keyRow({ createdById: 'someone-else' })],
    ])('refused as %s: by name, before the lock', async (reason, row) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(row);

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(
            `sharepoint-delta-sync: API key key-1 that started this sync is refused (${reason}) on tenant tenant-A`,
        );
        expect(prismaMock.tenantApiKey.findUnique).toHaveBeenCalledWith({
            where: { id: 'key-1' },
            include: { tenant: true },
        });
        expect(acquireSyncLock).not.toHaveBeenCalled();
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
        // The key is refused before the membership is asked.
        expect(prismaMock.tenantMembership.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a key whose user has no ACTIVE membership, by name', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(
            'sharepoint-delta-sync: API key key-1 that started this sync is refused (initiator_not_a_member) on tenant tenant-A',
        );
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });

    it('an agent-bound key whose principal left: refused by name, with the denial a request writes', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ agentId: 'agent-1' }));
        prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-A', slug: 'acme', deletedAt: null });
        prismaMock.tenantMembership.findUnique.mockResolvedValue(null);

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(/refused \(principal_unresolved\)/);
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'AUTHZ_DENIED', entityId: 'key-1' }),
        );
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });
});

describe('a key with evidence:write runs the sync', () => {
    it('as the key and its user, the lower role, and does not stamp the key as used', async () => {
        const r = await runSharePointDeltaSyncJob(KEY_PAYLOAD);

        expect(r).toEqual({ drivesSynced: 1, reimported: 2, staled: 0 });
        expect(runSharePointDeltaSync).toHaveBeenCalledWith(expect.anything(), 'conn-1');
        expect(syncCtx()).toMatchObject({
            requestId: 'sharepoint-delta-sync-tenant-A',
            userId: 'actor-1',
            tenantId: 'tenant-A',
            role: 'EDITOR',
            apiKeyId: 'key-1',
            apiKeyScopes: ['evidence:write'],
        });
        expect(prismaMock.tenantApiKey.update).not.toHaveBeenCalled();
        expect(releaseSyncLock).toHaveBeenCalledWith(expect.anything(), 'conn-1', 'token-1');
    });
});

describe('a sync with no key id runs as its actor, as before', () => {
    it('a session "Sync now" never reads a key and runs with the actor\'s whole authority', async () => {
        await runSharePointDeltaSyncJob(SESSION_PAYLOAD);

        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(syncCtx()).toEqual({
            requestId: 'sharepoint-delta-sync-tenant-A',
            userId: 'actor-1',
            tenantId: 'tenant-A',
            role: 'OWNER',
            permissions: computePermissions('OWNER'),
            appPermissions: getPermissionsForRole('OWNER'),
        });
    });

    it('a scheduled sync, and a payload queued before the route carried the key id, run as the actor', async () => {
        // Exactly the shape the dispatcher and the route enqueued before #4386,
        // as it comes back out of the queue: no `apiKeyId` member at all.
        const queuedBefore = JSON.parse(
            JSON.stringify({ ...SESSION_PAYLOAD, triggeredBy: 'scheduled' }),
        ) as SharePointDeltaSyncPayload;

        await runSharePointDeltaSyncJob(queuedBefore);

        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(syncCtx()).toMatchObject({ userId: 'actor-1', role: 'OWNER' });
        expect(syncCtx()).not.toHaveProperty('apiKeyId');
    });

    it('the session refusals are unchanged', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);
        await expect(runSharePointDeltaSyncJob(SESSION_PAYLOAD)).rejects.toThrow(
            'sharepoint-delta-sync: user actor-1 is not an active member of tenant tenant-A',
        );

        prismaMock.tenantMembership.findFirst.mockResolvedValue({
            role: 'READER',
            customRole: null,
        });
        await expect(runSharePointDeltaSyncJob(SESSION_PAYLOAD)).rejects.toThrow(
            'sharepoint-delta-sync: actor lacks evidence.upload on tenant tenant-A',
        );
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
    });
});

describe('POST …/integrations/sharepoint/sync — the key a request was made with reaches the job', () => {
    const baseCtx = {
        tenantId: 'tenant-A',
        userId: 'actor-1',
        role: 'EDITOR',
        requestId: 'req-1',
        permissions: computePermissions('EDITOR'),
        appPermissions: getPermissionsForRole('EDITOR'),
    };
    const sync = () =>
        POST(
            new NextRequest('https://x.test/api/t/acme/integrations/sharepoint/sync', {
                method: 'POST',
                body: JSON.stringify({ connectionId: 'conn-1' }),
            }),
            { params: Promise.resolve({ tenantSlug: 'acme' }) },
        );
    const enqueuedPayload = (): Record<string, unknown> => {
        const call = enqueueMock.mock.calls.find(([name]) => name === 'sharepoint-delta-sync');
        if (!call) throw new Error('sharepoint-delta-sync was never enqueued');
        return call[1] as Record<string, unknown>;
    };

    beforeEach(() => enqueueMock.mockResolvedValue({ id: 'job-1' }));

    it('carries the key id of a key-authenticated request, so the worker acts as the key', async () => {
        getTenantCtxMock.mockResolvedValue({ ...baseCtx, apiKeyId: 'key-1', apiKeyScopes: ['evidence:write'] });

        const res = await sync();

        expect(res.status).toBe(202);
        expect(enqueuedPayload()).toMatchObject({ actorUserId: 'actor-1', apiKeyId: 'key-1', triggeredBy: 'manual' });
    });

    it('carries no key id for a session request, so the payload is the one it always was', async () => {
        getTenantCtxMock.mockResolvedValue(baseCtx);

        await sync();

        expect(enqueuedPayload()).toEqual({
            tenantId: 'tenant-A',
            connectionId: 'conn-1',
            actorUserId: 'actor-1',
            triggeredBy: 'manual',
            requestId: 'req-1',
        });
    });
});
