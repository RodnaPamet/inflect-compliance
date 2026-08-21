/**
 * `av-rescan` — a poison row must not abort the page, and a run that starts
 * condemning an abnormal PROPORTION of a library must stop.
 *
 * ## The two defects reproduced here
 *
 * **1. A `scanBuffer` THROW escapes the loop.** #120 gave every row that fails
 * with a *handled* outcome an attempt record and a backoff, so it stops
 * holding the head of the page. Its own implementation note records the gap it
 * left: `scanBuffer` **throwing** — a socket reset mid-INSTREAM, a parser that
 * dies on one payload — is not a handled outcome. It propagates out of the
 * `for` loop, out of `runJob`, and takes the whole batch with it. That is
 * head-of-line blocking of the worst kind: the rows behind the poison row are
 * never examined, on this run or any future one, because nothing was written
 * that would change which page is selected next time.
 *
 * **2. There is no circuit breaker.** A rescan that flips a large FRACTION of
 * a tenant's evidence library to INFECTED is far more likely to be a bad
 * ClamAV signature than an outbreak. Unattended, the job keeps going and
 * condemns the rest of the library; every one of those rows then needs an
 * OWNER to walk the `clear-quarantine` route file by file.
 *
 * ## Why the Prisma mock is a table, not a call recorder
 *
 * Both defects are about what happens to the rows the job did NOT reach. A
 * test that inspected `updateMany` arguments could not tell "row 3 was never
 * examined" from "row 3 was examined and left alone" — so the mock below is a
 * small honest table that applies `where` / `orderBy` / `take` and really
 * mutates rows, and the assertions read the table afterwards.
 *
 * Every negative assertion here ("no verdict was written", "the rows behind
 * were not touched") is paired with a positive one — a counter, a scanned
 * payload, a row that DID move — because an absence is exactly what you also
 * get from a job that crashed before it reached the decision.
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

// Named `mock*` so the hoisted factory below may close over it.
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};
jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));

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

const writes: Array<{
    method: string;
    where: Record<string, unknown>;
    data: Record<string, unknown>;
}> = [];

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
// The return type is DECLARED rather than inferred. Left to inference the
// default body narrows it to `status: 'CLEAN'`, and every per-test override
// answering INFECTED / ERROR then fails to typecheck — invisible to jest,
// fatal to the build.
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

// ─── Audit ──────────────────────────────────────────────────────────

const mockAppendAuditEntry = jest.fn(async (_entry: unknown) => undefined);
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: (entry: unknown) => mockAppendAuditEntry(entry),
}));

// ─── Fixtures ───────────────────────────────────────────────────────

const TENANT = 'tenant-poison';
const USER = 'user-operator';

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

/** Seed `count` rows named `f-000`…, ordered oldest-first by index. */
function seedMany(count: number, prefix = 'f'): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < count; i++) {
        rows.push(
            seed(`${prefix}-${String(i).padStart(3, '0')}`, {
                createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
            }),
        );
    }
    return rows;
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

const verdictWrites = () => writes.filter((w) => 'scanStatus' in w.data);
const attemptWrites = () => writes.filter((w) => 'scanAttempts' in w.data);

beforeEach(() => {
    db.fileRecord.findMany.mockReset().mockImplementation(findManyImpl);
    db.fileRecord.updateMany.mockReset().mockImplementation(updateManyImpl);
    db.fileRecord.update.mockReset().mockImplementation(updateImpl);
    table = [];
    writes.length = 0;
    scanned.length = 0;
    storageBytes.clear();
    jest.clearAllMocks();
    mockEnv.AV_SCAN_MODE = 'strict';
    // `mockImplementation` survives `clearAllMocks`, so per-test scanner
    // overrides have to be undone here or they leak into the next test.
    scanBufferMock.mockImplementation(async (buf: Buffer) => {
        scanned.push(buf.toString());
        return { status: 'CLEAN' as const, engine: 'clamav', durationMs: 3 };
    });
});

// ════════════════════════════════════════════════════════════════════
// Defect 1 — a scanner THROW must not abort the page
// ════════════════════════════════════════════════════════════════════

describe('a row whose scan throws does not take the batch with it', () => {
    it('scans the rows behind the poison row in the SAME run', async () => {
        seed('before', { createdAt: new Date('2026-01-01T00:00:00.000Z') });
        seed('poison', { createdAt: new Date('2026-01-02T00:00:00.000Z') });
        seed('after', { createdAt: new Date('2026-01-03T00:00:00.000Z') });

        scanBufferMock.mockImplementation(async (buf: Buffer) => {
            if (buf.toString() === 'payload-of-poison') {
                // Not `{ status: 'ERROR' }` — an actual throw, which is what a
                // socket reset mid-INSTREAM or an exploding parser produces.
                throw new Error('ECONNRESET talking to clamd');
            }
            scanned.push(buf.toString());
            return { status: 'CLEAN' as const, engine: 'clamav', durationMs: 3 };
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // Positive: the row AFTER the poison one was reached and settled.
        expect(scanned).toEqual(['payload-of-before', 'payload-of-after']);
        expect(result.clean).toBe(2);
        expect(row('after').scanStatus).toBe('CLEAN');
        // Negative, paired with the above: no verdict was fabricated for the
        // row that threw.
        expect(row('poison').scanStatus).toBe('PENDING');
        expect(row('poison').scannedAt).toBeNull();
        expect(result.scannerThrew).toBe(1);
        expect(result.leftPending).toBe(1);
    });

    it('records an attempt on the throwing row so it stops holding the page', async () => {
        // `poison` is the oldest, so oldest-first selection reaches it first
        // on every run; `behind` is the backlog. `limit: 1` is what turns
        // "left pending" into starvation, exactly as in the #120 suite.
        seed('poison', { createdAt: new Date('2026-01-01T00:00:00.000Z') });
        seed('behind', { createdAt: new Date('2026-02-01T00:00:00.000Z') });

        scanBufferMock.mockImplementation(async (buf: Buffer) => {
            if (buf.toString() === 'payload-of-poison') throw new Error('clamd exploded');
            scanned.push(buf.toString());
            return { status: 'CLEAN' as const, engine: 'clamav', durationMs: 3 };
        });

        const { runAvRescan } = loadJob();

        const first = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 1 });
        expect(first.scannerThrew).toBe(1);
        expect(first.backedOff).toBe(1);
        expect(row('poison').scanAttempts).toBe(1);
        expect(row('poison').nextScanAttemptAt).not.toBeNull();

        // Time does not move. The only thing that can free the page is the
        // attempt record written against `poison` on the run above.
        const second = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER, limit: 1 });
        expect(scanned).toEqual(['payload-of-behind']);
        expect(second.clean).toBe(1);
        expect(row('behind').scanStatus).toBe('CLEAN');
    });

    it('reports the throw as its own reason and keeps the counters summing', async () => {
        seed('ok', { createdAt: new Date('2026-01-01T00:00:00.000Z') });
        seed('throws', { createdAt: new Date('2026-01-02T00:00:00.000Z') });
        seed('errors', { createdAt: new Date('2026-01-03T00:00:00.000Z') });

        scanBufferMock.mockImplementation(async (buf: Buffer) => {
            if (buf.toString() === 'payload-of-throws') throw new Error('boom');
            if (buf.toString() === 'payload-of-errors') {
                return { status: 'ERROR' as const, engine: 'none', durationMs: 1 };
            }
            scanned.push(buf.toString());
            return { status: 'CLEAN' as const, engine: 'clamav', durationMs: 3 };
        });

        const { runAvRescan } = loadJob();
        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // A throw is NOT folded into `scannerError`: an operator reading
        // "the scanner answered ERROR 40 times" is looking at a different
        // failure from "the scanner blew up 40 times".
        expect(r.scannerThrew).toBe(1);
        expect(r.scannerError).toBe(1);
        expect(r.clean).toBe(1);
        expect(r.leftPending).toBe(
            r.oversize +
                r.readError +
                r.integrityMismatch +
                r.scannerError +
                r.scannerThrew +
                r.refusedSyntheticClean,
        );
        expect(r.scanned).toBe(r.clean + r.infected + r.leftPending + r.lostClaim);
    });

    it('logs the throw with its message rather than swallowing it', async () => {
        seed('poison');
        scanBufferMock.mockImplementation(async () => {
            throw new Error('clamd socket hung up');
        });

        const { runAvRescan } = loadJob();
        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(r.scannerThrew).toBe(1);
        const logged = mockLogger.error.mock.calls.concat(mockLogger.warn.mock.calls);
        const carriesMessage = logged.some(
            ([, fields]) =>
                typeof fields === 'object' &&
                fields !== null &&
                (fields as Record<string, unknown>).fileId === 'poison' &&
                String((fields as Record<string, unknown>).error).includes('socket hung up'),
        );
        expect(carriesMessage).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════
// Defect 2 — the infection-ratio circuit breaker
// ════════════════════════════════════════════════════════════════════

describe('the run halts when it starts condemning an abnormal proportion', () => {
    /** Every seeded row scans INFECTED. */
    function scannerFindsEverythingInfected() {
        scanBufferMock.mockImplementation(async (buf: Buffer) => {
            scanned.push(buf.toString());
            return {
                status: 'INFECTED' as const,
                engine: 'clamav',
                durationMs: 2,
                threat: 'Eicar-Test-Signature',
            };
        });
    }

    it('stops mid-page instead of condemning the whole library', async () => {
        const { runAvRescan, AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS } = loadJob();
        const total = AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS + 10;
        seedMany(total);
        scannerFindsEverythingInfected();

        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // Positive: it condemned exactly up to the floor and no further.
        expect(r.halted).toBe(true);
        expect(r.haltReason).toBe('infection-ratio');
        expect(r.infected).toBe(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);
        expect(r.scanned).toBe(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);

        // The rows behind the breaker were never examined at all — still
        // PENDING, and with no attempt recorded against them, so the next run
        // (once an operator has decided the signature was sound) picks them up
        // immediately rather than serving a backoff they did not earn.
        const untouched = table.slice(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);
        expect(untouched).toHaveLength(10);
        expect(untouched.every((x) => x.scanStatus === 'PENDING')).toBe(true);
        expect(untouched.every((x) => x.scanAttempts === 0)).toBe(true);
        expect(scanned).toHaveLength(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);
    });

    it('leaves the verdicts it already wrote alone — no rollback', async () => {
        const { runAvRescan, AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS } = loadJob();
        seedMany(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS + 5);
        scannerFindsEverythingInfected();

        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(r.halted).toBe(true);
        const condemned = table.filter((x) => x.scanStatus === 'INFECTED');
        expect(condemned).toHaveLength(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);
        // Rolling back would mean a second write moving a row off INFECTED.
        // Every verdict write this run made must be an INFECTED one.
        expect(verdictWrites()).toHaveLength(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);
        expect(verdictWrites().every((w) => w.data.scanStatus === 'INFECTED')).toBe(true);
        expect(attemptWrites()).toHaveLength(0);
    });

    it('announces the halt distinctly, and names the way back', async () => {
        const { runAvRescan, AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS } = loadJob();
        seedMany(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS + 3);
        scannerFindsEverythingInfected();

        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // A distinct log EVENT, not a field buried in the completion line —
        // an operator has to be able to tell "stopped because it looked
        // wrong" from "finished normally".
        const halt = mockLogger.error.mock.calls.find(([msg]) => msg === 'av-rescan.halted');
        expect(halt).toBeDefined();
        const fields = halt![1] as Record<string, unknown>;
        expect(fields.haltReason).toBe('infection-ratio');
        expect(fields.infected).toBe(AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS);
        expect(String(fields.remediation)).toContain('clear-quarantine');

        // And an audit row, so the halt reaches a SIEM and not only a log
        // aggregator.
        const audited = mockAppendAuditEntry.mock.calls.map(
            ([e]) => e as Record<string, unknown>,
        );
        const haltEntry = audited.find((e) => e.action === 'AV_RESCAN_HALTED');
        expect(haltEntry).toBeDefined();
        expect(haltEntry!.tenantId).toBe(TENANT);
        expect(
            String((haltEntry!.metadataJson as Record<string, unknown>).remediation),
        ).toContain('clear-quarantine');

        // The halt is reported on the RESULT too, so the enqueuing operator
        // reads it without going to the logs.
        expect(r.haltRemediation).toContain('clear-quarantine');
    });

    it('cannot be tripped by a small tenant, however bad the ratio looks', async () => {
        const { runAvRescan, AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS } = loadJob();
        // One row short of the absolute floor, and 100% infected. A
        // ratio-only breaker halts here; a three-file tenant with one real
        // infection would be stopped for no reason.
        const total = AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS - 1;
        seedMany(total);
        scannerFindsEverythingInfected();

        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(r.halted).toBe(false);
        expect(r.haltReason).toBeNull();
        expect(r.infected).toBe(total);
        expect(scanned).toHaveLength(total);
        expect(mockLogger.error.mock.calls.some(([m]) => m === 'av-rescan.halted')).toBe(false);
    });

    it('does not halt on a believable infection rate over a large page', async () => {
        const { runAvRescan, AV_RESCAN_INFECTION_BREAKER_RATIO, AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS } =
            loadJob();
        const total = AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS * 4;
        // Comfortably under the ratio, and above the floor: a real outbreak
        // in a real library. Spread through the page rather than bunched at
        // the front — a LEADING run of infections is a bad signature by any
        // other name, and the breaker is supposed to stop that.
        const everyNth = Math.ceil(1 / (AV_RESCAN_INFECTION_BREAKER_RATIO / 2));
        const seeded = seedMany(total);
        const infectedIds = new Set(
            seeded.filter((_, i) => i % everyNth === everyNth - 1).map((x) => `payload-of-${x.id}`),
        );
        const infectedCount = infectedIds.size;
        scanBufferMock.mockImplementation(async (buf: Buffer) => {
            scanned.push(buf.toString());
            return infectedIds.has(buf.toString())
                ? {
                      status: 'INFECTED' as const,
                      engine: 'clamav',
                      durationMs: 2,
                      threat: 'Real-Thing',
                  }
                : { status: 'CLEAN' as const, engine: 'clamav', durationMs: 2 };
        });

        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(r.halted).toBe(false);
        expect(r.infected).toBe(infectedCount);
        expect(r.clean).toBe(total - infectedCount);
        expect(r.scanned).toBe(total);
    });

    it('does not count rows left PENDING towards the population', async () => {
        // The denominator is verdicts, not rows examined. A page half of
        // which could not be read says nothing either way about whether the
        // signature is sound, and folding those in would let a storage
        // outage suppress a breaker that should have fired.
        const { runAvRescan, AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS } = loadJob();
        const floor = AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS;
        // `floor` scannable rows, interleaved with the same number of rows
        // whose object is missing from storage.
        for (let i = 0; i < floor; i++) {
            seed(`gone-${i}`, {
                createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)),
                storeBytes: false,
            });
            seed(`live-${i}`, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2 + 1)) });
        }
        scannerFindsEverythingInfected();

        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(r.halted).toBe(true);
        expect(r.infected).toBe(floor);
        expect(r.readError).toBe(floor);
        // The unreadable rows did not dilute the ratio into never tripping.
        expect(r.scanned).toBe(floor * 2);
    });
});
