/**
 * Evidence free text is sanitised at the usecase layer, on every write path
 * that takes text from a caller, before the row is written.
 *
 * The writers, and what each stores from the caller:
 *
 *   · evidence.createEvidence      title, TEXT note / LINK url, category, owner, folder
 *   · evidence.updateEvidence      the same, three-state
 *   · evidence.uploadEvidenceFile  title (or the file name standing in for it),
 *                                  category, owner, folder — the ZIP and
 *                                  SharePoint imports arrive through it
 *   · task.linkTaskEvidence  ┐
 *   · risk.linkRiskEvidence  ├   the URL (content, and title when there is no
 *   · asset.linkAssetEvidence┘   note) and the note (title)
 *
 * Prose goes through `sanitizePlainText`. A URL goes through `sanitizeUrlText`,
 * because the plain-text profile parses its input as HTML and so decodes
 * `&region=` into `®ion=` — the cases below that keep a query string intact
 * are what would catch the plain-text profile being used on a URL.
 *
 * A FILE row's `content` is the storage pathKey the upload derives. It is never
 * caller text and must reach the row exactly as derived.
 */

const mockDb = {
    evidence: { create: jest.fn(), findFirst: jest.fn() },
    task: { findFirst: jest.fn() },
    risk: { findFirst: jest.fn() },
    asset: { findFirst: jest.fn() },
    evidenceRiskLink: { create: jest.fn() },
    evidenceAssetLink: { create: jest.fn() },
    tenantMembership: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        update: jest.fn(),
        filterExistingControlIds: jest.fn(async (_db: unknown, _ctx: unknown, ids: string[]) => new Set(ids)),
        createControlLinks: jest.fn(async () => undefined),
        listControlLinks: jest.fn(async () => []),
        unlinkControl: jest.fn(async () => 1),
        setTags: jest.fn(async () => undefined),
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
    bumpEntityCacheVersion: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

import { createEvidence, updateEvidence, uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { linkTaskEvidence } from '@/app-layer/usecases/task';
import { linkRiskEvidence } from '@/app-layer/usecases/risk';
import { linkAssetEvidence } from '@/app-layer/usecases/asset';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { scanUploadOrRefuse } from '@/app-layer/services/file-scan';
import { getStorageProvider } from '@/lib/storage';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';
import { CreateEvidenceSchema, UpdateEvidenceSchema } from '@/lib/schemas';

const mockRepoCreate = EvidenceRepository.create as jest.Mock;
const mockRepoUpdate = EvidenceRepository.update as jest.Mock;
const mockLog = logEvent as jest.Mock;

const ctx = makeRequestContext('EDITOR', { tenantId: 'tenant-A', userId: 'user-editor' });

const SCRIPT = '<script>alert(1)</script>';
/** A URL whose query names are legacy HTML entities (`&reg`, `&para`, `&times`, `&sect`). */
const QUERY_URL = 'https://x.test/report?lang=en&region=us&param=2&timestamp=3&section=4';

beforeEach(() => {
    jest.clearAllMocks();
    mockRepoCreate.mockImplementation(async (_db: unknown, _ctx: unknown, data: { title: string }) => ({
        id: 'ev-1',
        title: data.title,
    }));
    mockRepoUpdate.mockResolvedValue({ id: 'ev-1' });
    mockDb.evidence.create.mockResolvedValue({ id: 'ev-1' });
    mockDb.evidence.findFirst.mockResolvedValue({ type: 'TEXT', status: 'DRAFT', content: null });
    mockDb.task.findFirst.mockResolvedValue({ id: 'task-1' });
    mockDb.risk.findFirst.mockResolvedValue({ id: 'risk-1' });
    mockDb.asset.findFirst.mockResolvedValue({ id: 'asset-1' });
});

/** The data object handed to `EvidenceRepository.create`. */
const createdRow = () => mockRepoCreate.mock.calls[0][2];
/** The patch handed to `EvidenceRepository.update`. */
const updatePatch = () => mockRepoUpdate.mock.calls[0][3];

// ─── createEvidence ───────────────────────────────────────────────

describe('evidence.createEvidence sanitises every free-text column', () => {
    it('strips <script> from title, the TEXT note, category, owner and folder', async () => {
        await createEvidence(ctx, {
            type: 'TEXT',
            title: `Firewall review${SCRIPT}`,
            content: `Rules checked<img src=x onerror=alert(1)> on Monday${SCRIPT}`,
            category: `Network${SCRIPT}`,
            owner: `<b>Jane</b> Doe${SCRIPT}`,
            folder: `  <i>Q3</i>${SCRIPT}  `,
        });
        const row = createdRow();
        expect(row.title).toBe('Firewall review');
        expect(row.content).toBe('Rules checked on Monday');
        expect(row.category).toBe('Network');
        expect(row.owner).toBe('Jane Doe');
        expect(row.folder).toBe('Q3');
    });

    it('does not reconstitute an entity-encoded tag in the note', async () => {
        await createEvidence(ctx, {
            type: 'TEXT',
            title: 'Encoded',
            content: 'before &lt;script&gt;alert(1)&lt;/script&gt; after',
        });
        expect(createdRow().content).not.toMatch(/<script|alert/);
    });

    it('stores a LINK url with its query string intact', async () => {
        await createEvidence(ctx, { type: 'LINK', title: 'Report', content: QUERY_URL });
        expect(createdRow().content).toBe(QUERY_URL);
    });

    it('stores a LINK url with markup percent-encoded, not stripped', async () => {
        await createEvidence(ctx, {
            type: 'LINK',
            title: 'Report',
            content: `https://x.test/a?q=1&region=2${SCRIPT}`,
        });
        expect(createdRow().content).toBe('https://x.test/a?q=1&region=2%3Cscript%3Ealert(1)%3C/script%3E');
    });

    it('stores a note that was nothing but markup as no note', async () => {
        await createEvidence(ctx, { type: 'TEXT', title: 'Empty body', content: '<b></b>' });
        expect(createdRow().content).toBeNull();
    });

    it.each(['<b></b>', '<b> </b>', SCRIPT, '   '])(
        'refuses a title that is blank once sanitised (%j), before any write',
        async (title) => {
            await expect(createEvidence(ctx, { type: 'TEXT', title })).rejects.toThrow(/Title is required/);
            expect(mockRepoCreate).not.toHaveBeenCalled();
        },
    );
});

// ─── updateEvidence ───────────────────────────────────────────────

describe('evidence.updateEvidence sanitises what it writes, three-state', () => {
    it('strips <script> from title, the TEXT note, category, owner and folder', async () => {
        await updateEvidence(ctx, 'ev-1', {
            title: `Renamed${SCRIPT}`,
            content: `New body${SCRIPT}`,
            category: `Access${SCRIPT}`,
            owner: `Ops <u>team</u>${SCRIPT}`,
            folder: ` <i>Archive</i>${SCRIPT} `,
        });
        const patch = updatePatch();
        expect(patch.title).toBe('Renamed');
        expect(patch.content).toBe('New body');
        expect(patch.category).toBe('Access');
        expect(patch.owner).toBe('Ops team');
        expect(patch.folder).toBe('Archive');
    });

    it('records the sanitised title and category in the audit row, not the raw input', async () => {
        await updateEvidence(ctx, 'ev-1', { title: `Renamed${SCRIPT}`, category: `Access${SCRIPT}` });
        const after = mockLog.mock.calls[0][2].detailsJson.after;
        expect(after).toEqual({ title: 'Renamed', category: 'Access' });
    });

    it('leaves every omitted field undefined (untouched)', async () => {
        await updateEvidence(ctx, 'ev-1', { tags: ['q3'] });
        const patch = updatePatch();
        for (const field of ['title', 'content', 'category', 'owner', 'folder']) {
            expect(patch[field]).toBeUndefined();
        }
    });

    it('passes an explicit null through as a clear', async () => {
        await updateEvidence(ctx, 'ev-1', { category: null, owner: null, folder: null });
        const patch = updatePatch();
        expect(patch.category).toBeNull();
        expect(patch.owner).toBeNull();
        expect(patch.folder).toBeNull();
    });

    it('clears a folder that is blank once sanitised', async () => {
        await updateEvidence(ctx, 'ev-1', { folder: '<b> </b>' });
        expect(updatePatch().folder).toBeNull();
    });

    it.each(['<b></b>', '<b> </b>', SCRIPT])(
        'refuses a title that is blank once sanitised (%j), before any write',
        async (title) => {
            await expect(updateEvidence(ctx, 'ev-1', { title })).rejects.toThrow(/Title is required/);
            expect(mockRepoUpdate).not.toHaveBeenCalled();
        },
    );

    it('sanitises a LINK row body as a URL', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'LINK', status: 'DRAFT', content: 'https://x.test/old' });
        await updateEvidence(ctx, 'ev-1', { content: `${QUERY_URL}${SCRIPT}` });
        expect(updatePatch().content).toBe(`${QUERY_URL}%3Cscript%3Ealert(1)%3C/script%3E`);
    });

    it('never writes a FILE row body (its content is the storage pathKey)', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'FILE', status: 'DRAFT', content: 'tenant-A/evidence/a.pdf' });
        await updateEvidence(ctx, 'ev-1', { content: `elsewhere${SCRIPT}` });
        expect(updatePatch().content).toBeUndefined();
    });

    it('leaves a body returned exactly as stored alone — no rewrite, no re-review', async () => {
        // The edit form sends the body back on every save. A row written
        // before sanitisation must not have its body rewritten, nor its
        // approval voided, by an edit that only moved it to a folder.
        const legacy = 'Config: <MinLength>12</MinLength>';
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'TEXT', status: 'APPROVED', content: legacy });
        await updateEvidence(ctx, 'ev-1', { content: legacy, folder: 'Archive' });
        const patch = updatePatch();
        expect(patch.content).toBeUndefined();
        expect(patch.status).toBeUndefined();
        expect(patch.folder).toBe('Archive');
    });

    it('re-reviews an APPROVED row whose body really changed, comparing the sanitised value', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'TEXT', status: 'APPROVED', content: 'Approved body' });
        await updateEvidence(ctx, 'ev-1', { content: `Edited body${SCRIPT}` });
        expect(updatePatch()).toMatchObject({ content: 'Edited body', status: 'SUBMITTED' });
    });

    it('keeps an approval when added markup sanitises back to the approved body', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'TEXT', status: 'APPROVED', content: 'Approved body' });
        await updateEvidence(ctx, 'ev-1', { content: `Approved body${SCRIPT}` });
        expect(updatePatch().status).toBeUndefined();
    });
});

describe('evidence.updateEvidence — an empty body clears a note and cannot clear a link', () => {
    it.each([null, '', '   ', '<b></b>'])('clears a TEXT note sent as %j', async (sent) => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'TEXT', status: 'DRAFT', content: 'Old note' });
        await updateEvidence(ctx, 'ev-1', { content: sent });
        expect(updatePatch().content).toBeNull();
    });

    it.each([null, '', '   '])('refuses clearing a LINK URL sent as %j, and writes nothing', async (sent) => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'LINK', status: 'DRAFT', content: QUERY_URL });
        await expect(updateEvidence(ctx, 'ev-1', { content: sent })).rejects.toThrow(/A link needs a URL/);
        expect(mockRepoUpdate).not.toHaveBeenCalled();
    });

    it('a LINK body sent back as stored, even null, is not an edit', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ type: 'LINK', status: 'DRAFT', content: null });
        await updateEvidence(ctx, 'ev-1', { content: null, folder: 'Archive' });
        expect(updatePatch().content).toBeUndefined();
    });

    it('the update schema takes null for content (the edit form sends it); create refuses SCREENSHOT', () => {
        expect(UpdateEvidenceSchema.safeParse({ content: null }).success).toBe(true);
        // `EvidenceType` in the database is FILE | LINK | TEXT; SCREENSHOT failed the insert with a 500.
        expect(CreateEvidenceSchema.safeParse({ title: 'x', type: 'SCREENSHOT' }).success).toBe(false);
        expect(CreateEvidenceSchema.safeParse({ title: 'x', type: 'TEXT' }).success).toBe(true);
    });
});

// ─── uploadEvidenceFile ───────────────────────────────────────────

describe('evidence.uploadEvidenceFile sanitises its metadata and leaves the pathKey alone', () => {
    function fakeFile(name: string): File {
        return {
            name,
            type: 'application/pdf',
            size: 3,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as unknown as File;
    }

    beforeEach(() => {
        (getStorageProvider as jest.Mock).mockReturnValue({
            name: 'local',
            write: jest.fn(async () => ({ sha256: 'a'.repeat(64), sizeBytes: 3 })),
            delete: jest.fn(async () => undefined),
        });
        (scanUploadOrRefuse as jest.Mock).mockResolvedValue(null);
        (FileRepository.findBySha256 as jest.Mock).mockResolvedValue(null);
        (FileRepository.createPending as jest.Mock).mockResolvedValue({ id: 'file-1' });
        (FileRepository.markStored as jest.Mock).mockResolvedValue(undefined);
    });

    it('strips <script> from title, category, owner and folder', async () => {
        await uploadEvidenceFile(ctx, fakeFile('policy.pdf'), {
            title: `Signed policy${SCRIPT}`,
            category: `Policy${SCRIPT}`,
            owner: `<b>Legal</b>${SCRIPT}`,
            folder: ` <i>2026</i>${SCRIPT} `,
        });
        const row = createdRow();
        expect(row.title).toBe('Signed policy');
        expect(row.category).toBe('Policy');
        expect(row.owner).toBe('Legal');
        expect(row.folder).toBe('2026');
    });

    it('names the evidence after the sanitised file name when the title is nothing but markup', async () => {
        await uploadEvidenceFile(ctx, fakeFile(`<b>audit</b>-report${SCRIPT}.pdf`), { title: '<b></b>' });
        expect(createdRow().title).toBe('audit-report.pdf');
    });

    it('stores the derived pathKey as content, byte for byte, even when the file name carries markup', async () => {
        const name = `<b>audit</b>-report${SCRIPT}.pdf`;
        await uploadEvidenceFile(ctx, fakeFile(name), { title: 'Audit report' });
        const row = createdRow();
        expect(row.type).toBe('FILE');
        expect(row.content).toBe(`tenant-A/evidence/${name}`);
    });
});

// ─── task / risk / asset — attach a URL as evidence ───────────────

type LinkWriter = (data: { url: string; note?: string | null }) => Promise<unknown>;

describe.each<[string, LinkWriter]>([
    ['task.linkTaskEvidence', (data) => linkTaskEvidence(ctx, 'task-1', data)],
    ['risk.linkRiskEvidence', (data) => linkRiskEvidence(ctx, 'risk-1', data)],
    ['asset.linkAssetEvidence', (data) => linkAssetEvidence(ctx, 'asset-1', data)],
])('%s sanitises the URL and the note', (_name, link) => {
    /** The data object handed to `db.evidence.create`. */
    const createdLink = () => mockDb.evidence.create.mock.calls[0][0].data;

    it('keeps the query string intact in content and in the title it stands in for', async () => {
        await link({ url: QUERY_URL });
        const row = createdLink();
        expect(row.type).toBe('LINK');
        expect(row.content).toBe(QUERY_URL);
        expect(row.title).toBe(QUERY_URL);
    });

    it('percent-encodes markup in the URL, so neither column carries a tag', async () => {
        await link({ url: `https://x.test/a${SCRIPT}` });
        const row = createdLink();
        expect(row.content).toBe('https://x.test/a%3Cscript%3Ealert(1)%3C/script%3E');
        expect(row.title).toBe(row.content);
    });

    it('strips <script> from the note it uses as the title', async () => {
        await link({ url: QUERY_URL, note: `Change ticket${SCRIPT}` });
        expect(createdLink().title).toBe('Change ticket');
    });

    it('falls back to the URL when the note is blank once sanitised', async () => {
        await link({ url: QUERY_URL, note: '<b> </b>' });
        expect(createdLink().title).toBe(QUERY_URL);
    });
});
