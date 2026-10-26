/**
 * The ZIP evidence import runs with its initiator's CUSTOM role (#4362).
 *
 * The worker built its context from `getPermissionsForRole(membership.role)`,
 * so a custom role that withheld `evidence.upload` or `controls.edit` was
 * ignored by the import it had queued: a role narrowed while the job sat in the
 * queue, or any path that enqueued without the route's check, imported with the
 * built-in role's full set. The context now follows the request's rule
 * (`resolveInitiatorContext`, `initiatorAuthority`).
 *
 * Driven through `runEvidenceImport` with the REAL `uploadEvidenceFile`, so the
 * refusals below are the usecase's own policy checks reading the job's context,
 * not a stand-in for them. The membership row is the only thing that varies.
 */
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { strictMock } from '../helpers/strict-mock';

const prismaMock = {
    tenantMembership: { findFirst: jest.fn() },
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

// The AUTHZ_DENIED row `assertPermission` writes for a refused control link.
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

import { runEvidenceImport } from '@/app-layer/jobs/evidence-import';
import { runInTenantContext } from '@/lib/db-context';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { scanUploadOrRefuse } from '@/app-layer/services/file-scan';
import { getStorageProvider } from '@/lib/storage';
import { getPermissionsForRole } from '@/lib/permissions';

const repo = EvidenceRepository as unknown as Record<string, jest.Mock>;
const files = FileRepository as unknown as Record<string, jest.Mock>;

const EDITOR = getPermissionsForRole('EDITOR');

/** A membership row as `resolveInitiatorContext` selects it. */
const builtIn = (role: string) => ({ role, customRole: null });
const custom = (baseRole: string, permissionsJson: unknown, extra: Record<string, unknown> = {}) => ({
    role: 'EDITOR',
    customRole: { baseRole, permissionsJson, ...extra },
});

const PAYLOAD = {
    tenantId: 'tenant-A',
    initiatedByUserId: 'initiator-1',
    stagingPathKey: 'tenant-A/temp/bundle.zip',
    stagingFileRecordId: 'staging-1',
    controlId: null as string | null,
    retentionUntilIso: null,
    category: null,
    folder: null,
    requestId: 'req-1',
};

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
});

describe('a custom role that withholds evidence.upload stops the import', () => {
    it('refuses before the archive is read, and creates nothing', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(
            custom('EDITOR', { evidence: { ...EDITOR.evidence, upload: false } }),
        );

        await expect(runEvidenceImport(PAYLOAD)).rejects.toThrow(/lacks evidence\.upload/);
        expect(storage.readStream).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('treats a soft-deleted custom role still linked to the membership as a request does: it applies', async () => {
        // `resolveTenantContext` reads the link and never `isActive`, so a
        // request from this member is refused `evidence.upload` too
        // (initiator-context.test.ts holds the two resolutions equal).
        prismaMock.tenantMembership.findFirst.mockResolvedValue(
            custom('EDITOR', { evidence: { ...EDITOR.evidence, upload: false } }, { isActive: false }),
        );

        await expect(runEvidenceImport(PAYLOAD)).rejects.toThrow(/lacks evidence\.upload/);
        expect(repo.create).not.toHaveBeenCalled();
    });
});

describe('a custom role that withholds controls.edit cannot import into a default control', () => {
    it('refuses every entry its link, writes no evidence, and records the denial under the initiator', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(
            custom('EDITOR', { controls: { ...EDITOR.controls, edit: false } }),
        );

        const result = await runEvidenceImport({ ...PAYLOAD, controlId: 'ctrl-1' });

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

    it('lets the same role import with no default control', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(
            custom('EDITOR', { controls: { ...EDITOR.controls, edit: false } }),
        );

        const result = await runEvidenceImport(PAYLOAD);

        expect(result.extracted).toBe(2);
        expect(result.errored).toBe(0);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});

describe('a built-in EDITOR still imports into a default control', () => {
    it('imports every entry into the default control', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(builtIn('EDITOR'));

        const result = await runEvidenceImport({ ...PAYLOAD, controlId: 'ctrl-1' });

        expect(result.extracted).toBe(2);
        expect(result.errored).toBe(0);
        expect(repo.create).toHaveBeenCalledTimes(2);
        expect(repo.createControlLinks).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: 'initiator-1', role: 'EDITOR' }),
            'ev-1',
            ['ctrl-1'],
        );
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});

describe('the membership refusal is unchanged', () => {
    it('refuses a member with no ACTIVE membership, before anything is read', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runEvidenceImport(PAYLOAD)).rejects.toThrow(
            'evidence-import: user initiator-1 is not an active member of tenant tenant-A',
        );
        expect(prismaMock.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'initiator-1', tenantId: 'tenant-A', status: 'ACTIVE' },
            }),
        );
        expect(storage.readStream).not.toHaveBeenCalled();
    });
});
