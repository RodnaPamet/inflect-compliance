/**
 * Adding or removing an evidence record's control link needs `controls.edit`
 * on every user path, not only in the details panel (#4326, owner decision).
 *
 * The rule is `assertCanLinkEvidence`'s: the coarse write tier AND
 * `controls.edit`. `createEvidence`, `updateEvidence` and `uploadEvidenceFile`
 * asked only `evidence.edit` / `evidence.upload`, so an EDITOR-based custom role
 * without `controls.edit` could link a control through the add forms or the
 * edit form's Controls field while the details panel refused it. They now ask
 * the rule WHEN THE REQUEST CHANGES LINKS, and only then:
 *
 *   - a create or upload that names a control;
 *   - an edit whose `controlIds` differ from the current links, by an addition
 *     or a removal. The edit form sends the set back on every save, so the
 *     same set passes, and an edit that leaves `controlIds` out never touches
 *     links.
 *
 * A refusal is a 403 carrying `CONTROL_LINKS_REFUSAL` in `details`, and writes
 * the hash-chained AUTHZ_DENIED row `assertPermission` writes for a route.
 */
import { strictMock } from '../../helpers/strict-mock';

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        update: jest.fn(),
        setTags: jest.fn(),
        createControlLinks: jest.fn(),
        listControlLinks: jest.fn(),
        unlinkControl: jest.fn(),
        filterExistingControlIds: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        findBySha256: jest.fn(),
        createPending: jest.fn(),
        markStored: jest.fn(),
    },
}));

jest.mock('@/app-layer/services/file-scan', () => ({
    scanUploadOrRefuse: jest.fn(),
}));

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

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

// The AUTHZ_DENIED row `assertPermission` writes. `strictMock`: `@/lib/audit`
// is a guarded barrel, so an export this fixture forgot fails loudly.
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

import { createEvidence, updateEvidence, uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { CONTROL_LINKS_REFUSAL } from '@/app-layer/usecases/evidence-control-links';
import { runInTenantContext } from '@/lib/db-context';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { scanUploadOrRefuse } from '@/app-layer/services/file-scan';
import { getStorageProvider } from '@/lib/storage';
import { ForbiddenError } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const repo = EvidenceRepository as unknown as Record<string, jest.Mock>;
const files = FileRepository as unknown as Record<string, jest.Mock>;
const mockScan = scanUploadOrRefuse as jest.Mock;
const mockGetStorage = getStorageProvider as jest.Mock;

const EDITOR = getPermissionsForRole('EDITOR');

/** A built-in EDITOR: the coarse write tier and `controls.edit`. */
const editor = makeRequestContext('EDITOR', { tenantId: 'tenant-A', userId: 'editor-1' });

/** A custom role on an EDITOR base with `controls.edit` switched off: it may
 *  edit and upload evidence, but not change what a control is linked to. */
const editorWithoutControlsEdit = makeRequestContext('EDITOR', {
    tenantId: 'tenant-A',
    userId: 'custom-1',
    appPermissions: { ...EDITOR, controls: { ...EDITOR.controls, edit: false } },
});

/** A custom role on a READER base given `evidence.*` and `controls.edit`: the
 *  key is held, the coarse write tier is not. */
const readerBaseWithKeys = makeRequestContext('READER', {
    tenantId: 'tenant-A',
    userId: 'custom-2',
    appPermissions: {
        ...getPermissionsForRole('READER'),
        evidence: { ...EDITOR.evidence },
        controls: { ...EDITOR.controls, edit: true },
    },
});

let db: { evidence: { findFirst: jest.Mock }; fileRecord: { updateMany: jest.Mock } };
const storage = { name: 'local', write: jest.fn(), delete: jest.fn() };

beforeEach(() => {
    jest.clearAllMocks();
    db = {
        evidence: { findFirst: jest.fn().mockResolvedValue({ type: 'TEXT', status: 'DRAFT', content: 'body' }) },
        fileRecord: { updateMany: jest.fn() },
    };
    mockRunInTx.mockImplementation(async (_ctx, fn) => fn(db as never));
    repo.create.mockResolvedValue({ id: 'ev-1', title: 'Doc' });
    repo.update.mockResolvedValue({ id: 'ev-1', title: 'Doc' });
    repo.createControlLinks.mockResolvedValue(undefined);
    repo.listControlLinks.mockResolvedValue([]);
    repo.unlinkControl.mockResolvedValue(1);
    repo.filterExistingControlIds.mockImplementation(async (_db: unknown, _ctx: unknown, ids: string[]) => new Set(ids));
    files.findBySha256.mockResolvedValue(null);
    files.createPending.mockResolvedValue({ id: 'fr-1' });
    files.markStored.mockResolvedValue(undefined);
    mockScan.mockResolvedValue(null);
    storage.write.mockResolvedValue({ sha256: 'a'.repeat(64), sizeBytes: 3 });
    storage.delete.mockResolvedValue(undefined);
    mockGetStorage.mockReturnValue(storage);
});

/** The refusal: a typed 403 whose `details` name the reason. */
async function expectRefused(p: Promise<unknown>) {
    const err = await p.then(
        () => {
            throw new Error('expected a refusal');
        },
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).status).toBe(403);
    expect((err as ForbiddenError).details).toEqual({ reason: CONTROL_LINKS_REFUSAL });
}

/** Exactly one AUTHZ_DENIED row, naming `controls.edit` and the caller. */
function expectOneDenialRow(userId: string) {
    expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
        action: 'AUTHZ_DENIED',
        tenantId: 'tenant-A',
        userId,
        detailsJson: expect.objectContaining({ permissionKeys: ['controls.edit'] }),
    });
}

const linkRows = (...ids: string[]) => ids.map((controlId) => ({ controlId }));

function pdf(): File {
    return {
        name: 'policy.pdf',
        type: 'application/pdf',
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as File;
}

describe('createEvidence (POST /evidence, a text note or a link)', () => {
    const note = { type: 'TEXT' as const, title: 'Doc', content: 'body' };

    it('refuses a role without controls.edit a record created with a control, before anything is written', async () => {
        await expectRefused(createEvidence(editorWithoutControlsEdit, { ...note, controlIds: ['c1'] }));
        expect(mockRunInTx).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.createControlLinks).not.toHaveBeenCalled();
        expectOneDenialRow('custom-1');
    });

    it('refuses the legacy singular controlId the same way', async () => {
        await expectRefused(createEvidence(editorWithoutControlsEdit, { ...note, controlId: 'c1' }));
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('lets the same role create a record with no control', async () => {
        // The text-note form sends `controlId: ''` when no control is chosen.
        await createEvidence(editorWithoutControlsEdit, { ...note, controlId: '' });
        expect(repo.create).toHaveBeenCalledTimes(1);
        expect(repo.createControlLinks).toHaveBeenCalledWith(db, editorWithoutControlsEdit, 'ev-1', []);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('a built-in EDITOR creates it with its control', async () => {
        await createEvidence(editor, { ...note, controlIds: ['c1'] });
        expect(repo.createControlLinks).toHaveBeenCalledWith(db, editor, 'ev-1', ['c1']);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('holding the key without the coarse write tier is refused too, with no AUTHZ_DENIED row', async () => {
        // Like every coarse `assertCan*` refusal: the row records a missing KEY.
        await expectRefused(createEvidence(readerBaseWithKeys, { ...note, controlIds: ['c1'] }));
        expect(repo.create).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});

describe('updateEvidence (PUT /evidence/[id], the edit form)', () => {
    it('refuses a role without controls.edit an ADDED link, and writes nothing', async () => {
        repo.listControlLinks.mockResolvedValue(linkRows('c1'));
        await expectRefused(updateEvidence(editorWithoutControlsEdit, 'ev-1', { title: 'Doc', controlIds: ['c1', 'c2'] }));
        expect(repo.update).not.toHaveBeenCalled();
        expect(repo.createControlLinks).not.toHaveBeenCalled();
        expect(repo.unlinkControl).not.toHaveBeenCalled();
        expectOneDenialRow('custom-1');
    });

    it('refuses a REMOVED link the same way', async () => {
        repo.listControlLinks.mockResolvedValue(linkRows('c1', 'c2'));
        await expectRefused(updateEvidence(editorWithoutControlsEdit, 'ev-1', { title: 'Doc', controlIds: ['c1'] }));
        expect(repo.update).not.toHaveBeenCalled();
        expect(repo.unlinkControl).not.toHaveBeenCalled();
        expectOneDenialRow('custom-1');
    });

    it('refuses clearing every link', async () => {
        repo.listControlLinks.mockResolvedValue(linkRows('c1'));
        await expectRefused(updateEvidence(editorWithoutControlsEdit, 'ev-1', { controlIds: [] }));
        expect(repo.unlinkControl).not.toHaveBeenCalled();
    });

    it('lets the same role save the SAME set, in any order, and changes no link', async () => {
        repo.listControlLinks.mockResolvedValue(linkRows('c1', 'c2'));
        await updateEvidence(editorWithoutControlsEdit, 'ev-1', { title: 'Renamed', controlIds: ['c2', 'c1', 'c2'] });
        expect(repo.update).toHaveBeenCalledTimes(1);
        expect(repo.createControlLinks).toHaveBeenCalledWith(db, editorWithoutControlsEdit, 'ev-1', []);
        expect(repo.unlinkControl).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('lets the same role save an edit that leaves controlIds out, and keeps the links', async () => {
        repo.listControlLinks.mockResolvedValue(linkRows('c1'));
        await updateEvidence(editorWithoutControlsEdit, 'ev-1', { title: 'Renamed', folder: 'Q3' });
        expect(repo.update).toHaveBeenCalledTimes(1);
        // The links are not even read, let alone reconciled.
        expect(repo.listControlLinks).not.toHaveBeenCalled();
        expect(repo.createControlLinks).not.toHaveBeenCalled();
        expect(repo.unlinkControl).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('a built-in EDITOR adds and removes links', async () => {
        repo.listControlLinks.mockResolvedValue(linkRows('c1', 'c2'));
        await updateEvidence(editor, 'ev-1', { controlIds: ['c2', 'c3'] });
        expect(repo.createControlLinks).toHaveBeenCalledWith(db, editor, 'ev-1', ['c3']);
        expect(repo.unlinkControl).toHaveBeenCalledTimes(1);
        expect(repo.unlinkControl).toHaveBeenCalledWith(db, editor, 'ev-1', 'c1');
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('decides on the links BEFORE validating a control id, so a refused caller learns nothing about it', async () => {
        repo.filterExistingControlIds.mockResolvedValue(new Set());
        await expectRefused(updateEvidence(editorWithoutControlsEdit, 'ev-1', { controlIds: ['c-foreign'] }));
        expect(repo.filterExistingControlIds).not.toHaveBeenCalled();
    });
});

describe('uploadEvidenceFile (POST /evidence/uploads)', () => {
    it('refuses a role without controls.edit an upload with a control, before the bytes are scanned or stored', async () => {
        await expectRefused(uploadEvidenceFile(editorWithoutControlsEdit, pdf(), { controlId: 'c1' }));
        expect(mockScan).not.toHaveBeenCalled();
        expect(storage.write).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
        expectOneDenialRow('custom-1');
    });

    it('refuses the many-to-many controlIds the same way', async () => {
        await expectRefused(uploadEvidenceFile(editorWithoutControlsEdit, pdf(), { controlIds: ['c1'] }));
        expect(storage.write).not.toHaveBeenCalled();
    });

    it('lets the same role upload with no control', async () => {
        await uploadEvidenceFile(editorWithoutControlsEdit, pdf(), { title: 'Policy', controlId: null });
        expect(storage.write).toHaveBeenCalledTimes(1);
        expect(repo.create).toHaveBeenCalledTimes(1);
        expect(repo.createControlLinks).toHaveBeenCalledWith(db, editorWithoutControlsEdit, 'ev-1', []);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('a built-in EDITOR uploads with its control', async () => {
        await uploadEvidenceFile(editor, pdf(), { controlId: 'c1' });
        expect(repo.createControlLinks).toHaveBeenCalledWith(db, editor, 'ev-1', ['c1']);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});
