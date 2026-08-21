/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * The distribution ledger and the exposure report it answers with.
 *
 * The question under test is the one the product could not previously answer:
 * a verdict flips to INFECTED hours after upload — what already carried those
 * bytes, is any of it still live, and what has to be chased by hand?
 *
 * Three properties are load-bearing and each has a case below:
 *   1. the join is on the CONTENT HASH, so a re-upload of the same bytes under
 *      a different FileRecord is still counted;
 *   2. a presigned URL that has not expired yet is counted separately from a
 *      permanent copy, because only one of the two has an end date;
 *   3. recording is fail-safe — a ledger failure must never fail the download
 *      or export that is in flight, and must never silently claim the report
 *      is complete when it is not.
 */
const appendAuditEntryMock = jest.fn();
jest.mock('@/lib/audit/audit-writer', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
}));

const prismaFileFindMany = jest.fn();
const prismaAuditFindMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: {
        fileRecord: { findMany: (...a: unknown[]) => prismaFileFindMany(...a) },
        auditLog: { findMany: (...a: unknown[]) => prismaAuditFindMany(...a) },
    },
}));

import {
    recordFileDistribution,
    recordFileDistributions,
    buildFileExposureReport,
    assessExposureOnInfection,
    FILE_DISTRIBUTED_ACTION,
    FILE_EXPOSURE_ASSESSED_ACTION,
    isUnrevocable,
} from '@/app-layer/services/file-distribution';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const HASH = 'a'.repeat(64);

/** One ledger row as the audit trail stores it. */
function ledgerRow(over: Record<string, unknown> = {}) {
    return {
        entityId: 'file-1',
        userId: 'user-1',
        createdAt: new Date('2026-08-21T11:00:00.000Z'),
        detailsJson: {
            category: 'custom',
            kind: 'file_distribution',
            channel: 'EVIDENCE_DOWNLOAD',
            sha256: HASH,
            destination: null,
            contextType: null,
            contextId: null,
            signedUrlExpiresAt: null,
            revocable: true,
        },
        ...over,
    };
}

function client(files: Array<{ id: string }>, rows: any[]) {
    return {
        fileRecord: { findMany: jest.fn(async () => files) },
        auditLog: { findMany: jest.fn(async () => rows) },
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    appendAuditEntryMock.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
});

describe('recordFileDistribution', () => {
    it('appends a hash-chained ledger entry carrying the join key', async () => {
        const ok = await recordFileDistribution({
            tenantId: 't1',
            fileRecordId: 'file-1',
            sha256: HASH,
            channel: 'EVIDENCE_DOWNLOAD',
            actorUserId: 'user-1',
            signedUrlExpiresAt: new Date('2026-08-21T12:05:00.000Z'),
        });

        expect(ok).toBe(true);
        const entry = appendAuditEntryMock.mock.calls[0][0];
        expect(entry).toMatchObject({
            tenantId: 't1',
            entity: 'FileRecord',
            entityId: 'file-1',
            action: FILE_DISTRIBUTED_ACTION,
            userId: 'user-1',
        });
        expect(entry.detailsJson).toMatchObject({
            channel: 'EVIDENCE_DOWNLOAD',
            sha256: HASH,
            revocable: true,
            signedUrlExpiresAt: '2026-08-21T12:05:00.000Z',
        });
    });

    it('marks a SharePoint copy unrevocable — nobody can take it back', async () => {
        await recordFileDistribution({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH,
            channel: 'AUDIT_PACK_SHAREPOINT', destination: 'drive-1',
        });
        expect(appendAuditEntryMock.mock.calls[0][0].detailsJson).toMatchObject({ revocable: false });
        expect(isUnrevocable('AUDIT_PACK_SHAREPOINT')).toBe(true);
        expect(isUnrevocable('EVIDENCE_DOWNLOAD')).toBe(false);
    });

    it('never throws when the ledger write fails — the download must still complete', async () => {
        appendAuditEntryMock.mockRejectedValueOnce(new Error('db down'));
        await expect(
            recordFileDistribution({ tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, channel: 'EVIDENCE_DOWNLOAD' }),
        ).resolves.toBe(false);
    });

    it('refuses an entry with no hash — it could never be joined on', async () => {
        const ok = await recordFileDistribution({
            tenantId: 't1', fileRecordId: 'file-1', sha256: '', channel: 'EVIDENCE_DOWNLOAD',
        });
        expect(ok).toBe(false);
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('records a batch and counts what landed', async () => {
        appendAuditEntryMock.mockRejectedValueOnce(new Error('db down'));
        const n = await recordFileDistributions([
            { tenantId: 't1', fileRecordId: 'f1', sha256: HASH, channel: 'AUDIT_PACK_SHAREPOINT' },
            { tenantId: 't1', fileRecordId: 'f2', sha256: HASH, channel: 'AUDIT_PACK_SHAREPOINT' },
        ]);
        expect(n).toBe(1);
    });
});

describe('buildFileExposureReport', () => {
    it('joins on the content hash, so a re-upload of the same bytes still counts', async () => {
        const c = client(
            [{ id: 'file-1' }, { id: 'file-copy' }],
            [ledgerRow({ entityId: 'file-copy', userId: 'user-2' })],
        );

        const report = await buildFileExposureReport({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW, client: c,
        });

        // The lookup asked for every row holding these bytes...
        expect(c.fileRecord.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', sha256: HASH });
        // ...and the ledger query covered the sibling, not just the named row.
        expect(c.auditLog.findMany.mock.calls[0][0].where.entityId.in).toEqual(
            expect.arrayContaining(['file-1', 'file-copy']),
        );
        expect(report.siblingFileRecordIds).toEqual(['file-copy']);
        expect(report.totalDistributions).toBe(1);
        expect(report.recipientUserIds).toEqual(['user-2']);
    });

    it('separates a still-live signed URL from an expired one and from a permanent copy', async () => {
        const live = ledgerRow({
            detailsJson: { ...ledgerRow().detailsJson, signedUrlExpiresAt: '2026-08-21T12:04:00.000Z' },
        });
        const expired = ledgerRow({
            detailsJson: { ...ledgerRow().detailsJson, signedUrlExpiresAt: '2026-08-21T11:05:00.000Z' },
        });
        const permanent = ledgerRow({
            createdAt: new Date('2026-08-21T11:30:00.000Z'),
            detailsJson: {
                ...ledgerRow().detailsJson,
                channel: 'AUDIT_PACK_SHAREPOINT', revocable: false,
                destination: 'drive-1', contextType: 'AuditPack', contextId: 'p1',
            },
        });

        const report = await buildFileExposureReport({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW,
            client: client([{ id: 'file-1' }], [expired, permanent, live]),
        });

        expect(report.totalDistributions).toBe(3);
        expect(report.liveSignedUrls).toBe(1);
        // The bounded half of the story: after this instant only the permanent
        // copies remain.
        expect(report.signedUrlExposureEndsAt).toBe('2026-08-21T12:04:00.000Z');
        expect(report.unrevocableCopies).toBe(1);
        expect(report.byChannel).toEqual({ EVIDENCE_DOWNLOAD: 2, AUDIT_PACK_SHAREPOINT: 1 });
        const sp = report.artefacts.find((a) => a.channel === 'AUDIT_PACK_SHAREPOINT');
        expect(sp).toMatchObject({ contextType: 'AuditPack', contextId: 'p1', destination: 'drive-1', revocable: false });
    });

    it('treats an unclassifiable entry as a permanent copy — it falls closed', async () => {
        const report = await buildFileExposureReport({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW,
            client: client([{ id: 'file-1' }], [ledgerRow({ detailsJson: null })]),
        });

        expect(report.byChannel).toEqual({ UNKNOWN: 1 });
        expect(report.unrevocableCopies).toBe(1);
        expect(report.liveSignedUrls).toBe(0);
    });

    it('reports a clean nothing-left-the-platform answer', async () => {
        const report = await buildFileExposureReport({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW,
            client: client([{ id: 'file-1' }], []),
        });

        expect(report).toMatchObject({
            totalDistributions: 0,
            unrevocableCopies: 0,
            liveSignedUrls: 0,
            firstDistributedAt: null,
            exhaustive: true,
        });
    });

    it('says so when the ledger is only a lower bound', async () => {
        const many = Array.from({ length: 501 }, () => ledgerRow());
        const report = await buildFileExposureReport({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW,
            client: client([{ id: 'file-1' }], many),
        });

        expect(report.exhaustive).toBe(false);
        expect(report.totalDistributions).toBe(500);
    });
});

describe('assessExposureOnInfection', () => {
    it('writes the report into the same hash-chained trail', async () => {
        const report = await assessExposureOnInfection({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, engine: 'clamav', now: NOW,
            client: client([{ id: 'file-1' }], [ledgerRow()]),
        });

        expect(report?.totalDistributions).toBe(1);
        const entry = appendAuditEntryMock.mock.calls[0][0];
        expect(entry).toMatchObject({
            tenantId: 't1',
            entity: 'FileRecord',
            entityId: 'file-1',
            action: FILE_EXPOSURE_ASSESSED_ACTION,
            actorType: 'SYSTEM',
        });
        expect(entry.detailsJson).toMatchObject({ totalDistributions: 1, engine: 'clamav' });
    });

    it('records the zero answer too — an absent row cannot be told from an assessment that never ran', async () => {
        await assessExposureOnInfection({
            tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW,
            client: client([{ id: 'file-1' }], []),
        });
        expect(appendAuditEntryMock).toHaveBeenCalledTimes(1);
        expect(appendAuditEntryMock.mock.calls[0][0].detailsJson).toMatchObject({ totalDistributions: 0 });
    });

    it('never throws when the assessment fails — the quarantine has already committed', async () => {
        const broken = {
            fileRecord: { findMany: jest.fn(async () => { throw new Error('db down'); }) },
            auditLog: { findMany: jest.fn() },
        } as any;

        await expect(
            assessExposureOnInfection({ tenantId: 't1', fileRecordId: 'file-1', sha256: HASH, now: NOW, client: broken }),
        ).resolves.toBeNull();
    });
});
