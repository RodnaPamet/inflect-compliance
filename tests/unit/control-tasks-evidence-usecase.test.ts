/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/control/evidence.ts`.
 *
 * Roadmap Q1 — Compliance core. Covers the detail-page Evidence tab
 * (tab-lazy #102 payload) and the contributor/asset linking surfaces.
 * All are thin orchestration over ControlRepository — RBAC +
 * repo-returns-null → notFound + audit event shape is what we're
 * locking. (The legacy control/tasks.ts stack was removed in TP-2;
 * the Tasks tab now renders the unified Task model.)
 */

const mockDb = {
    control: { findFirst: jest.fn() },
    evidence: { findMany: jest.fn(), findFirst: jest.fn() },
    fileRecord: { findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
        listEvidenceLinks: jest.fn(),
        linkEvidence: jest.fn(),
        unlinkEvidence: jest.fn(),
        linkAsset: jest.fn(),
        unlinkAsset: jest.fn(),
        listContributors: jest.fn(),
        addContributor: jest.fn(),
        removeContributor: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        createControlLinks: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        findBySha256: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    ...jest.requireActual('@/lib/cache/list-cache'),
    bumpEntityCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { logEvent } from '@/app-layer/events/audit';
import {
    listEvidenceLinks,
    getControlEvidenceTab,
    linkEvidence,
    unlinkEvidence,
    linkAssetToControl,
    unlinkAssetFromControl,
    listContributors,
    addContributor,
    removeContributor,
} from '@/app-layer/usecases/control';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── control/evidence.ts ───────────────────────────────────────────

describe('listEvidenceLinks', () => {
    it('delegates to ControlRepository.listEvidenceLinks under the read gate', async () => {
        (ControlRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        const rows = await listEvidenceLinks(readerCtx, 'c-1');
        expect(rows).toEqual([{ id: 'l-1' }]);
    });
});

describe('getControlEvidenceTab', () => {
    it('returns links + direct evidence in a single bundled payload', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (ControlRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'e-1', evidenceControlLinks: [] },
        ]);

        const res = await getControlEvidenceTab(readerCtx, 'c-1');

        // Each evidence row now also carries `addedBy` (#4126) — null when
        // its join row names nobody.
        expect(res).toEqual({ links: [{ id: 'l-1' }], evidence: [{ id: 'e-1', addedBy: null }] });
    });

    it("names who added each library record to THIS control (#4126 — 'Added by' was a dash)", async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (ControlRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([]);
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'e-1', title: 'Export', evidenceControlLinks: [{ createdBy: { id: 'u-1', name: 'Ada' } }] },
        ]);

        const res = await getControlEvidenceTab(readerCtx, 'c-1');

        // Flattened to `addedBy`; the join array itself does not reach the client.
        expect(res.evidence).toEqual([{ id: 'e-1', title: 'Export', addedBy: { id: 'u-1', name: 'Ada' } }]);
        // One read for the page, with the join scoped to this control — so a
        // record on several controls reports who added it HERE, and no
        // per-row query is made.
        expect(mockDb.evidence.findMany).toHaveBeenCalledTimes(1);
        const args = (mockDb.evidence.findMany as jest.Mock).mock.calls[0][0];
        expect(args.include.evidenceControlLinks).toEqual({
            where: { controlId: 'c-1', tenantId: readerCtx.tenantId },
            select: { createdBy: { select: { id: true, name: true } } },
            take: 1,
        });
    });

    it('throws notFound when the control is missing (neither query fires)', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(getControlEvidenceTab(readerCtx, 'missing')).rejects.toThrow(/Control not found/i);
        expect(ControlRepository.listEvidenceLinks).not.toHaveBeenCalled();
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });
});

describe('linkEvidence — an integration result is still a plain row', () => {
    it('creates a link and emits CONTROL_EVIDENCE_LINKED', async () => {
        (ControlRepository.linkEvidence as jest.Mock).mockResolvedValue({ id: 'l-1' });

        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'INTEGRATION_RESULT', note: 'nightly scan' });

        expect(res).toEqual({ id: 'l-1' });
        expect(EvidenceRepository.create).not.toHaveBeenCalled();
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_EVIDENCE_LINKED');
        expect(payload.detailsJson.relation).toBe('INTEGRATION_RESULT');
    });

    it('throws notFound when the control is missing', async () => {
        (ControlRepository.linkEvidence as jest.Mock).mockResolvedValue(null);
        await expect(linkEvidence(editorCtx, 'missing', { kind: 'INTEGRATION_RESULT' })).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER (link-evidence gate)', async () => {
        await expect(linkEvidence(readerCtx, 'c-1', { kind: 'INTEGRATION_RESULT' })).rejects.toBeDefined();
    });
});

describe('linkEvidence — a web link is a library record (#4126 follow-up)', () => {
    beforeEach(() => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (EvidenceRepository.create as jest.Mock).mockImplementation(async (_db: any, _ctx: any, data: any) => ({
            id: 'ev-1',
            ...data,
        }));
    });

    it('creates a DRAFT LINK record joined to the control, and no plain link row', async () => {
        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: 'https://ci.example.com/run/1', note: 'CI run' });

        expect(EvidenceRepository.create).toHaveBeenCalledWith(mockDb, editorCtx, {
            type: 'LINK',
            title: 'CI run',
            content: 'https://ci.example.com/run/1',
            status: 'DRAFT',
        });
        expect(EvidenceRepository.createControlLinks).toHaveBeenCalledWith(mockDb, editorCtx, 'ev-1', ['c-1']);
        expect(ControlRepository.linkEvidence).not.toHaveBeenCalled();
        // The response is the record, so an API caller can address it.
        expect(res).toMatchObject({ id: 'ev-1', type: 'LINK', status: 'DRAFT' });
    });

    it('is titled by its address when it has no note', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: '  https://ci.example.com/run/2 ', note: '   ' });
        expect((EvidenceRepository.create as jest.Mock).mock.calls[0][2]).toMatchObject({
            title: 'https://ci.example.com/run/2',
            content: 'https://ci.example.com/run/2',
        });
    });

    it('sanitises the note it is titled by', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: 'https://x.test', note: '<script>alert(1)</script>Report' });
        expect((EvidenceRepository.create as jest.Mock).mock.calls[0][2].title).not.toMatch(/<script/);
    });

    it('sanitises the address it stores: markup characters are percent-encoded, as a browser would', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: 'https://x.test/?q=<script>alert(1)</script>' });
        const data = (EvidenceRepository.create as jest.Mock).mock.calls[0][2];
        expect(data.content).toBe('https://x.test/?q=%3Cscript%3Ealert(1)%3C/script%3E');
        expect(data.title).toBe('https://x.test/?q=%3Cscript%3Ealert(1)%3C/script%3E');
    });

    it('keeps a parameter that reads like a legacy HTML entity — `&region` is not decoded to `®ion`', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: 'https://x.test/report?lang=en&region=us' });
        expect((EvidenceRepository.create as jest.Mock).mock.calls[0][2]).toMatchObject({
            title: 'https://x.test/report?lang=en&region=us',
            content: 'https://x.test/report?lang=en&region=us',
        });
    });

    it('keeps a query string intact through sanitisation — `&` is not stored as `&amp;`', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: 'https://x.test/a?b=1&c=2' });
        expect((EvidenceRepository.create as jest.Mock).mock.calls[0][2]).toMatchObject({
            title: 'https://x.test/a?b=1&c=2',
            content: 'https://x.test/a?b=1&c=2',
        });
    });

    it('audits the record’s creation and the control link, and bumps both list caches', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: 'https://x.test' });

        const payloads = (logEvent as jest.Mock).mock.calls.map((c) => c[2]);
        expect(payloads.map((p) => p.action)).toEqual(['CREATE', 'CONTROL_EVIDENCE_LINKED']);
        expect(payloads[0]).toMatchObject({ entityType: 'Evidence', entityId: 'ev-1' });
        expect(payloads[1].detailsJson).toMatchObject({ targetId: 'ev-1', relation: 'LINK' });
        expect((bumpEntityCacheVersion as jest.Mock).mock.calls.map((c) => c[1]).sort()).toEqual(['control', 'evidence']);
    });

    it('needs the control’s gate only, not evidence.edit — a controls-scoped key keeps working', async () => {
        const controlsOnly = {
            ...editorCtx,
            appPermissions: {
                ...editorCtx.appPermissions,
                evidence: { ...editorCtx.appPermissions.evidence, edit: false },
            },
        };
        await expect(linkEvidence(controlsOnly, 'c-1', { kind: 'LINK', url: 'https://x.test' })).resolves.toMatchObject({ id: 'ev-1' });
    });

    it('refuses a link with no address, and writes nothing', async () => {
        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'LINK', url: '   ' })).rejects.toThrow(/needs a url/i);
        expect(EvidenceRepository.create).not.toHaveBeenCalled();
    });

    it('throws notFound for a control outside the tenant, before writing a record', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(linkEvidence(editorCtx, 'missing', { kind: 'LINK', url: 'https://x.test' })).rejects.toThrow(/Control not found/i);
        expect(mockDb.control.findFirst).toHaveBeenCalledWith({
            where: { id: 'missing', tenantId: editorCtx.tenantId },
            select: { id: true },
        });
        expect(EvidenceRepository.create).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('rejects READER before reading anything', async () => {
        await expect(linkEvidence(readerCtx, 'c-1', { kind: 'LINK', url: 'https://x.test' })).rejects.toBeDefined();
        expect(mockDb.control.findFirst).not.toHaveBeenCalled();
    });
});

describe('linkEvidence — an uploaded file is a library record', () => {
    const storedFile = {
        id: 'f-1',
        pathKey: 'tenants/t-1/evidence/2026/10/0b1c_soc2.pdf',
        originalName: 'soc2.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        sha256: 'a1b2',
        status: 'STORED',
        scanStatus: 'CLEAN',
    };

    beforeEach(() => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (mockDb.fileRecord.findFirst as jest.Mock).mockResolvedValue(storedFile);
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue(null);
        (FileRepository.findBySha256 as jest.Mock).mockResolvedValue(storedFile);
        (EvidenceRepository.create as jest.Mock).mockImplementation(async (_db: any, _ctx: any, data: any) => ({
            id: 'ev-f',
            ...data,
        }));
    });

    function expectNothingWritten() {
        expect(EvidenceRepository.create).not.toHaveBeenCalled();
        expect(EvidenceRepository.createControlLinks).not.toHaveBeenCalled();
        expect(ControlRepository.linkEvidence).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    }

    it('creates a DRAFT FILE record from the stored file, joined to the control, and no plain row', async () => {
        // A url in the body is ignored: the record's content is the file's own
        // storage key, read from the FileRecord.
        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1', url: 'https://evil.test/x', note: 'SOC 2 report' });

        expect(mockDb.fileRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'f-1', tenantId: editorCtx.tenantId },
        }));
        expect(EvidenceRepository.create).toHaveBeenCalledWith(mockDb, editorCtx, {
            type: 'FILE',
            title: 'SOC 2 report',
            content: 'tenants/t-1/evidence/2026/10/0b1c_soc2.pdf',
            fileName: 'soc2.pdf',
            fileSize: 2048,
            fileRecordId: 'f-1',
            status: 'DRAFT',
        });
        expect(EvidenceRepository.createControlLinks).toHaveBeenCalledWith(mockDb, editorCtx, 'ev-f', ['c-1']);
        expect(ControlRepository.linkEvidence).not.toHaveBeenCalled();
        expect(res).toMatchObject({ id: 'ev-f', type: 'FILE', status: 'DRAFT', fileRecordId: 'f-1' });
    });

    it('is titled by the file name when it has no note', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1', note: '   ' });
        expect((EvidenceRepository.create as jest.Mock).mock.calls[0][2].title).toBe('soc2.pdf');
    });

    it('sanitises the note it is titled by', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1', note: '<script>alert(1)</script>Report' });
        expect((EvidenceRepository.create as jest.Mock).mock.calls[0][2].title).toBe('Report');
    });

    it('audits the record’s creation and the control link, and bumps both list caches', async () => {
        await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' });

        const payloads = (logEvent as jest.Mock).mock.calls.map((c) => c[2]);
        expect(payloads.map((p) => p.action)).toEqual(['CREATE', 'CONTROL_EVIDENCE_LINKED']);
        expect(payloads[0]).toMatchObject({ entityType: 'Evidence', entityId: 'ev-f' });
        expect(payloads[0].detailsJson.after).toEqual({ title: 'soc2.pdf', type: 'FILE', fileRecordId: 'f-1' });
        expect(payloads[1]).toMatchObject({ entityType: 'Control', entityId: 'c-1' });
        expect(payloads[1].detailsJson).toMatchObject({ targetEntity: 'Evidence', targetId: 'ev-f', relation: 'FILE' });
        expect((bumpEntityCacheVersion as jest.Mock).mock.calls.map((c) => c[1]).sort()).toEqual(['control', 'evidence']);
    });

    it('joins the live record that already holds the file, instead of a second record for the same bytes', async () => {
        const held = { id: 'ev-old', type: 'FILE', title: 'Old upload', fileRecordId: 'f-1', status: 'APPROVED' };
        (mockDb.evidence.findFirst as jest.Mock)
            .mockResolvedValueOnce(null) // none of them is on this control yet
            .mockResolvedValueOnce(held);

        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1', note: 'ignored' });

        expect(res).toBe(held);
        expect(EvidenceRepository.create).not.toHaveBeenCalled();
        expect(EvidenceRepository.createControlLinks).toHaveBeenCalledTimes(1);
        expect(EvidenceRepository.createControlLinks).toHaveBeenCalledWith(mockDb, editorCtx, 'ev-old', ['c-1']);
        // Only live (not deleted, not archived) records in this tenant count,
        // and the pick is stable.
        const [onControlQuery, anyQuery] = (mockDb.evidence.findFirst as jest.Mock).mock.calls.map((c) => c[0]);
        expect(onControlQuery.where).toEqual({
            tenantId: editorCtx.tenantId,
            fileRecordId: 'f-1',
            deletedAt: null,
            isArchived: false,
            evidenceControlLinks: { some: { tenantId: editorCtx.tenantId, controlId: 'c-1' } },
        });
        expect(anyQuery.where).toEqual({ tenantId: editorCtx.tenantId, fileRecordId: 'f-1', deletedAt: null, isArchived: false });
        expect(anyQuery.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
        // No CREATE — nothing was created; the link is audited against that record.
        const payloads = (logEvent as jest.Mock).mock.calls.map((c) => c[2]);
        expect(payloads.map((p) => p.action)).toEqual(['CONTROL_EVIDENCE_LINKED']);
        expect(payloads[0].detailsJson).toMatchObject({ targetId: 'ev-old', relation: 'FILE' });
    });

    it('changes nothing when a record holding the file is already on the control', async () => {
        const onControl = { id: 'ev-on', type: 'FILE', fileRecordId: 'f-1' };
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValueOnce(onControl);

        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' });

        expect(res).toBe(onControl);
        expect(mockDb.evidence.findFirst).toHaveBeenCalledTimes(1);
        expectNothingWritten();
    });

    it('refuses a file outside the tenant (or missing) with 404, writing nothing', async () => {
        (mockDb.fileRecord.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'other-tenants-file' }))
            .rejects.toMatchObject({ status: 404, message: 'File not found' });
        expectNothingWritten();
    });

    it('refuses a FILE with no fileId with 400, before reading anything', async () => {
        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: '  ' }))
            .rejects.toMatchObject({ status: 400, message: 'A file needs a fileId.' });
        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'FILE' })).rejects.toMatchObject({ status: 400 });
        expect(mockDb.control.findFirst).not.toHaveBeenCalled();
        expect(mockDb.fileRecord.findFirst).not.toHaveBeenCalled();
        expectNothingWritten();
    });

    it.each([
        ['the file itself is quarantined', { scanStatus: 'INFECTED', status: 'FAILED' }, { scanStatus: 'INFECTED' }],
        ['another record with the same bytes is quarantined', {}, { id: 'f-other', scanStatus: 'INFECTED' }],
    ])('refuses it with the upload path’s FILE_INFECTED when %s', async (_label, fileOverrides, hashMatch) => {
        (mockDb.fileRecord.findFirst as jest.Mock).mockResolvedValue({ ...storedFile, ...fileOverrides });
        (FileRepository.findBySha256 as jest.Mock).mockResolvedValue({ ...storedFile, ...hashMatch });

        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' }))
            .rejects.toMatchObject({ status: 400, message: 'FILE_INFECTED' });
        expectNothingWritten();
    });

    it.each([
        ['a type the upload does not accept', { mimeType: 'application/x-msdownload' }, 'FILE_TYPE_NOT_ALLOWED'],
        ['an empty file', { sizeBytes: 0 }, 'FILE_TOO_LARGE'],
        ['a size over the upload cap', { sizeBytes: 10 * 1024 * 1024 * 1024 }, 'FILE_TOO_LARGE'],
        ['a file that is not stored', { status: 'PENDING' }, 'FILE_NOT_STORED'],
    ])('refuses %s, writing nothing', async (_label, fileOverrides, code) => {
        (mockDb.fileRecord.findFirst as jest.Mock).mockResolvedValue({ ...storedFile, ...fileOverrides });
        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' }))
            .rejects.toMatchObject({ status: 400, message: code });
        expectNothingWritten();
    });

    it('accepts a file whose scan has not finished — the upload path stores those too, and the download gate decides', async () => {
        const pending = { ...storedFile, scanStatus: 'PENDING' };
        (mockDb.fileRecord.findFirst as jest.Mock).mockResolvedValue(pending);
        (FileRepository.findBySha256 as jest.Mock).mockResolvedValue(pending);
        await expect(linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' })).resolves.toMatchObject({ id: 'ev-f' });
    });

    it('needs the control’s gate only, not evidence.edit — a controls-scoped key keeps working', async () => {
        const controlsOnly = {
            ...editorCtx,
            appPermissions: {
                ...editorCtx.appPermissions,
                evidence: { ...editorCtx.appPermissions.evidence, edit: false, upload: false },
            },
        };
        await expect(linkEvidence(controlsOnly, 'c-1', { kind: 'FILE', fileId: 'f-1' })).resolves.toMatchObject({ id: 'ev-f' });
    });

    it('throws notFound for a control outside the tenant, before reading the file', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(linkEvidence(editorCtx, 'missing', { kind: 'FILE', fileId: 'f-1' })).rejects.toThrow(/Control not found/i);
        expect(mockDb.fileRecord.findFirst).not.toHaveBeenCalled();
        expectNothingWritten();
    });

    it('rejects READER before reading anything', async () => {
        await expect(linkEvidence(readerCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' })).rejects.toMatchObject({ status: 403 });
        expect(mockDb.control.findFirst).not.toHaveBeenCalled();
        expect(mockDb.fileRecord.findFirst).not.toHaveBeenCalled();
        expectNothingWritten();
    });
});

describe('unlinkEvidence', () => {
    it('removes link and emits CONTROL_EVIDENCE_UNLINKED', async () => {
        (ControlRepository.unlinkEvidence as jest.Mock).mockResolvedValue(true);

        const res = await unlinkEvidence(editorCtx, 'c-1', 'l-1');

        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_EVIDENCE_UNLINKED');
    });

    it('throws notFound when the link is missing', async () => {
        (ControlRepository.unlinkEvidence as jest.Mock).mockResolvedValue(null);
        await expect(unlinkEvidence(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Evidence link not found/i);
    });

    it('rejects READER', async () => {
        await expect(unlinkEvidence(readerCtx, 'c-1', 'l-1')).rejects.toBeDefined();
    });
});

describe('linkAssetToControl', () => {
    it('returns the link row when successful', async () => {
        (ControlRepository.linkAsset as jest.Mock).mockResolvedValue({ controlId: 'c-1', assetId: 'a-1' });
        const res = await linkAssetToControl(editorCtx, 'c-1', 'a-1');
        expect(res).toEqual({ controlId: 'c-1', assetId: 'a-1' });
    });

    it('throws notFound when the control does not exist', async () => {
        (ControlRepository.linkAsset as jest.Mock).mockResolvedValue(null);
        await expect(linkAssetToControl(editorCtx, 'missing', 'a-1')).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER', async () => {
        await expect(linkAssetToControl(readerCtx, 'c-1', 'a-1')).rejects.toBeDefined();
    });
});

describe('unlinkAssetFromControl', () => {
    it('returns success on delete', async () => {
        (ControlRepository.unlinkAsset as jest.Mock).mockResolvedValue(true);
        const res = await unlinkAssetFromControl(editorCtx, 'c-1', 'a-1');
        expect(res).toEqual({ success: true });
    });

    it('throws notFound when the row is missing', async () => {
        (ControlRepository.unlinkAsset as jest.Mock).mockResolvedValue(null);
        await expect(unlinkAssetFromControl(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Control or asset link not found/i);
    });
});

describe('listContributors', () => {
    it('delegates to ControlRepository.listContributors', async () => {
        (ControlRepository.listContributors as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        const rows = await listContributors(readerCtx, 'c-1');
        expect(rows).toEqual([{ id: 'u-1' }]);
    });
});

describe('addContributor', () => {
    it('adds a contributor and emits CONTROL_CONTRIBUTOR_ADDED', async () => {
        (ControlRepository.addContributor as jest.Mock).mockResolvedValue({ id: 'cb-1' });
        const res = await addContributor(editorCtx, 'c-1', 'u-1');
        expect(res).toEqual({ id: 'cb-1' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_CONTRIBUTOR_ADDED');
    });

    it('throws notFound when the control is missing', async () => {
        (ControlRepository.addContributor as jest.Mock).mockResolvedValue(null);
        await expect(addContributor(editorCtx, 'missing', 'u-1')).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER', async () => {
        await expect(addContributor(readerCtx, 'c-1', 'u-1')).rejects.toBeDefined();
    });
});

describe('removeContributor', () => {
    it('removes a contributor and emits CONTROL_CONTRIBUTOR_REMOVED', async () => {
        (ControlRepository.removeContributor as jest.Mock).mockResolvedValue(true);
        const res = await removeContributor(editorCtx, 'c-1', 'u-1');
        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_CONTRIBUTOR_REMOVED');
    });

    it('throws notFound when the row is missing', async () => {
        (ControlRepository.removeContributor as jest.Mock).mockResolvedValue(null);
        await expect(removeContributor(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Control or contributor not found/i);
    });
});
