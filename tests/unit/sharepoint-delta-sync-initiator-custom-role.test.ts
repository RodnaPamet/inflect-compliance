/**
 * The SharePoint delta sync runs with its actor's CUSTOM role (#4362).
 *
 * `runSharePointDeltaSyncJob` built its context from
 * `getPermissionsForRole(membership.role)`, so a custom role that withheld
 * `evidence.upload` was ignored by a sync it had queued with "Sync now" (and by
 * the scheduled one the dispatcher queued in its name), and re-imported
 * evidence with the built-in role's full set. It now gates on the key the
 * route's `requirePermission('evidence.upload')` names, read from the custom
 * role, and hands the sync that same context.
 */
const prismaMock = {
    tenantMembership: { findFirst: jest.fn() },
    // The job re-reads the key it was started with (#4386).
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

import { runSharePointDeltaSyncJob } from '@/app-layer/jobs/sharepoint-delta-sync';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';

const EDITOR = getPermissionsForRole('EDITOR');
const READER = getPermissionsForRole('READER');

const PAYLOAD = {
    tenantId: 'tenant-A',
    connectionId: 'conn-1',
    actorUserId: 'actor-1',
    triggeredBy: 'manual' as const,
};

/** The context the sync usecase was handed. */
const syncCtx = (): RequestContext => runSharePointDeltaSync.mock.calls[0][0] as RequestContext;

beforeEach(() => {
    jest.clearAllMocks();
    acquireSyncLock.mockResolvedValue('token-1');
    releaseSyncLock.mockResolvedValue(undefined);
    runSharePointDeltaSync.mockResolvedValue({ drivesSynced: 1, reimported: 2, staled: 0 });
});

describe('a custom role that withholds evidence.upload stops the sync', () => {
    it('refuses before taking the lock or reaching SharePoint', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue({
            role: 'EDITOR',
            customRole: { baseRole: 'EDITOR', permissionsJson: { evidence: { ...EDITOR.evidence, upload: false } } },
        });

        await expect(runSharePointDeltaSyncJob(PAYLOAD)).rejects.toThrow(
            'sharepoint-delta-sync: actor lacks evidence.upload on tenant tenant-A',
        );
        expect(acquireSyncLock).not.toHaveBeenCalled();
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });

    it('applies a soft-deleted custom role still linked to the membership, as a request does', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue({
            role: 'ADMIN',
            customRole: {
                baseRole: 'EDITOR',
                isActive: false,
                permissionsJson: { evidence: { ...EDITOR.evidence, upload: false } },
            },
        });

        await expect(runSharePointDeltaSyncJob(PAYLOAD)).rejects.toThrow(/lacks evidence\.upload/);
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });
});

describe('a custom role that grants evidence.upload over a READER base may sync, as the route lets it', () => {
    it('runs the sync with the custom role as its context', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue({
            role: 'READER',
            customRole: { baseRole: 'READER', permissionsJson: { evidence: { ...READER.evidence, upload: true } } },
        });

        await runSharePointDeltaSyncJob(PAYLOAD);

        expect(runSharePointDeltaSync).toHaveBeenCalledWith(expect.anything(), 'conn-1');
        expect(syncCtx().appPermissions.evidence.upload).toBe(true);
        // The coarse tier is still the base role's, as a request's is.
        expect(syncCtx().role).toBe('READER');
        expect(syncCtx().permissions.canWrite).toBe(false);
    });
});

describe('a built-in EDITOR syncs, with the context a request from it gets', () => {
    it('runs the sync with the EDITOR context', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });

        const r = await runSharePointDeltaSyncJob(PAYLOAD);

        expect(r).toEqual({ drivesSynced: 1, reimported: 2, staled: 0 });
        expect(syncCtx()).toEqual({
            requestId: 'sharepoint-delta-sync-tenant-A',
            userId: 'actor-1',
            tenantId: 'tenant-A',
            role: 'EDITOR',
            // A request's coarse flags (owner decision, 2026-10-26).
            permissions: computePermissions('EDITOR'),
            appPermissions: EDITOR,
        });
        expect(releaseSyncLock).toHaveBeenCalledWith(expect.anything(), 'conn-1', 'token-1');
    });
});

describe('the membership refusal is unchanged', () => {
    it('refuses an actor with no ACTIVE membership', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runSharePointDeltaSyncJob(PAYLOAD)).rejects.toThrow(
            'sharepoint-delta-sync: user actor-1 is not an active member of tenant tenant-A',
        );
        expect(prismaMock.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'actor-1', tenantId: 'tenant-A', status: 'ACTIVE' } }),
        );
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });
});

/**
 * A sync started with an API KEY runs as the key AND its user (#4386).
 *
 * The "Sync now" route checks the key — its scopes, its tenant, its liveness —
 * and then queued a job that rebuilt the USER'S whole membership. So a key
 * holding `evidence:read` and nothing else had the sync re-import evidence
 * because its creator could, and a key revoked while the job sat in the queue
 * did not stop it. The worker now re-reads the key by id and holds the
 * conjunction, which is the shape #4382 settled for the evidence import.
 */
describe('a sync started with an API key runs as the key and its user', () => {
    const KEY_PAYLOAD = { ...PAYLOAD, apiKeyId: 'key-1' };

    /** A live key belonging to the payload's actor. */
    const key = (scopes: string[], over: Record<string, unknown> = {}) => ({
        id: 'key-1',
        tenantId: 'tenant-A',
        createdById: 'actor-1',
        scopes,
        revokedAt: null,
        expiresAt: null,
        agentId: null,
        maxAutonomyLevel: null,
        tenant: { slug: 'acme', deletedAt: null },
        ...over,
    });

    beforeEach(() => {
        // A member who may upload on their own account, so every refusal below
        // is the KEY's doing and not the membership's.
        prismaMock.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });
    });

    it('runs when the key carries evidence:write, and the context says which key', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(key(['evidence:write']));

        await runSharePointDeltaSyncJob(KEY_PAYLOAD);

        expect(runSharePointDeltaSync).toHaveBeenCalledWith(expect.anything(), 'conn-1');
        expect(syncCtx().apiKeyId).toBe('key-1');
        expect(syncCtx().apiKeyScopes).toEqual(['evidence:write']);
    });

    it('REFUSES a key without evidence:write, though its user may upload', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(key(['evidence:read']));

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(/lacks evidence\.upload/);
        expect(acquireSyncLock).not.toHaveBeenCalled();
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });

    it('stops a key revoked while the job sat in the queue, and names the reason', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(key(['evidence:write'], { revokedAt: new Date() }));

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(
            /API key key-1 that started this sync is refused \(revoked\)/,
        );
        expect(runSharePointDeltaSync).not.toHaveBeenCalled();
    });

    it('stops an EXPIRED key the same way', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(
            key(['evidence:write'], { expiresAt: new Date(Date.now() - 60_000) }),
        );

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(/refused \(expired\)/);
    });

    it('refuses a key belonging to somebody other than the actor the payload names', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(key(['evidence:write'], { createdById: 'someone-else' }));

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(/refused \(other_user\)/);
    });

    it('refuses a key belonging to another tenant', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(key(['evidence:write'], { tenantId: 'tenant-B' }));

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(/refused \(other_tenant\)/);
    });

    it('narrows to the MEMBER when the key is the wider of the two', async () => {
        // A `*` key, a member who may not upload: the conjunction refuses.
        prismaMock.tenantMembership.findFirst.mockResolvedValue({
            role: 'EDITOR',
            customRole: { baseRole: 'EDITOR', permissionsJson: { evidence: { ...EDITOR.evidence, upload: false } } },
        });
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(key(['*']));

        await expect(runSharePointDeltaSyncJob(KEY_PAYLOAD)).rejects.toThrow(/lacks evidence\.upload/);
    });

    it('leaves a payload with NO key id running as the member, as before', async () => {
        await runSharePointDeltaSyncJob(PAYLOAD);

        expect(runSharePointDeltaSync).toHaveBeenCalled();
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(syncCtx()).not.toHaveProperty('apiKeyId');
    });

    it('does not read the key for a SCHEDULED run, which carries none', async () => {
        await runSharePointDeltaSyncJob({ ...PAYLOAD, triggeredBy: 'scheduled' as const });

        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
    });
});
