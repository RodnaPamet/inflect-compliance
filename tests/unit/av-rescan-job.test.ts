/**
 * Unit test — `av-rescan`, the bounded one-off rescan of PENDING evidence.
 *
 * Evidence preview is blocked in `strict` mode until a FileRecord carries a
 * verdict, and nothing ever moved rows off the `scanStatus: 'PENDING'`
 * default except the upload path. This job is the catch-up sweep, and the
 * whole point of the suite below is that a catch-up sweep is the single most
 * dangerous shape in the AV subsystem: it writes verdicts unattended, in bulk,
 * on bytes it did not receive from the user.
 *
 * Each block below is one way that goes wrong. Every one of them is written to
 * fail against the obvious implementation — the naive version this file was
 * driven against wrote SKIPPED for a scanner error, persisted the synthetic
 * disabled-mode CLEAN, trusted whatever bytes storage handed back, audited
 * before the verdict, and did all of it inside a tenant transaction.
 */
import { Readable } from 'stream';
import { createHash } from 'crypto';

// ─── Call-order ledger ──────────────────────────────────────────────
//
// Several of the invariants here are ORDERING claims ("the verdict is
// persisted before the audit row", "nothing is written before the scanner
// answers", "no scan happens with a transaction open"). A boolean per mock
// cannot express those, so every interesting mock appends to one shared log
// and the assertions read positions out of it.

const order: string[] = [];

// ─── env (mutable per test) ─────────────────────────────────────────

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

// ─── Prisma ─────────────────────────────────────────────────────────

const findMany = jest.fn();
const updateMany = jest.fn();
const update = jest.fn();
const transaction = jest.fn();

const db = {
    fileRecord: {
        findMany: (...a: unknown[]) => {
            order.push('findMany');
            return findMany(...a);
        },
        updateMany: (...a: unknown[]) => {
            order.push('updateMany');
            return updateMany(...a);
        },
        update: (...a: unknown[]) => {
            order.push('update');
            return update(...a);
        },
    },
    $transaction: async (fn: (c: unknown) => Promise<unknown>) => {
        order.push('tx:start');
        const r = await transaction(fn);
        order.push('tx:end');
        return r;
    },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: db, default: db }));

// ─── Tenant transaction wrapper ─────────────────────────────────────
//
// The mock keeps the REAL refusal rule (a `KEK_BYPASS_SOURCES` label throws)
// so a future edit that relabels this job `'job'` fails here rather than in
// production, where the symptom would be encrypted columns reading `null`.

const runInTenantContextMock = jest.fn(
    async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) => {
        order.push('tx:start');
        try {
            return await fn(db);
        } finally {
            order.push('tx:end');
        }
    },
);
const runInTenantJobContextMock = jest.fn(
    async (job: { tenantId: string; source: string }, fn: (c: unknown) => Promise<unknown>) => {
        if (!job.tenantId) throw new Error('runInTenantJobContext requires a tenantId');
        if (['seed', 'job', 'system'].includes(job.source)) {
            throw new Error(`runInTenantJobContext refuses source '${job.source}'`);
        }
        order.push('tx:start');
        try {
            return await fn(db);
        } finally {
            order.push('tx:end');
        }
    },
);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (ctx: unknown, fn: (c: unknown) => Promise<unknown>) =>
        runInTenantContextMock(ctx, fn),
    runInTenantJobContext: (job: never, fn: (c: unknown) => Promise<unknown>) =>
        runInTenantJobContextMock(job, fn),
}));

// ─── Storage ────────────────────────────────────────────────────────

/** pathKey -> bytes storage will actually hand back. */
const storageBytes = new Map<string, Buffer>();
const readStream = jest.fn((pathKey: string) => {
    order.push('read');
    const bytes = storageBytes.get(pathKey);
    if (!bytes) throw new Error(`no such object: ${pathKey}`);
    return Readable.from([bytes]);
});
const getProviderByNameMock = jest.fn((_name: string) => ({ name: 'local', readStream }));
jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getProviderByName: (n: string) => getProviderByNameMock(n),
    buildTenantObjectKey: jest.fn(),
}));

// ─── Scanner ────────────────────────────────────────────────────────

type ScanVerdict = {
    status: 'CLEAN' | 'INFECTED' | 'ERROR';
    engine: string;
    durationMs: number;
    threat?: string;
};
const scanBufferMock = jest.fn(
    async (_b: Buffer): Promise<ScanVerdict> => ({
        status: 'CLEAN',
        engine: 'clamav',
        durationMs: 3,
    }),
);
jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    scanBuffer: (b: Buffer) => {
        order.push('scan');
        return scanBufferMock(b);
    },
    isDownloadAllowed: jest.fn(() => true),
}));

// ─── Audit ──────────────────────────────────────────────────────────

/** A minimal but complete `FileExposureReport` — the record half needs a real one. */
const EXPOSURE_REPORT = {
    fileRecordId: 'file-x',
    sha256: 'x',
    siblingFileRecordIds: [],
    totalDistributions: 0,
    byChannel: {},
    firstDistributedAt: null,
    lastDistributedAt: null,
    unrevocableCopies: 0,
    liveSignedUrls: 0,
    signedUrlExposureEndsAt: null,
    recipientUserIds: [],
    artefacts: [],
    exhaustive: true,
    assessedAt: '2026-01-01T00:00:00.000Z',
};

const buildExposureMock = jest.fn(async (_opts: unknown) => EXPOSURE_REPORT);
const recordExposureMock = jest.fn(async (_report: unknown, _opts: unknown) => undefined);
jest.mock('@/app-layer/services/file-distribution', () => ({
    __esModule: true,
    buildFileExposureReport: (opts: unknown) => {
        order.push('exposure:build');
        return buildExposureMock(opts as never);
    },
    recordFileExposureReport: (report: unknown, opts: unknown) => {
        order.push('exposure:record');
        return recordExposureMock(report as never, opts as never);
    },
}));

const appendAuditEntryMock = jest.fn(async (_entry: unknown) => undefined);
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: (entry: unknown) => {
        order.push('audit');
        return appendAuditEntryMock(entry as never);
    },
}));

// ─── Fixtures ───────────────────────────────────────────────────────

const TENANT = 'tenant-av-rescan';
const USER = 'user-operator';

interface RowOverrides {
    id?: string;
    sizeBytes?: number;
    sha256?: string;
    bytes?: Buffer;
    scanAttempts?: number;
}

/**
 * Build a PENDING FileRecord whose stored bytes match its recorded digest —
 * i.e. the honest case. Individual tests corrupt one facet at a time.
 */
function pendingRow(over: RowOverrides = {}) {
    const id = over.id ?? 'file-1';
    const bytes = over.bytes ?? Buffer.from(`payload-of-${id}`);
    const pathKey = `t/${TENANT}/evidence/${id}`;
    storageBytes.set(pathKey, bytes);
    return {
        id,
        pathKey,
        originalName: `${id}.pdf`,
        sha256: over.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: over.sizeBytes ?? bytes.length,
        storageProvider: 'local',
        scanAttempts: over.scanAttempts ?? 0,
    };
}

function loadJob() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@/app-layer/jobs/av-rescan') as typeof import('@/app-layer/jobs/av-rescan');
}

/** Every `data` payload handed to a FileRecord write, by any method. */
function writtenPayloads(): Array<Record<string, unknown>> {
    return [...updateMany.mock.calls, ...update.mock.calls].map(
        (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
}

/**
 * The writes that assert a scan RESULT.
 *
 * #120 split the attempt record out of the verdict write, so "the job wrote
 * nothing" is no longer the right question for a row left pending — an
 * attempt IS recorded there, deliberately, in columns disjoint from the
 * verdict. The invariant these blocks protect is unchanged and narrower than
 * it looked: no VERDICT is written. Anything carrying `scanStatus` is one.
 */
function verdictPayloads(): Array<Record<string, unknown>> {
    return writtenPayloads().filter((d) => 'scanStatus' in d);
}

beforeEach(() => {
    order.length = 0;
    storageBytes.clear();
    jest.clearAllMocks();
    mockEnv.AV_SCAN_MODE = 'strict';
    findMany.mockResolvedValue([]);
    updateMany.mockResolvedValue({ count: 1 });
    update.mockResolvedValue({});
    scanBufferMock.mockResolvedValue({ status: 'CLEAN', engine: 'clamav', durationMs: 3 });
});

// ════════════════════════════════════════════════════════════════════
// #113 — the synthetic disabled-mode CLEAN must never be persisted
// ════════════════════════════════════════════════════════════════════

describe('#113 a synthetic CLEAN is never written to a row', () => {
    it('refuses to run at all when AV_SCAN_MODE is disabled', async () => {
        mockEnv.AV_SCAN_MODE = 'disabled';
        findMany.mockResolvedValue([pendingRow()]);

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // `scanBuffer` fabricates `{ status: 'CLEAN', engine: 'disabled' }`
        // when CLAMAV_HOST is unset, so calling it at all in this mode is
        // already the bug — the row would then be stamped CLEAN and stay
        // servable in every future mode.
        expect(scanBufferMock).not.toHaveBeenCalled();
        expect(verdictPayloads()).toEqual([]);
        expect(result.scanned).toBe(0);
    });

    it('drops a CLEAN carrying engine "disabled" even in strict mode', async () => {
        // The second, independent guard. The mode check above already covers
        // the configured case; this one covers a scanner that answers with the
        // synthetic engine for any other reason.
        findMany.mockResolvedValue([pendingRow()]);
        scanBufferMock.mockResolvedValue({
            status: 'CLEAN',
            engine: 'disabled',
            durationMs: 0,
        });

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(scanBufferMock).toHaveBeenCalled();
        expect(verdictPayloads()).toEqual([]);
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════
// #114 — byte identity before the verdict is trusted
// ════════════════════════════════════════════════════════════════════

describe('#114 bytes read back from storage are verified against the record', () => {
    it('does not scan, and does not write, when the digest disagrees', async () => {
        const row = pendingRow({ id: 'file-truncated' });
        // A truncated / partial read: storage returns fewer bytes than the
        // row was written with. Scanning that prefix is how a truncated read
        // gets recorded as CLEAN.
        storageBytes.set(row.pathKey, Buffer.from('payload-of-file-trunc'));
        findMany.mockResolvedValue([row]);

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(scanBufferMock).not.toHaveBeenCalled();
        expect(verdictPayloads()).toEqual([]);
        expect(result.integrityMismatch).toBe(1);
    });

    it('scans and writes when the digest matches', async () => {
        findMany.mockResolvedValue([pendingRow({ id: 'file-intact' })]);

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(scanBufferMock).toHaveBeenCalledTimes(1);
        expect(result.clean).toBe(1);
    });
});

// ════════════════════════════════════════════════════════════════════
// #115 — SKIPPED is servable, so it never means "could not scan"
// ════════════════════════════════════════════════════════════════════

describe('#115 SKIPPED is never used for "too big" or "scanner down"', () => {
    it('leaves the row PENDING on a scanner ERROR', async () => {
        findMany.mockResolvedValue([pendingRow({ id: 'file-err' })]);
        scanBufferMock.mockResolvedValue({ status: 'ERROR', engine: 'none', durationMs: 1 });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(verdictPayloads()).toEqual([]);
        expect(result.leftPending).toBe(1);
    });

    it('leaves the row PENDING when it exceeds the scan cap', async () => {
        // Declared size over the cap — never read, never scanned, never
        // stamped. `isDownloadAllowed` returns true for SKIPPED, so writing
        // SKIPPED here would publish an unscanned file.
        findMany.mockResolvedValue([
            pendingRow({ id: 'file-huge', sizeBytes: 26 * 1024 * 1024 }),
        ]);

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(readStream).not.toHaveBeenCalled();
        expect(scanBufferMock).not.toHaveBeenCalled();
        expect(verdictPayloads()).toEqual([]);
        expect(result.leftPending).toBe(1);
    });

    it('writes no SKIPPED verdict anywhere in a mixed batch', async () => {
        const err = pendingRow({ id: 'file-a' });
        const huge = pendingRow({ id: 'file-b', sizeBytes: 99 * 1024 * 1024 });
        const ok = pendingRow({ id: 'file-c' });
        findMany.mockResolvedValue([err, huge, ok]);
        scanBufferMock.mockImplementation(async (buf: Buffer) =>
            buf.toString() === 'payload-of-file-a'
                ? { status: 'ERROR' as const, engine: 'none', durationMs: 1 }
                : { status: 'CLEAN' as const, engine: 'clamav', durationMs: 2 },
        );

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        const statuses = verdictPayloads().map((d) => d.scanStatus);
        expect(statuses).toEqual(['CLEAN']);
        expect(statuses).not.toContain('SKIPPED');
    });
});

// ════════════════════════════════════════════════════════════════════
// #121 — a conditional claim, not a per-row lease
// ════════════════════════════════════════════════════════════════════

describe('#121 concurrency is a conditional claim at verdict time', () => {
    it('writes nothing before the scanner has answered', async () => {
        findMany.mockResolvedValue([pendingRow()]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // A lease stamps the row BEFORE the verdict exists, so a process that
        // dies mid-scan leaves the row in a state no later run selects —
        // permanent invisibility. The ledger makes that shape impossible to
        // write without failing here.
        const firstWrite = order.findIndex((e) => e === 'updateMany' || e === 'update');
        const firstScan = order.indexOf('scan');
        expect(firstScan).toBeGreaterThan(-1);
        expect(firstWrite).toBeGreaterThan(firstScan);
    });

    it('claims with a PENDING predicate so a concurrent writer cannot be overwritten', async () => {
        findMany.mockResolvedValue([pendingRow({ id: 'file-claim' })]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // An unconditional `update` would clobber a verdict another writer
        // (the AV webhook, an upload retry) landed while we were scanning.
        expect(update).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalledTimes(1);
        // #152 added `tenantId` alongside the row id. The invariant this
        // block protects is the PENDING guard, so it is asserted by key
        // rather than by whole-object equality — a shape match would have to
        // be edited again by the next legitimate narrowing of the predicate,
        // and each such edit is a chance to drop the guard by accident.
        expect(updateMany.mock.calls[0][0].where).toMatchObject({
            id: 'file-claim',
            tenantId: TENANT,
            scanStatus: 'PENDING',
        });
    });

    it('does not audit a verdict it lost the race to write', async () => {
        findMany.mockResolvedValue([pendingRow()]);
        updateMany.mockResolvedValue({ count: 0 });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(result.clean).toBe(0);
        expect(result.lostClaim).toBe(1);
    });

    it('never writes the quarantine column — scanStatus only', async () => {
        findMany.mockResolvedValue([pendingRow()]);
        scanBufferMock.mockResolvedValue({
            status: 'INFECTED',
            engine: 'clamav',
            threat: 'Eicar-Test-Signature',
            durationMs: 4,
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(result.infected).toBe(1);
        for (const data of verdictPayloads()) {
            expect(Object.keys(data)).not.toContain('status');
        }
        expect(verdictPayloads()[0].scanStatus).toBe('INFECTED');
    });

    // ── #129 — the sweep's verdicts reach the distribution ledger ──
    //
    // The ledger answers "what already left". It was wired into the AV
    // webhook only, so verdicts found by THIS path — which walks the whole
    // PENDING backlog, i.e. the files servable the longest — bypassed it.
    it('assesses exposure for a file it condemns, after the verdict is durable', async () => {
        findMany.mockResolvedValue([pendingRow()]);
        scanBufferMock.mockResolvedValue({
            status: 'INFECTED',
            engine: 'clamav',
            threat: 'Eicar-Test-Signature',
            durationMs: 4,
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(result.infected).toBe(1);
        expect(buildExposureMock).toHaveBeenCalledTimes(1);
        expect(buildExposureMock.mock.calls[0][0]).toMatchObject({
            tenantId: TENANT,
            fileRecordId: pendingRow().id,
            sha256: pendingRow().sha256,
        });
        // The reads run on the job's BOUND connection, not the global client.
        expect((buildExposureMock.mock.calls[0][0] as { client?: unknown }).client).toBe(db);

        expect(recordExposureMock).toHaveBeenCalledTimes(1);
        expect(recordExposureMock.mock.calls[0][0]).toBe(EXPOSURE_REPORT);
        expect(recordExposureMock.mock.calls[0][1]).toMatchObject({
            tenantId: TENANT,
            fileRecordId: pendingRow().id,
            engine: 'clamav',
        });

        // ORDER is the assertion, not merely that both ran: the verdict must
        // be durable before anything reports on it, or a failed report could
        // describe a row that was never condemned.
        expect(order.indexOf('exposure:build')).toBeGreaterThan(order.indexOf('audit'));

        // ── The split itself ────────────────────────────────────────
        //
        // The READ belongs inside a tenant binding; the WRITE must not be,
        // because `appendAuditEntry` opens its own advisory-locked
        // transaction and nesting it holds two pooled connections per
        // condemned file. Measured by scope depth at each point rather than
        // by relative index — wrapping BOTH calls in one `inTenant` would
        // keep the indices in order while breaking exactly this property.
        const depthAt = (label: string) => {
            const at = order.indexOf(label);
            const before = order.slice(0, at);
            return (
                before.filter((x) => x === 'tx:start').length -
                before.filter((x) => x === 'tx:end').length
            );
        };
        expect(depthAt('exposure:build')).toBeGreaterThan(0);
        expect(depthAt('exposure:record')).toBe(0);
    });

    it('does not assess exposure for a CLEAN verdict', async () => {
        findMany.mockResolvedValue([pendingRow()]);
        scanBufferMock.mockResolvedValue({
            status: 'CLEAN',
            engine: 'clamav',
            durationMs: 4,
        });

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // Positive first — the negative below is only evidence if the job
        // actually ran and took the CLEAN branch. On its own,
        // `not.toHaveBeenCalled()` passes just as well when nothing executed.
        expect(result.clean).toBe(1);
        expect(verdictPayloads()[0].scanStatus).toBe('CLEAN');
        expect(buildExposureMock).not.toHaveBeenCalled();
        expect(recordExposureMock).not.toHaveBeenCalled();
    });

    it('a failing ledger never costs the sweep a verdict it correctly wrote', async () => {
        findMany.mockResolvedValue([pendingRow()]);
        scanBufferMock.mockResolvedValue({
            status: 'INFECTED',
            engine: 'clamav',
            threat: 'Eicar-Test-Signature',
            durationMs: 4,
        });
        buildExposureMock.mockRejectedValueOnce(new Error('ledger down'));

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // The run completes and the verdict stands. A reporting problem must
        // never un-condemn a file.
        expect(result.infected).toBe(1);
        expect(verdictPayloads()[0].scanStatus).toBe('INFECTED');
    });
});

// ════════════════════════════════════════════════════════════════════
// #122 — the verdict lands before the audit row
// ════════════════════════════════════════════════════════════════════

describe('#122 the verdict is persisted before it is audited', () => {
    it('orders the claim ahead of the audit entry', async () => {
        findMany.mockResolvedValue([pendingRow()]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // The inline upload path audits FIRST, because there the audit row is
        // the only record a refused file ever existed. Here the row survives
        // either way, and the failure that matters is the opposite one: an
        // audit entry asserting a verdict that a crash stopped us persisting.
        const claim = order.indexOf('updateMany');
        const audit = order.indexOf('audit');
        expect(claim).toBeGreaterThan(-1);
        expect(audit).toBeGreaterThan(-1);
        expect(claim).toBeLessThan(audit);
    });
});

// ════════════════════════════════════════════════════════════════════
// #126 — no scan inside a tenant transaction; provenance recorded
// ════════════════════════════════════════════════════════════════════

describe('#126 scanning happens outside any transaction, with provenance', () => {
    it('holds no transaction open across the scan', async () => {
        findMany.mockResolvedValue([pendingRow({ id: 'x1' }), pendingRow({ id: 'x2' })]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // Walk the ledger and check the transaction depth at each scan. A
        // 30-second clamd round trip inside a tenant transaction pins a
        // Postgres connection (and, through PgBouncer, a pooled server) for
        // its whole duration.
        let depth = 0;
        const scansInsideTx: number[] = [];
        order.forEach((event, i) => {
            if (event === 'tx:start') depth++;
            else if (event === 'tx:end') depth--;
            else if (event === 'scan' && depth > 0) scansInsideTx.push(i);
        });
        expect(scansInsideTx).toEqual([]);
        expect(order).toContain('scan');
    });

    it('stamps scanDetails with the rescan-job provenance', async () => {
        findMany.mockResolvedValue([pendingRow()]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        const details = JSON.parse(String(verdictPayloads()[0].scanDetails));
        expect(details.source).toBe('rescan-job');
        expect(details.engine).toBe('clamav');
    });
});

// ════════════════════════════════════════════════════════════════════
// Boundedness + tenant scope
// ════════════════════════════════════════════════════════════════════

describe('the sweep is bounded and tenant-scoped', () => {
    it('selects with an explicit take and a tenant predicate', async () => {
        const { runAvRescan, AV_RESCAN_DEFAULT_LIMIT } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        const arg = findMany.mock.calls[0][0];
        expect(arg.take).toBe(AV_RESCAN_DEFAULT_LIMIT);
        expect(arg.where.tenantId).toBe(TENANT);
        expect(arg.where.scanStatus).toBe('PENDING');
    });

    it('clamps an operator-supplied limit to the hard cap', async () => {
        const { runAvRescan, AV_RESCAN_MAX_LIMIT } = loadJob();
        await runAvRescan({
            tenantId: TENANT,
            initiatedByUserId: USER,
            limit: AV_RESCAN_MAX_LIMIT * 100,
        });

        expect(findMany.mock.calls[0][0].take).toBe(AV_RESCAN_MAX_LIMIT);
    });
});

// ════════════════════════════════════════════════════════════════════
// #152 — the writes engage RLS, and are labelled honestly
// ════════════════════════════════════════════════════════════════════
//
// Production reported this job writing FileRecord with no tenant context at
// all — `rls-middleware.missing_tenant_context`, `hasAuditContext: false`,
// once per `updateMany`. The writes were correct, but the database was
// enforcing nothing behind them, which for an unattended bulk writer is the
// one place the second layer earns its cost.
//
// The neighbouring trap is what the last block here pins: the natural-looking
// fix is to label the context `source: 'job'`, and that label is in
// `KEK_BYPASS_SOURCES` — it silences the tripwire while switching the tenant
// DEK OFF, so encrypted reads come back `null`. Getting a tenant context is
// the fix; naming it 'job' is the bug that replaces it.

describe('#152 every statement runs inside the tenant RLS context', () => {
    it('binds the tenant for the selection AND for both writes', async () => {
        // One row that reaches a verdict, one that is left pending (its
        // object is missing from storage), so the selection read, the verdict
        // write and the attempt write are all exercised in a single run.
        const ok = pendingRow({ id: 'ctx-ok' });
        const missing = pendingRow({ id: 'ctx-missing' });
        storageBytes.delete(missing.pathKey);
        findMany.mockResolvedValue([ok, missing]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        // Positive: the read, the verdict write and the attempt write each
        // opened a context. Asserting the count is what catches a future edit
        // that wraps only some of them.
        expect(runInTenantJobContextMock).toHaveBeenCalledTimes(3);
        for (const [job] of runInTenantJobContextMock.mock.calls) {
            expect(job.tenantId).toBe(TENANT);
        }

        // ...and nothing reached the database outside one.
        let depth = 0;
        const outsideContext: string[] = [];
        for (const event of order) {
            if (event === 'tx:start') depth++;
            else if (event === 'tx:end') depth--;
            else if (['findMany', 'updateMany', 'update'].includes(event) && depth === 0) {
                outsideContext.push(event);
            }
        }
        expect(outsideContext).toEqual([]);
        // Pair the negative with a positive — an empty ledger would satisfy
        // the assertion above just as well as a correct one.
        expect(order).toContain('findMany');
        expect(order).toContain('updateMany');
    });

    it('labels the context with the job name, never a DEK-bypass source', async () => {
        findMany.mockResolvedValue([pendingRow()]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        const sources = runInTenantJobContextMock.mock.calls.map(([job]) => job.source);
        expect(sources.length).toBeGreaterThan(0);
        for (const source of sources) {
            expect(source).toBe('av-rescan');
            // The three labels in `KEK_BYPASS_SOURCES`. Any of them would
            // resolve the tenant DEK to null: encrypted reads would come back
            // `null` and encrypted writes would be sealed under the global KEK.
            expect(['seed', 'job', 'system']).not.toContain(source);
        }
    });

    it('scopes the verdict claim to the tenant as well as the row id', async () => {
        findMany.mockResolvedValue([pendingRow({ id: 'claim-1' })]);

        const { runAvRescan } = loadJob();
        await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        const verdictCall = updateMany.mock.calls.find(
            (c) => 'scanStatus' in (c[0] as { data: Record<string, unknown> }).data,
        );
        expect(verdictCall).toBeDefined();
        const where = (verdictCall as unknown[])[0] as { where: Record<string, unknown> };
        expect(where.where.id).toBe('claim-1');
        expect(where.where.tenantId).toBe(TENANT);
        // The claim predicate is still the concurrency control — adding the
        // tenant must not have cost us the `scanStatus: 'PENDING'` guard that
        // stops this job overwriting an INFECTED verdict.
        expect(where.where.scanStatus).toBe('PENDING');
    });
});

// ════════════════════════════════════════════════════════════════════
// Resilience of the sweep itself
// ════════════════════════════════════════════════════════════════════
//
// The blocks above all pin what the job must not WRITE. These pin that it
// keeps running and keeps counting honestly — the failures that cost an
// operator a whole page of rows without ever producing a wrong verdict.

describe('the sweep survives a bad row and reports honestly', () => {
    it('runs in permissive mode — only "disabled" stops the sweep', async () => {
        // Guard 1 must test for the one mode that fabricates a verdict, not
        // for the one mode that is fully configured. Written as
        // `!== 'strict'` it becomes a silent no-op on every permissive
        // deployment: the operator triggers a rescan, gets `scanned: 0`, and
        // concludes the backlog is empty when nothing was ever examined.
        mockEnv.AV_SCAN_MODE = 'permissive';
        findMany.mockResolvedValue([pendingRow({ id: 'file-permissive' })]);

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(scanBufferMock).toHaveBeenCalledTimes(1);
        expect(result.scanned).toBe(1);
        expect(result.clean).toBe(1);
    });

    it('leaves an unreadable object pending without abandoning the rest of the page', async () => {
        // A single missing or permission-denied object must cost one row, not
        // the page. If the read throw escapes the loop, every row ordered
        // after it goes unexamined for that run — and because nothing was
        // written, the next run selects the same page and dies on the same
        // row. The backlog never drains.
        const before = pendingRow({ id: 'file-before' });
        const gone = pendingRow({ id: 'file-gone' });
        const after = pendingRow({ id: 'file-after' });
        storageBytes.delete(gone.pathKey); // storage no longer has the object
        findMany.mockResolvedValue([before, gone, after]);

        const { runAvRescan } = loadJob();
        const result = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(result.readError).toBe(1);
        expect(result.clean).toBe(2);
        expect(verdictPayloads().map((d) => d.scanStatus)).toEqual(['CLEAN', 'CLEAN']);
        // The row after the failure was reached at all.
        expect(scanBufferMock).toHaveBeenCalledTimes(2);
    });

    it('accounts for every selected row exactly once', async () => {
        // `leftPending` is what an operator reads to decide whether to re-run,
        // and the per-reason counters are what they read to decide whether to
        // page someone. A branch that forgets to bump one of them makes the
        // summary quietly wrong in the direction of "looks finished".
        const huge = pendingRow({ id: 'r-huge', sizeBytes: 40 * 1024 * 1024 });
        const gone = pendingRow({ id: 'r-gone' });
        const torn = pendingRow({ id: 'r-torn' });
        const errd = pendingRow({ id: 'r-errd' });
        const good = pendingRow({ id: 'r-good' });
        storageBytes.delete(gone.pathKey);
        storageBytes.set(torn.pathKey, Buffer.from('truncated'));
        findMany.mockResolvedValue([huge, gone, torn, errd, good]);
        scanBufferMock.mockImplementation(async (buf: Buffer) =>
            buf.toString() === 'payload-of-r-errd'
                ? { status: 'ERROR' as const, engine: 'none', durationMs: 1 }
                : { status: 'CLEAN' as const, engine: 'clamav', durationMs: 2 },
        );

        const { runAvRescan } = loadJob();
        const r = await runAvRescan({ tenantId: TENANT, initiatedByUserId: USER });

        expect(r.oversize).toBe(1);
        expect(r.readError).toBe(1);
        expect(r.integrityMismatch).toBe(1);
        expect(r.scannerError).toBe(1);
        expect(r.leftPending).toBe(
            r.oversize + r.readError + r.integrityMismatch + r.scannerError + r.refusedSyntheticClean,
        );
        expect(r.scanned).toBe(r.clean + r.infected + r.leftPending + r.lostClaim);
    });
});
