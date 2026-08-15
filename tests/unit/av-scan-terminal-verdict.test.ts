/**
 * The AV webhook's INFECTED verdict is TERMINAL.
 *
 * The route wrote the incoming verdict with an unconditional
 * `fileRecord.update` and never read the current one, so a later `clean` or
 * `skipped` callback silently un-quarantined an infected file. Nothing else
 * would have caught it: the download gates trust `scanStatus` alone, and by
 * the time they run the row simply says CLEAN. There is no record that it
 * ever said otherwise except the audit entry from the original quarantine —
 * which stays green and reads like history rather than a live contradiction.
 *
 * This drives the REAL route export with prisma mocked, so what is under test
 * is the route's own predicate rather than a restatement of it.
 */
import { NextRequest } from 'next/server';

const updateManyMock = jest.fn();
const updateMock = jest.fn();
const findUniqueMock = jest.fn();
const findFirstMock = jest.fn();
const appendAuditEntryMock = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    // `@/lib/prisma` is a DEFAULT export here — the route does
    // `import prisma from '@/lib/prisma'`, not a named import.
    default: {
        fileRecord: {
            findUnique: (...a: unknown[]) => findUniqueMock(...a),
            findFirst: (...a: unknown[]) => findFirstMock(...a),
            update: (...a: unknown[]) => updateMock(...a),
            updateMany: (...a: unknown[]) => updateManyMock(...a),
        },
    },
}));

jest.mock('@/lib/audit/audit-writer', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
}));

const FILE = {
    id: 'file-1',
    tenantId: 'tenant-1',
    pathKey: 'tenant-1/evidence/report.pdf',
    uploadedByUserId: 'user-1',
};

function post(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/storage/av-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    findUniqueMock.mockResolvedValue(FILE);
    findFirstMock.mockResolvedValue(FILE);
    updateMock.mockResolvedValue({});
    appendAuditEntryMock.mockResolvedValue(undefined);
});

describe('AV webhook — INFECTED is terminal', () => {
    it('scopes the verdict write so an INFECTED row cannot be overwritten', async () => {
        updateManyMock.mockResolvedValue({ count: 1 });
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(post({ fileId: 'file-1', status: 'clean', engine: 'clamav' }));

        expect(updateManyMock).toHaveBeenCalled();
        const args = updateManyMock.mock.calls[0][0];
        // The predicate is the whole fix. A plain `update` by id, or an
        // `updateMany` without this clause, reopens the hole while every
        // other assertion here still passes.
        expect(args.where).toEqual({ id: 'file-1', scanStatus: { not: 'INFECTED' } });
        expect(args.data.scanStatus).toBe('CLEAN');
    });

    it('does not clear the verdict when the row is already INFECTED', async () => {
        // count: 0 is how the database reports "the predicate matched nothing",
        // i.e. the row was already INFECTED.
        updateManyMock.mockResolvedValue({ count: 0 });
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        const res = await POST(post({ fileId: 'file-1', status: 'clean', engine: 'clamav' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ignored: 'already_infected' });
        // And critically: the quarantine side effects must not run in reverse.
        // `status: 'FAILED'` is only ever set, never unset, by this route.
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('reports 200 on a refused overwrite so a retrying scanner stops', async () => {
        // A 4xx/5xx would make a well-behaved scanner retry forever against a
        // decision that will never change.
        updateManyMock.mockResolvedValue({ count: 0 });
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        const res = await POST(post({ fileId: 'file-1', status: 'skipped' }));
        expect(res.status).toBe(200);
    });

    it('still quarantines on a fresh INFECTED verdict', async () => {
        // The guard must not block the transition INTO infected.
        updateManyMock.mockResolvedValue({ count: 1 });
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(post({ fileId: 'file-1', status: 'infected', details: 'Eicar-Test-Signature' }));

        expect(updateManyMock.mock.calls[0][0].data.scanStatus).toBe('INFECTED');
        // Quarantine still marks the record FAILED and writes the audit entry.
        expect(updateMock).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'FAILED' } }),
        );
        expect(appendAuditEntryMock).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'FILE_QUARANTINED' }),
        );
    });
});
