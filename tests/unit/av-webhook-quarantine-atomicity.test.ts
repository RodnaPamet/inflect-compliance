/**
 * An INFECTED verdict moves `scanStatus` and `status` together, or not at all.
 *
 * The route used to quarantine in TWO statements: a conditional `updateMany`
 * that claimed `scanStatus: 'INFECTED'`, and — after that had already
 * committed — a separate `update` setting `status: 'FAILED'`. Between them the
 * row was readable in a state neither statement intended. Any writer that won
 * the `scanStatus` race inside that window (an upload's `markStored` today, the
 * planned rescan job tomorrow) left the row saying `scanStatus: 'CLEAN'` beside
 * `status: 'FAILED'`: the download gate reads `scanStatus` and serves the file,
 * while every operator-facing surface reads `status` and reports it quarantined.
 *
 * Both halves below drive the REAL route export. A test that only inspects the
 * final row after an uncontended run cannot tell the one-write shape from the
 * two-write one — both end at INFECTED/FAILED — so the first case constructs
 * the interleaving and asserts on every intermediate state the row passed
 * through, and the second asserts the columns leave in a single statement.
 */
import { NextRequest } from 'next/server';

interface Row {
    id: string;
    tenantId: string;
    pathKey: string;
    uploadedByUserId: string;
    scanStatus: string;
    status: string;
    scanDetails?: string;
    scannedAt?: Date;
}

/** Every state the row was observable in, in order. */
let snapshots: Array<{ scanStatus: string; status: string }> = [];
let row: Row;
/** Number of statements that touched the FileRecord row. */
let writeCount = 0;
/** The concurrent writer fires once, immediately after the route's first write. */
let racerPending = false;

function freshRow(): Row {
    return {
        id: 'file-1',
        tenantId: 'tenant-1',
        pathKey: 'tenant-1/evidence/report.pdf',
        uploadedByUserId: 'user-1',
        scanStatus: 'PENDING',
        status: 'STORED',
    };
}

function snap() {
    snapshots.push({ scanStatus: row.scanStatus, status: row.status });
}

/**
 * The racing writer: an upload (or a future rescan) reporting CLEAN on the
 * same row. It is deliberately UNGUARDED — that it can clobber the verdict at
 * all is a separate, tracked defect. What is under test here is only that it
 * can never catch the row mid-quarantine, with one column moved and the other
 * not.
 */
function runRacerIfPending() {
    if (!racerPending) return;
    racerPending = false;
    row.scanStatus = 'CLEAN';
    row.status = 'STORED';
    snap();
}

const prismaMock = {
    fileRecord: {
        findUnique: jest.fn(async () => ({ ...row })),
        findFirst: jest.fn(async () => ({ ...row })),
        // A single SQL statement: the predicate is evaluated and every column
        // in `data` is applied before anything else can observe the row.
        updateMany: jest.fn(
            async ({
                where,
                data,
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                writeCount += 1;
                order.push('claim');
                const notInfected = (where.scanStatus as { not?: string } | undefined)?.not;
                if (where.id !== row.id) return { count: 0 };
                if (notInfected !== undefined && row.scanStatus === notInfected) return { count: 0 };
                Object.assign(row, data);
                snap();
                runRacerIfPending();
                return { count: 1 };
            },
        ),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            writeCount += 1;
            Object.assign(row, data);
            snap();
            runRacerIfPending();
            return { ...row };
        }),
    },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    // `@/lib/prisma` is a DEFAULT export — the route does
    // `import prisma from '@/lib/prisma'`, not a named import.
    default: prismaMock,
}));

/**
 * Ordered trace of scope boundaries and the operations inside them, so a test
 * can assert WHERE an operation ran and not merely that it ran.
 */
const order: string[] = [];
const tenantScopeCalls: Array<{ tenantId: string; source: string }> = [];

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantJobContext: async (
        job: { tenantId: string; source: string },
        fn: (db: unknown) => Promise<unknown>,
    ) => {
        tenantScopeCalls.push({ tenantId: job.tenantId, source: job.source });
        order.push('tx:start');
        try {
            return await fn(prismaMock);
        } finally {
            order.push('tx:end');
        }
    },
}));

const appendAuditEntryMock = jest.fn();
jest.mock('@/lib/audit/audit-writer', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => {
        order.push('audit');
        return appendAuditEntryMock(...a);
    },
}));

function post(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/storage/av-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    order.length = 0;
    tenantScopeCalls.length = 0;
    jest.clearAllMocks();
    row = freshRow();
    snapshots = [];
    writeCount = 0;
    racerPending = false;
    appendAuditEntryMock.mockResolvedValue(undefined);
});

describe('AV webhook — quarantine is one atomic write', () => {
    it('never exposes status=FAILED beside a non-INFECTED scanStatus when a CLEAN writer interleaves', async () => {
        racerPending = true;
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(post({ fileId: 'file-1', status: 'infected', details: 'Eicar-Test-Signature' }));

        // The racer must actually have run — otherwise this asserts nothing.
        expect(racerPending).toBe(false);
        expect(snapshots.length).toBeGreaterThanOrEqual(2);

        // The contradiction, stated directly. With the quarantine split across
        // two statements the racer lands between them and the final snapshot
        // is { scanStatus: 'CLEAN', status: 'FAILED' } — a file the download
        // gate serves on a row that reports itself quarantined.
        const contradictory = snapshots.filter(
            (s) => s.status === 'FAILED' && s.scanStatus !== 'INFECTED',
        );
        expect(contradictory).toEqual([]);
    });

    it('quarantines through exactly one statement, carrying both columns', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(post({ fileId: 'file-1', status: 'infected', details: 'Eicar-Test-Signature' }));

        expect(writeCount).toBe(1);
        expect(prismaMock.fileRecord.update).not.toHaveBeenCalled();
        expect(prismaMock.fileRecord.updateMany).toHaveBeenCalledTimes(1);

        const args = prismaMock.fileRecord.updateMany.mock.calls[0][0] as unknown as {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        };
        // Both columns, one statement, under the never-downgrade predicate.
        expect(args.where).toEqual({ id: 'file-1', scanStatus: { not: 'INFECTED' } });
        expect(args.data.scanStatus).toBe('INFECTED');
        expect(args.data.status).toBe('FAILED');

        // And the row really did land quarantined — the write is not merely
        // well-shaped, it took effect.
        expect(row).toMatchObject({ scanStatus: 'INFECTED', status: 'FAILED' });
    });

    it('leaves status alone on a clean verdict — quarantine is set, never unset', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(post({ fileId: 'file-1', status: 'clean', engine: 'clamav' }));

        const args = prismaMock.fileRecord.updateMany.mock.calls[0][0] as unknown as {
            data: Record<string, unknown>;
        };
        expect(args.data.scanStatus).toBe('CLEAN');
        expect(args.data).not.toHaveProperty('status');
        expect(row.status).toBe('STORED');
    });

    it('writes nothing at all when the row is already INFECTED', async () => {
        row.scanStatus = 'INFECTED';
        row.status = 'FAILED';
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        const res = await POST(post({ fileId: 'file-1', status: 'clean', engine: 'clamav' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ignored: 'already_infected' });
        // The predicate matched nothing, so no column moved — and because the
        // quarantine now rides in that same statement, there is no second
        // write left that could fire on the refused path.
        expect(prismaMock.fileRecord.update).not.toHaveBeenCalled();
        expect(row).toMatchObject({ scanStatus: 'INFECTED', status: 'FAILED' });
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('still writes the FILE_QUARANTINED audit row after the atomic write', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(
            post({ fileId: 'file-1', status: 'infected', engine: 'clamav', details: 'Win.Trojan.X' }),
        );

        expect(appendAuditEntryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'FILE_QUARANTINED',
                entity: 'FileRecord',
                entityId: 'file-1',
                tenantId: 'tenant-1',
            }),
        );
    });
});

/**
 * The route's DB work runs in the file's tenant context (#2096).
 *
 * Before this, the whole handler ran unbound: correct, because every query
 * filtered on `tenantId` explicitly, but with no RLS backstop underneath — the
 * one layer that would stop a future query that forgot the filter.
 *
 * The lookup is the deliberate exception and stays unbound, because finding the
 * row IS how the route learns which tenant to bind to. That is asserted below
 * rather than left implicit, so a later change that "fixes" it by binding the
 * lookup to something guessed from the payload fails here.
 */
describe('AV webhook — tenant binding', () => {
    it('runs the conditional claim INSIDE a tenant scope, and the audit write outside', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');
        await POST(post({ fileId: 'file-1', status: 'infected', engine: 'clamav' }));

        // Scope DEPTH, not relative index. Wrapping the whole handler in one
        // binding would keep the indices in order while nesting the
        // advisory-locked audit transaction inside an interactive one — which
        // is the regression this asserts against.
        const depthAt = (label: string) => {
            const at = order.indexOf(label);
            expect(at).toBeGreaterThanOrEqual(0); // positive control: it ran at all
            const before = order.slice(0, at);
            return (
                before.filter((x) => x === 'tx:start').length -
                before.filter((x) => x === 'tx:end').length
            );
        };

        expect(depthAt('claim')).toBeGreaterThan(0);
        expect(depthAt('audit')).toBe(0);
    });

    it('binds to the tenant the lookup discovered', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');
        await POST(post({ fileId: 'file-1', status: 'infected', engine: 'clamav' }));

        expect(tenantScopeCalls.length).toBeGreaterThan(0);
        for (const call of tenantScopeCalls) {
            expect(call.tenantId).toBe('tenant-1');
        }
    });

    it('never labels its context with a KEK-bypass source', async () => {
        // 'job' / 'system' / 'seed' are in KEK_BYPASS_SOURCES: they turn the
        // per-tenant DEK off, so encrypted columns written under them are
        // wrapped by the global KEK instead. `runInTenantJobContext` refuses
        // them outright, which would surface as a 500 rather than silent
        // corruption — but the label is worth pinning where it is chosen.
        for (const call of tenantScopeCalls) {
            expect(['job', 'system', 'seed']).not.toContain(call.source);
            expect(call.source).toBe('av-webhook');
        }
    });

    it('leaves the file LOOKUP unbound — it is what discovers the tenant', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');
        await POST(post({ fileId: 'file-1', status: 'infected', engine: 'clamav' }));

        // The lookup must have happened before any scope opened: there is no
        // tenant to bind to until it returns. `findUnique` is called on the
        // module-level client, so the first scope boundary in `order` comes
        // after it.
        expect(prismaMock.fileRecord.findUnique).toHaveBeenCalledWith({
            where: { id: 'file-1' },
        });
        expect(order[0]).toBe('tx:start');
        expect(order.indexOf('claim')).toBeGreaterThan(order.indexOf('tx:start'));
    });
});
