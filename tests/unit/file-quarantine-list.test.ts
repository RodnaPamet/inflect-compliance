/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * `listQuarantinedFiles` — the read side of the quarantine escape hatch.
 *
 * The REAL `FileRepository.listQuarantined` runs against a mocked Prisma
 * delegate, so these tests exercise the query the repository actually
 * builds rather than a stub that would accept any `where` at all. The
 * invariants, in the order they matter:
 *
 *   1. OWNER-only. ADMIN and EDITOR are refused, and a refusal reaches
 *      no query — proven by a positive OWNER call in the same file, so
 *      "never queried" cannot be satisfied by the code never running.
 *   2. The predicate is the actionable set: this tenant, INFECTED, and
 *      not DELETED. A DELETED row can never be cleared (the write's own
 *      predicate excludes it), so listing one offers an action that is
 *      guaranteed to fail.
 *   3. The page is BOUNDED and the bound is not negotiable from the
 *      outside. A bad signature can condemn thousands of rows.
 *   4. `pathKey` never leaves the layer — it is a storage locator for
 *      bytes the scanner condemned.
 *   5. The verdict summary reads BOTH envelope shapes in the codebase
 *      and does not swallow one it cannot parse.
 */

const mockFileRecord = {
    findMany: jest.fn(),
};
const mockTenantDb = { fileRecord: mockFileRecord } as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) =>
        fn(mockTenantDb),
    ),
}));

import {
    listQuarantinedFiles,
    summariseScanVerdict,
    DEFAULT_QUARANTINE_PAGE_SIZE,
    MAX_QUARANTINE_PAGE_SIZE,
    MAX_THREAT_TEXT,
} from '@/app-layer/usecases/file-quarantine';
import { makeRequestContext } from '../helpers/make-context';

const ownerCtx = makeRequestContext('OWNER', {
    tenantId: 'tenant-1',
    userId: 'owner-1',
});
const adminCtx = makeRequestContext('ADMIN', {
    tenantId: 'tenant-1',
    userId: 'admin-1',
});
const editorCtx = makeRequestContext('EDITOR', { tenantId: 'tenant-1' });

/** A row shaped like the repository's `select`. */
function row(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        originalName: `${id}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        sha256: `sha-${id}`,
        domain: 'evidence',
        status: 'FAILED',
        scanStatus: 'INFECTED',
        scanDetails: JSON.stringify({
            engine: 'clamav',
            result: 'infected',
            details: 'Eicar-Test-Signature',
            receivedAt: '2026-08-01T00:00:00.000Z',
        }),
        scannedAt: new Date('2026-08-01T00:00:00.000Z'),
        createdAt: new Date('2026-07-31T00:00:00.000Z'),
        uploadedByUserId: 'uploader-1',
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFileRecord.findMany.mockResolvedValue([]);
});

describe('listQuarantinedFiles — authorization', () => {
    it('refuses an ADMIN and issues no query', async () => {
        await expect(listQuarantinedFiles(adminCtx)).rejects.toThrow(
            /owner-level/i,
        );
        expect(mockFileRecord.findMany).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR and issues no query', async () => {
        await expect(listQuarantinedFiles(editorCtx)).rejects.toThrow(
            /owner-level/i,
        );
        expect(mockFileRecord.findMany).not.toHaveBeenCalled();
    });

    it('lets an OWNER through — the positive half of the two above', async () => {
        mockFileRecord.findMany.mockResolvedValueOnce([row('file-1')]);

        const result = await listQuarantinedFiles(ownerCtx);

        expect(mockFileRecord.findMany).toHaveBeenCalledTimes(1);
        expect(result.files).toHaveLength(1);
        expect(result.files[0].fileId).toBe('file-1');
    });
});

describe('listQuarantinedFiles — the query it builds', () => {
    it('scopes to the tenant, to INFECTED, and away from DELETED', async () => {
        await listQuarantinedFiles(ownerCtx);

        const args = mockFileRecord.findMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: 'tenant-1',
            scanStatus: 'INFECTED',
            status: { not: 'DELETED' },
        });
    });

    it('orders newest verdict first with a unique tiebreak', async () => {
        await listQuarantinedFiles(ownerCtx);

        const args = mockFileRecord.findMany.mock.calls[0][0];
        // `scannedAt` alone is not unique — a bulk rescan stamps many
        // rows in the same millisecond, and a cursor walk over a
        // non-unique sort key skips or repeats rows.
        expect(args.orderBy).toEqual([{ scannedAt: 'desc' }, { id: 'desc' }]);
    });

    it('never projects pathKey', async () => {
        await listQuarantinedFiles(ownerCtx);

        const args = mockFileRecord.findMany.mock.calls[0][0];
        expect(args.select.pathKey).toBeUndefined();
        // Positive half: the projection IS a projection, and carries the
        // columns an operator judges the verdict on.
        expect(args.select.originalName).toBe(true);
        expect(args.select.scanDetails).toBe(true);
    });
});

describe('listQuarantinedFiles — paging', () => {
    it('asks for one row beyond the page so it can detect a next page', async () => {
        await listQuarantinedFiles(ownerCtx, { limit: 10 });

        expect(mockFileRecord.findMany.mock.calls[0][0].take).toBe(11);
    });

    it('defaults the page size when no limit is given', async () => {
        await listQuarantinedFiles(ownerCtx);

        expect(mockFileRecord.findMany.mock.calls[0][0].take).toBe(
            DEFAULT_QUARANTINE_PAGE_SIZE + 1,
        );
    });

    it('clamps an oversized limit to the ceiling', async () => {
        await listQuarantinedFiles(ownerCtx, { limit: 100_000 });

        expect(mockFileRecord.findMany.mock.calls[0][0].take).toBe(
            MAX_QUARANTINE_PAGE_SIZE + 1,
        );
    });

    it('clamps a zero / negative limit up to one row', async () => {
        await listQuarantinedFiles(ownerCtx, { limit: 0 });
        expect(mockFileRecord.findMany.mock.calls[0][0].take).toBe(2);

        await listQuarantinedFiles(ownerCtx, { limit: -5 });
        expect(mockFileRecord.findMany.mock.calls[1][0].take).toBe(2);
    });

    it('falls back to the default when the limit is not a number', async () => {
        await listQuarantinedFiles(ownerCtx, { limit: Number.NaN });

        expect(mockFileRecord.findMany.mock.calls[0][0].take).toBe(
            DEFAULT_QUARANTINE_PAGE_SIZE + 1,
        );
    });

    it('trims the probe row and returns its predecessor as the cursor', async () => {
        mockFileRecord.findMany.mockResolvedValueOnce([
            row('a'),
            row('b'),
            row('c'), // the probe — must not be served
        ]);

        const result = await listQuarantinedFiles(ownerCtx, { limit: 2 });

        expect(result.files.map((f) => f.fileId)).toEqual(['a', 'b']);
        expect(result.nextCursor).toBe('b');
    });

    it('reports no next page when the probe row does not come back', async () => {
        mockFileRecord.findMany.mockResolvedValueOnce([row('a'), row('b')]);

        const result = await listQuarantinedFiles(ownerCtx, { limit: 2 });

        expect(result.files).toHaveLength(2);
        expect(result.nextCursor).toBeNull();
    });

    it('threads a cursor through as a skip-1 seek', async () => {
        await listQuarantinedFiles(ownerCtx, { cursor: 'file-9' });

        const args = mockFileRecord.findMany.mock.calls[0][0];
        expect(args.cursor).toEqual({ id: 'file-9' });
        expect(args.skip).toBe(1);
    });

    it('treats a blank cursor as no cursor', async () => {
        await listQuarantinedFiles(ownerCtx, { cursor: '   ' });

        const args = mockFileRecord.findMany.mock.calls[0][0];
        expect(args.cursor).toBeUndefined();
        expect(args.skip).toBeUndefined();
        // Positive half: the query still ran with the real predicate.
        expect(args.where.scanStatus).toBe('INFECTED');
    });
});

describe('listQuarantinedFiles — the row an operator reads', () => {
    it('carries identity, size, timing and the engine verdict', async () => {
        mockFileRecord.findMany.mockResolvedValueOnce([row('file-1')]);

        const { files } = await listQuarantinedFiles(ownerCtx);

        expect(files[0]).toEqual({
            fileId: 'file-1',
            originalName: 'file-1.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 4096,
            sha256: 'sha-file-1',
            domain: 'evidence',
            status: 'FAILED',
            quarantinedAt: new Date('2026-08-01T00:00:00.000Z'),
            uploadedAt: new Date('2026-07-31T00:00:00.000Z'),
            uploadedByUserId: 'uploader-1',
            verdict: {
                engine: 'clamav',
                threat: 'Eicar-Test-Signature',
                source: null,
                unparsed: false,
            },
        });
    });

    it('survives a row the scanner never stamped', async () => {
        mockFileRecord.findMany.mockResolvedValueOnce([
            row('file-2', { scannedAt: null, scanDetails: null }),
        ]);

        const { files } = await listQuarantinedFiles(ownerCtx);

        expect(files[0].quarantinedAt).toBeNull();
        expect(files[0].verdict).toEqual({
            engine: null,
            threat: null,
            source: null,
            unparsed: false,
        });
        // Positive half: the row is still LISTED — an unstamped verdict
        // must not drop the file out of the operator's view.
        expect(files[0].fileId).toBe('file-2');
    });
});

describe('summariseScanVerdict', () => {
    it('reads the AV-webhook envelope', () => {
        expect(
            summariseScanVerdict(
                JSON.stringify({
                    engine: 'clamav',
                    result: 'infected',
                    details: 'Win.Test.EICAR_HDB-1',
                    receivedAt: '2026-08-01T00:00:00.000Z',
                }),
            ),
        ).toEqual({
            engine: 'clamav',
            threat: 'Win.Test.EICAR_HDB-1',
            source: null,
            unparsed: false,
        });
    });

    it('reads the rescan-job envelope, which names the key differently', () => {
        expect(
            summariseScanVerdict(
                JSON.stringify({
                    engine: 'clamd 1.4.1',
                    durationMs: 120,
                    threat: 'Eicar-Signature',
                    source: 'rescan-job',
                    jobRunId: 'run-7',
                }),
            ),
        ).toEqual({
            engine: 'clamd 1.4.1',
            threat: 'Eicar-Signature',
            source: 'rescan-job',
            unparsed: false,
        });
    });

    it('falls back to `result` when neither threat nor details is present', () => {
        expect(
            summariseScanVerdict(JSON.stringify({ result: 'infected' })).threat,
        ).toBe('infected');
    });

    it('surfaces an unparseable value rather than swallowing it', () => {
        const verdict = summariseScanVerdict('FOUND: Eicar-Test-Signature');

        expect(verdict.unparsed).toBe(true);
        expect(verdict.threat).toBe('FOUND: Eicar-Test-Signature');
    });

    it('treats a JSON scalar or array as unparsed, not as an envelope', () => {
        expect(summariseScanVerdict('"infected"').unparsed).toBe(true);
        expect(summariseScanVerdict('[1,2,3]').unparsed).toBe(true);
        // A literal `null` parses to a non-envelope too. Reported as
        // unparsed with the raw text, which is the honest answer: the
        // column held something, and it was not a verdict.
        expect(summariseScanVerdict('null')).toEqual({
            engine: null,
            threat: 'null',
            source: null,
            unparsed: true,
        });
    });

    it('bounds scanner-supplied text — its length is not ours to trust', () => {
        const verdict = summariseScanVerdict(
            JSON.stringify({ threat: 'A'.repeat(5_000) }),
        );

        expect(verdict.threat).toHaveLength(MAX_THREAT_TEXT + 1); // + the ellipsis
        expect(verdict.threat?.endsWith('…')).toBe(true);
    });

    it('reports nothing for an empty or whitespace-only value', () => {
        for (const value of [null, '', '   ']) {
            expect(summariseScanVerdict(value)).toEqual({
                engine: null,
                threat: null,
                source: null,
                unparsed: false,
            });
        }
    });
});
