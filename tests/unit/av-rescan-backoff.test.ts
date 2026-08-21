/**
 * #120 — the rescan sweep records ATTEMPTS, separately from verdicts, and
 * backs a failing row off so it stops holding the page.
 *
 * ## The bug this file reproduces
 *
 * `av-rescan` selects `scanStatus: 'PENDING'` oldest-first under a `take`.
 * Every branch that cannot honestly produce a verdict — the object is gone
 * from storage, the bytes no longer match `FileRecord.sha256`, clamd cannot
 * parse the payload — deliberately leaves the row PENDING. That is the right
 * call and it is also, on its own, a queue that cannot drain: those rows are
 * the OLDEST, so they are re-selected first on every subsequent run, forever,
 * and the rows behind them are never examined. "The backlog never drains" is
 * the user-visible complaint the AV chain exists to fix.
 *
 * ## Why the assertions look the way they do
 *
 * A test that inspected the Prisma arguments would pass against a `where`
 * clause that is spelled correctly and ordered wrongly, and against a backoff
 * whose delay is always zero. So the Prisma mock below is a small honest
 * TABLE: it applies the `where`, the `orderBy` and the `take` it is given,
 * and `updateMany` really mutates the rows. The headline assertions then read
 * the only thing an operator cares about — after N runs, did the row behind
 * the broken one get scanned?
 */
import { Readable } from 'stream';
import { createHash } from 'crypto';

// ─── env ────────────────────────────────────────────────────────────

const mockEnv: { AV_SCAN_MODE: 'strict' | 'permissive' | 'disabled' } = {
    AV_SCAN_MODE: 'strict',
};
jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── An in-memory FileRecord table ──────────────────────────────────

interface Row {
    id: string;
    tenantId: string;
    pathKey: string;
    originalName: string;
    sha256: string;
    sizeBytes: number;
    storageProvider: string;
    status: string;
    scanStatus: string;
    scanDetails: string | null;
    scannedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
    scanAttempts: number;
    lastScanAttemptAt: Date | null;
    nextScanAttemptAt: Date | null;
}

let table: Row[] = [];

/** Every `data` payload written, tagged with the method that wrote it. */
const writes: Array<{ method: string; where: Record<string, unknown>; data: Record<string, unknown> }> = [];

function matchesScalar(value: unknown, predicate: unknown): boolean {
    if (predicate !== null && typeof predicate === 'object' && !(predicate instanceof Date)) {
        const p = predicate as Record<string, unknown>;
        if ('lte' in p) return value !== null && (value as Date) <= (p.lte as Date);
        if ('lt' in p) return value !== null && (value as Date) < (p.lt as Date);
        if ('in' in p) return (p.in as unknown[]).includes(value);
        throw new Error(`test table does not implement predicate ${JSON.stringify(p)}`);
    }
    return value === predicate;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, predicate] of Object.entries(where)) {
        if (key === 'OR') {
            const branches = predicate as Array<Record<string, unknown>>;
            if (!branches.some((b) => matches(row, b))) return false;
            continue;
        }
        if (!matchesScalar((row as unknown as Record<string, unknown>)[key], predicate)) {
            return false;
        }
    }
    return true;
}

function compare(a: Row, b: Row, orderBy: unknown): number {
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
    for (const clause of clauses) {
        const [field, dir] = Object.entries(clause as Record<string, string>)[0];
        const av = (a as unknown as Record<string, unknown>)[field] as number | Date;
        const bv = (b as unknown as Record<string, unknown>)[field] as number | Date;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
    }
    return 0;
}

// Named so `beforeEach` can hard-reset the mocks. `jest.clearAllMocks()`
// leaves a queued `mockImplementationOnce` in place, so an override a test
// never reached would silently fire inside the NEXT test.
const findManyImpl = async (args: Record<string, unknown>) => {
    let rows = table.filter((r) => matches(r, (args.where ?? {}) as Record<string, unknown>));
    if (args.orderBy) rows = [...rows].sort((a, b) => compare(a, b, args.orderBy));
    if (typeof args.take === 'number') rows = rows.slice(0, args.take);
    const select = args.select as Record<string, boolean> | undefined;
    if (!select) return rows.map((r) => ({ ...r }));
    return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(select)) {
            out[key] = (r as unknown as Record<string, unknown>)[key];
        }
        return out;
    });
};

const updateManyImpl = async (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const data = (args.data ?? {}) as Record<string, unknown>;
    writes.push({ method: 'updateMany', where, data });
    const hit = table.filter((r) => matches(r, where));
    for (const row of hit) Object.assign(row, data);
    return { count: hit.length };
};

const updateImpl = async (args: Record<string, unknown>) => {
    writes.push({
        method: 'update',
        where: (args.where ?? {}) as Record<string, unknown>,
        data: (args.data ?? {}) as Record<string, unknown>,
    });
    return {};
};

const db = {
    fileRecord: {
        findMany: jest.fn(findManyImpl),
        updateMany: jest.fn(updateManyImpl),
        update: jest.fn(updateImpl),
    },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: db, default: db }));

// ─── Tenant RLS context ─────────────────────────────────────────────
//
// #152 moved every statement in the sweep inside `runInTenantJobContext`, so
// the table above is now reached through the tenant transaction rather than
// the bare client. The mock keeps the real refusal rule (a
// `KEK_BYPASS_SOURCES` label throws) — see the sibling job test for why that
// matters — and hands the callback the same in-memory table, so the backoff
// assertions below are unchanged.
const tenantJobContexts: Array<{ tenantId: string; source: string }> = [];
jest.mock('@/lib/db-context', () => ({
    runInTenantJobContext: async (
        job: { tenantId: string; source: string },
        fn: (c: unknown) => Promise<unknown>,
    ) => {
        if (!job.tenantId) throw new Error('runInTenantJobContext requires a tenantId');
        if (['seed', 'job', 'system'].includes(job.source)) {
            throw new Error(`runInTenantJobContext refuses source '${job.source}'`);
        }
        tenantJobContexts.push(job);
        return fn(db);
    },
}));

// ─── Storage ────────────────────────────────────────────────────────

const storageBytes = new Map<string, Buffer>();
const readStream = jest.fn((pathKey: string) => {
    const bytes = storageBytes.get(pathKey);
    if (!bytes) throw new Error(`no such object: ${pathKey}`);
    return Readable.from([bytes]);
});
jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getProviderByName: jest.fn(() => ({ name: 'local', readStream })),
    buildTenantObjectKey: jest.fn(),
}));

// ─── Scanner ────────────────────────────────────────────────────────

const scanned: string[] = [];
// The return type is declared rather than inferred. Left to inference, the
// default implementation narrows it to `status: 'CLEAN'`, and a later
// `mockImplementation` that can also answer ERROR is a TS2345 — invisible to
// jest, fatal to the build.
type ScanVerdict = {
    status: 'CLEAN' | 'INFECTED' | 'ERROR';
    engine: string;
    durationMs: number;
    threat?: string;
};
const scanBufferMock = jest.fn(async (buf: Buffer): Promise<ScanVerdict> => {
    scanned.push(buf.toString());
    return { status: 'CLEAN', engine: 'clamav', durationMs: 3 };
});
jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    scanBuffer: (b: Buffer) => scanBufferMock(b),
    isDownloadAllowed: jest.fn(() => true),
}));

jest.mock('@/lib/audit/audit-writer', () => ({ appendAuditEntry: jest.fn(async () => undefined) }));

// ─── Fixtures ───────────────────────────────────────────────────────

const TENANT = 'tenant-120';
const USER = 'user-operator';
const AV_SCAN_CAP = 25 * 1024 * 1024;

let clock = new Date('2026-08-21T09:00:00.000Z');

function seed(id: string, over: Partial<Row> & { bytes?: Buffer; storeBytes?: boolean } = {}): Row {
    const bytes = over.bytes ?? Buffer.from(`payload-of-${id}`);
    const pathKey = `t/${TENANT}/evidence/${id}`;
    if (over.storeBytes !== false) storageBytes.set(pathKey, bytes);
    const row: Row = {
        id,
        tenantId: TENANT,
        pathKey,
        originalName: `${id}.pdf`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        storageProvider: 'local',
        status: 'STORED',
        scanStatus: 'PENDING',
        scanDetails: null,
        scannedAt: null,
        deletedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        scanAttempts: 0,
        lastScanAttemptAt: null,
        nextScanAttemptAt: null,
        ...over,
    };
    table.push(row);
    return row;
}

function loadJob() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@/app-layer/jobs/av-rescan') as typeof import('@/app-layer/jobs/av-rescan');
}

function row(id: string): Row {
    const found = table.find((r) => r.id === id);
    if (!found) throw new Error(`no seeded row ${id}`);
    return found;
}

const attemptWrites = () => writes.filter((w) => 'scanAttempts' in w.data);
const verdictWrites = () => writes.filter((w) => 'scanStatus' in w.data);

beforeEach(() => {
    // `mockReset` (not `clearAllMocks`) — it is the only thing that drops a
    // queued `mockImplementationOnce` a test never reached.
    db.fileRecord.findMany.mockReset().mockImplementation(findManyImpl);
    db.fileRecord.updateMany.mockReset().mockImplementation(updateManyImpl);
    db.fileRecord.update.mockReset().mockImplementation(updateImpl);
    table = [];
    writes.length = 0;
    scanned.length = 0;
    tenantJobContexts.length = 0;
    storageBytes.clear();
    jest.clearAllMocks();
    mockEnv.AV_SCAN_MODE = 'strict';
    // `mockImplementation` outlives `clearAllMocks`, so the per-test scanner
    // overrides below have to be undone here or they leak forwards.
    scanBufferMock.mockImplementation(async (buf: Buffer) => {
        scanned.push(buf.toString());
        return { status: 'CLEAN' as const, engine: 'clamav', durationMs: 3 };
    });
    clock = new Date('2026-08-21T09:00:00.000Z');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(clock);
});

afterEach(() => {
    jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════
// The reproduction: a permanently-failing row must not hold the page
// ════════════════════════════════════════════════════════════════════

describe('#120 a row that cannot reach a verdict stops holding the page', () => {
    it('lets the row BEHIND a permanently-broken one get scanned on the next run', async () => {
        // `broken` is older, so oldest-first selection always reaches it
        // first, and its object is missing from storage so it can never earn
        // a verdict. `behind` is the backlog. With `limit: 1`, the page has
        // room for exactly one of them per run — which is the whole point:
        // it is the bounded page that turns "left PENDING" into starvation.
        seed('broken', { createdAt: new Date('2026-01-01T00:00:00.000Z'), storeBytes: false });
        seed('behind', { createdAt: new Date('2026-02-01T00:00:00.000Z') });

        const { runAvRescan } = loadJob();

        const first = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 1 });
        expect(first.readError).toBe(1);
        expect(scanned).toEqual([]); // nothing scannable was reached yet

        // Time does not move. The ONLY thing that can free the page is the
        // attempt record written against `broken` on the run above.
        const second = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 1 });

        expect(scanned).toEqual(['payload-of-behind']);
        expect(second.clean).toBe(1);
        expect(row('behind').scanStatus).toBe('CLEAN');
    });

    it('drains a whole page of broken rows instead of re-reading them forever', async () => {
        for (let i = 0; i < 3; i++) {
            seed(`broken-${i}`, {
                createdAt: new Date(`2026-01-0${i + 1}T00:00:00.000Z`),
                storeBytes: false,
            });
        }
        seed('good', { createdAt: new Date('2026-06-01T00:00:00.000Z') });

        const { runAvRescan } = loadJob();

        // A page of 3 is exactly filled by the broken rows on run one.
        const first = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 3 });
        expect(first.scanned).toBe(3);
        expect(first.readError).toBe(3);
        expect(first.backedOff).toBe(3);

        const second = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 3 });
        expect(second.scanned).toBe(1);
        expect(scanned).toEqual(['payload-of-good']);
    });

    it('holds the failing rows out only until their backoff expires', async () => {
        seed('broken', { storeBytes: false });
        const { runAvRescan } = loadJob();

        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });
        expect(row('broken').scanAttempts).toBe(1);

        // Still inside the first backoff window: not selected at all.
        jest.setSystemTime(new Date(clock.getTime() + 60_000));
        const early = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });
        expect(early.scanned).toBe(0);
        expect(row('broken').scanAttempts).toBe(1);

        // Past it: selected again, and pushed out further than last time. A
        // fixed delay, or none, would leave the row at full cadence forever.
        jest.setSystemTime(new Date(clock.getTime() + 20 * 60_000));
        const later = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });
        expect(later.scanned).toBe(1);
        expect(row('broken').scanAttempts).toBe(2);
    });

    it('does not defer a never-attempted row behind a much-retried one', async () => {
        // Ordering, not just the gate. A row retried nine times is due again
        // eventually; when it is, it must not outrank a row nobody has
        // touched — otherwise the head of the queue simply moves rather than
        // clearing.
        seed('tried-often', {
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            scanAttempts: 9,
            nextScanAttemptAt: new Date('2026-08-01T00:00:00.000Z'),
        });
        seed('never-tried', { createdAt: new Date('2026-07-01T00:00:00.000Z') });

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 1 });

        expect(scanned).toEqual(['payload-of-never-tried']);
    });

    it('records an attempt for every reason a row is left pending', async () => {
        seed('gone', { storeBytes: false });
        const torn = seed('torn');
        storageBytes.set(torn.pathKey, Buffer.from('a-different-length-payload'));
        seed('huge', { sizeBytes: AV_SCAN_CAP + 1 });
        seed('errs');
        scanBufferMock.mockImplementation(async (buf: Buffer) => {
            scanned.push(buf.toString());
            return buf.toString() === 'payload-of-errs'
                ? { status: 'ERROR' as const, engine: 'none', durationMs: 1 }
                : { status: 'CLEAN' as const, engine: 'clamav', durationMs: 1 };
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(result.leftPending).toBe(4);
        expect(result.backedOff).toBe(4);
        for (const id of ['gone', 'torn', 'huge', 'errs']) {
            expect(row(id).scanAttempts).toBe(1);
            expect(row(id).nextScanAttemptAt).not.toBeNull();
            // …and still no verdict. Backing a row off must never be a way
            // of quietly declaring it scanned.
            expect(row(id).scanStatus).toBe('PENDING');
        }
    });
});

// ════════════════════════════════════════════════════════════════════
// The split: attempt bookkeeping never rides in the verdict statement
// ════════════════════════════════════════════════════════════════════

describe('#120 the attempt record and the verdict are separate writes', () => {
    it('writes the verdict with no attempt bookkeeping in it', async () => {
        seed('clean-row');

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(verdictWrites()).toHaveLength(1);
        // A verdict is terminal — the row leaves the queue by earning it, so
        // a counter alongside it is noise at best. More importantly, sharing
        // the statement is how a bookkeeping write ends up able to move
        // `scanStatus`.
        expect(Object.keys(verdictWrites()[0].data).sort()).toEqual([
            'scanDetails',
            'scanStatus',
            'scannedAt',
        ]);
        expect(attemptWrites()).toEqual([]);
        expect(row('clean-row').scanAttempts).toBe(0);
    });

    it('writes the attempt with no verdict columns in it', async () => {
        seed('gone', { storeBytes: false });

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(attemptWrites()).toHaveLength(1);
        expect(Object.keys(attemptWrites()[0].data).sort()).toEqual([
            'lastScanAttemptAt',
            'nextScanAttemptAt',
            'scanAttempts',
        ]);
        expect(verdictWrites()).toEqual([]);
    });

    it('guards the attempt write with the same PENDING predicate as the verdict', async () => {
        seed('gone', { storeBytes: false });

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // A row that won a verdict from the webhook while we were reading it
        // must not have its attempt counter bumped afterwards — the counter
        // would then be describing a row that is no longer in the queue.
        expect(attemptWrites()[0].where).toEqual({
            id: 'gone',
            tenantId: TENANT,
            scanStatus: 'PENDING',
        });
    });

    it('records the attempt inside the tenant RLS context, not on the bare client', async () => {
        seed('gone', { storeBytes: false });

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // The attempt write is the easiest of the two to leave behind: it is
        // swallowed on failure by design, so a version of it that ran outside
        // the tenant context would leave no trace anywhere.
        expect(attemptWrites()).toHaveLength(1);
        expect(tenantJobContexts.length).toBeGreaterThanOrEqual(2); // selection + attempt
        expect(tenantJobContexts.every((c) => c.tenantId === TENANT)).toBe(true);
        expect(tenantJobContexts.every((c) => c.source === 'av-rescan')).toBe(true);
    });

    it('does not bump the counter when the row stopped being PENDING', async () => {
        seed('gone', { storeBytes: false });
        // Simulate the webhook landing a verdict between selection and the
        // bookkeeping write.
        db.fileRecord.updateMany.mockImplementationOnce(async (args: Record<string, unknown>) => {
            row('gone').scanStatus = 'INFECTED';
            // Delegate to the table so the write is still RECORDED — it just
            // matches nothing now, which is the whole point.
            return updateManyImpl(args);
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(result.leftPending).toBe(1);
        // The write was ATTEMPTED — it simply matched nothing, which is the
        // conditional claim doing its job rather than the bookkeeping being
        // skipped.
        expect(attemptWrites()).toHaveLength(1);
        expect(result.backedOff).toBe(0);
        expect(row('gone').scanAttempts).toBe(0);
    });

    it('keeps sweeping when the attempt write itself fails', async () => {
        seed('gone', { createdAt: new Date('2026-01-01T00:00:00.000Z'), storeBytes: false });
        seed('good', { createdAt: new Date('2026-02-01T00:00:00.000Z') });
        db.fileRecord.updateMany.mockImplementationOnce(async () => {
            throw new Error('deadlock detected');
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // Bookkeeping decides WHEN a row is retried. Losing it must never
        // cost the operator the rest of the page.
        expect(result.clean).toBe(1);
        expect(result.backedOff).toBe(0);
        expect(scanned).toEqual(['payload-of-good']);
    });
});

// ════════════════════════════════════════════════════════════════════
// The backoff policy itself
// ════════════════════════════════════════════════════════════════════

describe('#120 the backoff schedule', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const repo = () =>
        require('@/app-layer/repositories/FileRepository') as typeof import('@/app-layer/repositories/FileRepository');

    it('doubles from the floor and stops at the ceiling', () => {
        const { scanAttemptBackoffMs, SCAN_ATTEMPT_BACKOFF_BASE_MS, SCAN_ATTEMPT_BACKOFF_MAX_MS } =
            repo();

        expect(scanAttemptBackoffMs(1)).toBe(SCAN_ATTEMPT_BACKOFF_BASE_MS);
        expect(scanAttemptBackoffMs(2)).toBe(SCAN_ATTEMPT_BACKOFF_BASE_MS * 2);
        expect(scanAttemptBackoffMs(3)).toBe(SCAN_ATTEMPT_BACKOFF_BASE_MS * 4);
        expect(scanAttemptBackoffMs(50)).toBe(SCAN_ATTEMPT_BACKOFF_MAX_MS);
        // Capped, not unbounded: the failure modes do get fixed, and a row
        // has to come back on its own when they are.
        expect(scanAttemptBackoffMs(5_000)).toBe(SCAN_ATTEMPT_BACKOFF_MAX_MS);
    });

    it('is finite for a nonsense attempt count', () => {
        const { scanAttemptBackoffMs } = repo();
        // A NaN here would reach `new Date(now + NaN)` → Invalid Date →
        // NULL in the column → "due now" → the starvation is back.
        expect(Number.isFinite(scanAttemptBackoffMs(NaN))).toBe(true);
        expect(Number.isFinite(scanAttemptBackoffMs(-3))).toBe(true);
    });

    it('refuses to let an attempt record write a verdict column', async () => {
        const { FileRepository } = repo();
        const guarded = {
            fileRecord: {
                updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
                    // The runtime guard has to fire BEFORE this — an attempt
                    // record reaching the database with `scanStatus` in it is
                    // the failure, not a bad code review.
                    expect(args.data).not.toHaveProperty('scanStatus');
                    return { count: 1 };
                }),
            },
        };
        await expect(
            FileRepository.recordScanAttempt(guarded as never, 'f1', {
                tenantId: TENANT,
                attempts: 0,
            }),
        ).resolves.toBe(1);
        expect(guarded.fileRecord.updateMany).toHaveBeenCalledTimes(1);
    });
});


// The split between an attempt record and a verdict write is the whole task.
// `assertAttemptColumnsOnly` is what will enforce it once anyone threads a
// caller-supplied object into that write — untested, it would be decoration.
describe('assertAttemptColumnsOnly — the split is enforced, not just intended', () => {
    // Lazily required, like every other import in this file: pulling
    // FileRepository in at module scope evaluates the `@/env` mock factory
    // before `mockEnv` is initialised, and the whole suite fails to run.
    const { assertAttemptColumnsOnly } =
        require('@/app-layer/repositories/FileRepository') as typeof import('@/app-layer/repositories/FileRepository');

    it('accepts exactly the three attempt columns', () => {
        expect(() =>
            assertAttemptColumnsOnly({
                scanAttempts: 3,
                lastScanAttemptAt: new Date(),
                nextScanAttemptAt: new Date(),
            }),
        ).not.toThrow();
    });

    it.each(['scanStatus', 'scanDetails', 'scannedAt', 'status'])(
        'refuses the verdict column %s — an attempt must never assert a result',
        (column) => {
            expect(() => assertAttemptColumnsOnly({ scanAttempts: 1, [column]: 'CLEAN' })).toThrow(
                /refuses to write the verdict column/,
            );
        },
    );

    it('refuses a column it does not recognise at all', () => {
        expect(() => assertAttemptColumnsOnly({ tenantId: 'tenant-1' })).toThrow(
            /refuses to write the unknown column/,
        );
    });
});
