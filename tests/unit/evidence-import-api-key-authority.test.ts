/**
 * A ZIP evidence import started with an API KEY runs as the key and its user,
 * not as the user alone (#4369).
 *
 * The request is checked against the key's scopes. The worker used to rebuild
 * its context from `initiatedByUserId`'s membership only, so the import did
 * whatever the USER may — linking every record to a default control under the
 * user's `controls.edit` whatever the key carried — and a key revoked while the
 * job was queued still had the job run.
 *
 * The route now hands the job the key's id, and the worker re-reads the key
 * through the tail a request runs (`resolveApiKeyForJob`) and intersects it
 * with the initiator's membership (`resolveKeyInitiatorContext`). A payload
 * with no key id runs as the user, exactly as before.
 *
 * Driven through `runEvidenceImport` with the REAL `uploadEvidenceFile`, so each
 * refusal below is the usecase's own policy check reading the job's context.
 * Only the key row and the membership row vary.
 */
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { strictMock } from '../helpers/strict-mock';

const prismaMock = {
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findFirst: jest.fn(), findUnique: jest.fn() },
    tenantApiKey: { findUnique: jest.fn(), update: jest.fn() },
    evidence: { updateMany: jest.fn() },
    fileRecord: { delete: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: (_name: string, fn: () => unknown) => fn(),
}));

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        createControlLinks: jest.fn(),
        filterExistingControlIds: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: { findBySha256: jest.fn(), createPending: jest.fn(), markStored: jest.fn() },
}));

jest.mock('@/app-layer/services/file-scan', () => ({ scanUploadOrRefuse: jest.fn() }));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(),
    buildTenantObjectKey: jest.fn(
        (tenantId: string, domain: string, name: string) => `${tenantId}/${domain}/${name}`,
    ),
    assertTenantKey: jest.fn(),
    isAllowedMime: jest.fn(() => true),
    isAllowedSize: jest.fn(() => true),
    FILE_MAX_SIZE_BYTES: 100 * 1024 * 1024,
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(),
    bumpEntityCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));

// `appendAuditEntryOrQueue`: the AUTHZ_DENIED row `assertPermission` writes for
// a refused control link. `appendAuditEntry`: the one an agent-bound key whose
// principal no longer resolves writes (`auditPrincipalUnresolved`).
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
const mockAppendAuditEntry = jest.fn(async (_entry: unknown) => undefined);
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
        appendAuditEntry: (entry: unknown) => mockAppendAuditEntry(entry),
    }),
);

import { runEvidenceImport } from '@/app-layer/jobs/evidence-import';
import { runInTenantContext } from '@/lib/db-context';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { scanUploadOrRefuse } from '@/app-layer/services/file-scan';
import { getStorageProvider } from '@/lib/storage';
import { getPermissionsForRole } from '@/lib/permissions';
import type { EvidenceImportPayload } from '@/app-layer/jobs/types';

const repo = EvidenceRepository as unknown as Record<string, jest.Mock>;
const files = FileRepository as unknown as Record<string, jest.Mock>;

const EDITOR = getPermissionsForRole('EDITOR');

/** A membership row as `resolveInitiatorContext` selects it. */
const builtIn = (role: string) => ({ role, customRole: null });

/** A `TenantApiKey` row with its tenant, as the job's re-read loads it. */
function keyRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'key-1',
        tenantId: 'tenant-A',
        name: 'CI',
        keyPrefix: 'iflk_abcd',
        keyHash: 'h'.repeat(64),
        scopes: ['evidence:write', 'controls:write'],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdById: 'initiator-1',
        agentId: null,
        maxAutonomyLevel: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        tenant: { id: 'tenant-A', slug: 'acme', deletedAt: null },
        ...overrides,
    };
}

const SESSION_PAYLOAD: EvidenceImportPayload = {
    tenantId: 'tenant-A',
    initiatedByUserId: 'initiator-1',
    stagingPathKey: 'tenant-A/temp/bundle.zip',
    stagingFileRecordId: 'staging-1',
    controlId: null,
    retentionUntilIso: null,
    category: null,
    folder: null,
    requestId: 'req-1',
};
const KEY_PAYLOAD: EvidenceImportPayload = { ...SESSION_PAYLOAD, apiKeyId: 'key-1' };

const storage = { name: 'local', readStream: jest.fn(), write: jest.fn(), delete: jest.fn() };
let archive: Buffer;

beforeAll(async () => {
    const zip = new JSZip();
    zip.file('policy.pdf', 'first');
    zip.file('evidence/screenshot.png', 'second');
    archive = await zip.generateAsync({ type: 'nodebuffer' });
});

beforeEach(() => {
    jest.clearAllMocks();
    const db = { fileRecord: { updateMany: jest.fn() } };
    (runInTenantContext as jest.Mock).mockImplementation(async (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db));
    storage.readStream.mockImplementation(() => Readable.from([archive]));
    storage.write.mockResolvedValue({ sha256: 'a'.repeat(64), sizeBytes: 5 });
    storage.delete.mockResolvedValue(undefined);
    (getStorageProvider as jest.Mock).mockReturnValue(storage);
    (scanUploadOrRefuse as jest.Mock).mockResolvedValue(null);
    files.findBySha256.mockResolvedValue(null);
    files.createPending.mockResolvedValue({ id: 'fr-1' });
    files.markStored.mockResolvedValue(undefined);
    let n = 0;
    repo.create.mockImplementation(async () => ({ id: `ev-${++n}`, title: 'x' }));
    repo.createControlLinks.mockResolvedValue(undefined);
    repo.filterExistingControlIds.mockImplementation(async (_d: unknown, _c: unknown, ids: string[]) => new Set(ids));
    prismaMock.fileRecord.delete.mockResolvedValue(undefined);
    prismaMock.tenantApiKey.update.mockResolvedValue({});
    // The initiator is an OWNER, so every refusal below is the KEY's: the
    // user alone may do all of it.
    prismaMock.tenantMembership.findFirst.mockResolvedValue(builtIn('OWNER'));
    prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow());
});

/** The context the import's first upload ran under. */
function contextOfFirstWrite(): Record<string, unknown> {
    const call = repo.create.mock.calls[0];
    if (!call) throw new Error('no evidence was created');
    return call[1] as Record<string, unknown>;
}

describe('the key bounds the job: a scope the key lacks is refused, whatever the user holds', () => {
    it('refuses an import whose key cannot upload evidence, before the archive is read', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['evidence:read'] }));

        await expect(runEvidenceImport(KEY_PAYLOAD)).rejects.toThrow(
            'evidence-import: user initiator-1 with API key key-1 lacks evidence.upload permission on tenant tenant-A',
        );
        expect(storage.readStream).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses every entry its default-control link when the key lacks controls:write, and records the denial', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['evidence:write'] }));

        const result = await runEvidenceImport({ ...KEY_PAYLOAD, controlId: 'ctrl-1' });

        expect(result.extracted).toBe(0);
        expect(result.errored).toBe(2);
        expect(result.firstError).toMatch(/link evidence to controls/);
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.createControlLinks).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'initiator-1',
            detailsJson: expect.objectContaining({ permissionKeys: ['controls.edit'] }),
        });
    });

    it('lets the same key import with no default control', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['evidence:write'] }));

        const result = await runEvidenceImport(KEY_PAYLOAD);

        expect(result.extracted).toBe(2);
        expect(result.errored).toBe(0);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});

describe('the user bounds the job too: a key never carries its import past its user', () => {
    it('refuses a `*` key whose user is a custom role that withholds evidence.upload', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['*'] }));
        prismaMock.tenantMembership.findFirst.mockResolvedValue({
            role: 'EDITOR',
            customRole: { baseRole: 'EDITOR', permissionsJson: { evidence: { ...EDITOR.evidence, upload: false } } },
        });

        await expect(runEvidenceImport(KEY_PAYLOAD)).rejects.toThrow(/with API key key-1 lacks evidence\.upload/);
        expect(storage.readStream).not.toHaveBeenCalled();
    });

    it('refuses a key whose user has no ACTIVE membership, by name', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runEvidenceImport(KEY_PAYLOAD)).rejects.toThrow(
            'evidence-import: API key key-1 that started this import is refused (initiator_not_a_member) on tenant tenant-A',
        );
        expect(storage.readStream).not.toHaveBeenCalled();
    });
});

describe('a key that no longer authorises a request no longer runs its queued import', () => {
    it.each([
        ['revoked', keyRow({ revokedAt: new Date('2026-10-01') })],
        ['expired', keyRow({ expiresAt: new Date('2020-01-01') })],
        ['not_found', null],
        ['tenant_deleted', keyRow({ tenant: { id: 'tenant-A', slug: 'acme', deletedAt: new Date('2026-10-01') } })],
        ['other_tenant', keyRow({ tenantId: 'tenant-B', tenant: { id: 'tenant-B', slug: 'other', deletedAt: null } })],
        ['other_user', keyRow({ createdById: 'someone-else' })],
    ])('refused as %s: by name, nothing read, nothing written', async (reason, row) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(row);

        await expect(runEvidenceImport(KEY_PAYLOAD)).rejects.toThrow(
            `evidence-import: API key key-1 that started this import is refused (${reason}) on tenant tenant-A`,
        );
        expect(prismaMock.tenantApiKey.findUnique).toHaveBeenCalledWith({
            where: { id: 'key-1' },
            include: { tenant: true },
        });
        expect(storage.readStream).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
        // The key is refused before the membership is asked.
        expect(prismaMock.tenantMembership.findFirst).not.toHaveBeenCalled();
    });

    it('an agent-bound key whose principal left: refused by name, with the denial a request writes', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ agentId: 'agent-1' }));
        prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-A', slug: 'acme', deletedAt: null });
        prismaMock.tenantMembership.findUnique.mockResolvedValue(null);

        await expect(runEvidenceImport(KEY_PAYLOAD)).rejects.toThrow(/refused \(principal_unresolved\)/);
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'AUTHZ_DENIED',
                entityId: 'key-1',
                detailsJson: expect.objectContaining({ gate: 'agent_principal', agentId: 'agent-1' }),
            }),
        );
        expect(storage.readStream).not.toHaveBeenCalled();
    });

    it('a key of another tenant is refused before its agent principal is resolved there', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(
            keyRow({ tenantId: 'tenant-B', agentId: 'agent-1', tenant: { id: 'tenant-B', slug: 'other', deletedAt: null } }),
        );

        await expect(runEvidenceImport(KEY_PAYLOAD)).rejects.toThrow(/refused \(other_tenant\)/);
        expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });
});

describe('a key with the scopes the import needs runs it', () => {
    it('imports every entry into the default control, as the key, and does not stamp the key as used', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(builtIn('EDITOR'));

        const result = await runEvidenceImport({ ...KEY_PAYLOAD, controlId: 'ctrl-1' });

        expect(result.extracted).toBe(2);
        expect(result.errored).toBe(0);
        expect(repo.createControlLinks).toHaveBeenCalledTimes(2);
        expect(contextOfFirstWrite()).toMatchObject({
            requestId: 'req-1',
            userId: 'initiator-1',
            tenantId: 'tenant-A',
            role: 'EDITOR',
            apiKeyId: 'key-1',
            apiKeyScopes: ['evidence:write', 'controls:write'],
        });
        // The request stamped the key's last use; the job's re-read is not one.
        expect(prismaMock.tenantApiKey.update).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('takes the lower of the two roles: an OWNER\'s evidence-and-controls key runs as an EDITOR', async () => {
        const result = await runEvidenceImport({ ...KEY_PAYLOAD, controlId: 'ctrl-1' });

        expect(result.extracted).toBe(2);
        const ctx = contextOfFirstWrite() as { role: string; permissions: { canAdmin: boolean }; appPermissions: { admin: { manage: boolean } } };
        expect(ctx.role).toBe('EDITOR');
        expect(ctx.permissions.canAdmin).toBe(false);
        expect(ctx.appPermissions.admin.manage).toBe(false);
    });
});

describe('an import with no key id runs as its user, as before', () => {
    it('a session-started import never reads a key and runs with the user\'s whole authority', async () => {
        const result = await runEvidenceImport({ ...SESSION_PAYLOAD, controlId: 'ctrl-1' });

        expect(result.extracted).toBe(2);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        const ctx = contextOfFirstWrite();
        expect(ctx).toMatchObject({ requestId: 'req-1', userId: 'initiator-1', tenantId: 'tenant-A', role: 'OWNER' });
        expect(ctx).not.toHaveProperty('apiKeyId');
        expect(ctx).not.toHaveProperty('apiKeyScopes');
    });

    it('a payload queued before the route carried the key id runs as its user', async () => {
        // Exactly the shape the route enqueued before #4369, as it comes back
        // out of the queue: no `apiKeyId` member at all.
        const queuedBefore = JSON.parse(
            JSON.stringify({
                tenantId: 'tenant-A',
                initiatedByUserId: 'initiator-1',
                stagingPathKey: 'tenant-A/temp/bundle.zip',
                stagingFileRecordId: 'staging-1',
                controlId: 'ctrl-1',
                retentionUntilIso: null,
                category: null,
                folder: null,
                requestId: 'req-1',
            }),
        ) as EvidenceImportPayload;

        const result = await runEvidenceImport(queuedBefore);

        expect(result.extracted).toBe(2);
        expect(result.errored).toBe(0);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(contextOfFirstWrite()).toMatchObject({ userId: 'initiator-1', role: 'OWNER' });
    });

    it('the session refusal is unchanged', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runEvidenceImport(SESSION_PAYLOAD)).rejects.toThrow(
            'evidence-import: user initiator-1 is not an active member of tenant tenant-A',
        );
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
    });
});
