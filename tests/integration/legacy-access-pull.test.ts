/**
 * The pull, end to end: complete and verifiable, or visibly not complete.
 *
 * The transport is mocked because `fetchImpl` is a TEST SEAM no file under `src/`
 * may pass — the pull usecase must not accept one, so the seam has to be taken at
 * the module boundary instead. `requireActual` is spread first: the client module
 * exports error classes and constants this test and the usecase both need, and a
 * partial barrel mock is how a sibling export becomes "is not a function" three
 * suites away.
 *
 * What is NOT mocked is everything that decides whether a snapshot is
 * trustworthy: the mapping, the drift check, the ingest fault table, the hash,
 * and the order of writes.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';

const pullSnapshotMock = jest.fn();
jest.mock('@/lib/mcp/client', () => ({
    ...jest.requireActual('@/lib/mcp/client'),
    pullSnapshot: (...args: unknown[]) => pullSnapshotMock(...args),
}));

import { CONTRACT_VERSION } from '@/lib/mcp/client';
import { encryptField } from '@/lib/security/encryption';
import { computeColumnSetFingerprint, computePayloadHash } from '@/lib/legacy-access/canonical';
import { runLegacyAccessPull } from '@/app-layer/usecases/legacy-access-pull';
import { verifySnapshotPayloadHash } from '@/app-layer/usecases/legacy-access-verify';
import { makeRequestContext } from '../helpers/make-context';

const prisma: PrismaClient = prismaTestClient();

const TENANT = 'lgp-tenant';
const COLUMNS = ['LOGIN', 'EMAIL_ADDR', 'DISPLAY_NAME', 'STATUS', 'ROLE_1'];
const FINGERPRINT = computeColumnSetFingerprint(COLUMNS);

const MAPPING = {
    version: 2,
    columnSetFingerprint: FINGERPRINT,
    fields: {
        accountKey: 'LOGIN',
        email: 'EMAIL_ADDR',
        displayName: 'DISPLAY_NAME',
        status: 'STATUS',
    },
    entitlements: { kind: 'wide' as const, columns: ['ROLE_1'] },
    confirmedAt: '2026-10-09T00:00:00.000Z',
    confirmedByUserId: 'u1',
};

const manifest = (over: Record<string, unknown> = {}) => ({
    contract: CONTRACT_VERSION,
    app: { name: 'Payroll', owner: 'finance' },
    snapshot: { id: 'remote-snap-1', generatedAt: '2026-10-09T00:00:00.000Z', rowCount: 2 },
    columns: COLUMNS.map((name) => ({ name, type: 'string' as const, nullable: true })),
    pages: ['page-1'],
    layout: 'wide' as const,
    ...over,
});

const rows = [
    { LOGIN: 'jsmith', EMAIL_ADDR: 'j@corp.test', DISPLAY_NAME: 'John Smith', STATUS: 'A', ROLE_1: 'reader' },
    { LOGIN: 'bjones', EMAIL_ADDR: 'b@corp.test', DISPLAY_NAME: 'Bea Jones', STATUS: 'I', ROLE_1: 'admin' },
];

let connectionId: string;

async function makeConnection(configJson: Record<string, unknown>): Promise<string> {
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: TENANT,
            provider: 'legacy-mcp',
            name: 'legacy',
            configJson,
            secretEncrypted: encryptField(JSON.stringify({ bearerToken: 'tok-123' })),
        },
    });
    return conn.id;
}

async function clearPullRows(): Promise<void> {
    await prisma.legacyAccount.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyAccessSnapshot.deleteMany({ where: { tenantId: TENANT } });
}

/**
 * Everything a pull leaves behind that a test is ALLOWED to delete.
 *
 * Deliberately not the audit rows, and therefore not the tenant either. A pull
 * writes a hash-chained entry per snapshot, and the `audit_log_immutable` trigger
 * refuses every DELETE on `AuditLog` with `IMMUTABLE_AUDIT_LOG` — append-only is
 * the whole point of the trail, so a test that could tidy it away would be
 * evidence the guarantee does not hold. `AuditLog_tenantId_fkey` then keeps the
 * tenant row alive, so the tenant stays too; `resetDatabase` in `beforeAll` is
 * what makes the suite repeatable.
 *
 * Worth knowing when this bites: the trigger raises SQLSTATE 23001, which Prisma
 * renders as "Foreign key constraint violated on the (not available)". There is
 * no such foreign key. Do not go looking for one.
 */
async function clearTenantFootprint(): Promise<void> {
    await clearPullRows();
    await prisma.integrationExecution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearTenantFootprint();
    // Upsert, not delete-then-create: the tenant can survive a previous run
    // because its audit rows are undeletable (see above).
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: 'Pull Tenant', slug: TENANT },
    });
});

beforeEach(async () => {
    pullSnapshotMock.mockReset();
    await clearPullRows();
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    connectionId = await makeConnection({
        endpointUrl: 'https://legacy.example.com/rpc',
        legacyAccessMapping: MAPPING,
    });
});

afterAll(async () => {
    await clearTenantFootprint();
    await prisma.$disconnect();
});

describe('a complete pull', () => {
    beforeEach(() => {
        pullSnapshotMock.mockResolvedValue({ manifest: manifest(), rows, complete: true });
    });

    it('stores a COMPLETE snapshot with a payload hash', async () => {
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        expect(result.status).toBe('COMPLETE');
        expect(result.rowCount).toBe(2);

        const snap = await prisma.legacyAccessSnapshot.findUniqueOrThrow({
            where: { id: result.snapshotId! },
        });
        expect(snap.status).toBe('COMPLETE');
        expect(snap.payloadHash).toMatch(/^[0-9a-f]{64}$/);
        expect(snap.payloadHashAlgorithmVersion).toBe(1);
        expect(snap.remoteSnapshotId).toBe('remote-snap-1');
        expect(snap.mappingVersion).toBe(2);
        expect(snap.completedAt).not.toBeNull();
    });

    it('requests ONLY the mapped columns — the projection is the boundary', async () => {
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const opts = pullSnapshotMock.mock.calls[0][0] as { fields: readonly string[] };
        expect([...opts.fields].sort()).toEqual(['DISPLAY_NAME', 'EMAIL_ADDR', 'LOGIN', 'ROLE_1', 'STATUS']);
    });

    it('bounds the pull with the SNAPSHOT cap, not the transport default', async () => {
        // The product decides how many accounts a snapshot may hold; the client's
        // own MAX_TOTAL_ROWS stays a backstop for a caller that forgets.
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const opts = pullSnapshotMock.mock.calls[0][0] as { maxTotalRows: number };
        expect(opts.maxTotalRows).toBe(50_000);
    });

    it('the hash RECOMPUTES from the rows in the database', async () => {
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const ctx = makeRequestContext('AUDITOR', { tenantId: TENANT });
        const verdict = await verifySnapshotPayloadHash(ctx, result.snapshotId!);
        expect(verdict.verified).toBe(true);
        expect(verdict.recomputedHash).toBe(verdict.storedHash);
        expect(verdict.rowCount).toBe(2);
    });

    it('the recomputed hash FAILS once a stored row is altered', async () => {
        // The property that makes the hash evidence rather than decoration.
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        await prisma.legacyAccount.updateMany({
            where: { tenantId: TENANT, accountKey: 'jsmith' },
            data: { email: 'attacker@evil.test' },
        });
        const ctx = makeRequestContext('AUDITOR', { tenantId: TENANT });
        const verdict = await verifySnapshotPayloadHash(ctx, result.snapshotId!);
        expect(verdict.verified).toBe(false);
        expect(verdict.reason).toContain('does not match');
    });

    it('stores canonical values, mapping the status vocabulary', async () => {
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const accounts = await prisma.legacyAccount.findMany({
            where: { tenantId: TENANT },
            orderBy: { accountKey: 'asc' },
        });
        expect(accounts.map((a) => [a.accountKey, a.status, a.entitlements])).toEqual([
            ['bjones', 'DISABLED', ['admin']],
            ['jsmith', 'ACTIVE', ['reader']],
        ]);
    });

    it('a zero-account application is still COMPLETE — an empty table is a true observation', async () => {
        pullSnapshotMock.mockResolvedValue({
            manifest: manifest({ snapshot: { id: 'empty', generatedAt: '2026-10-09T00:00:00.000Z', rowCount: 0 } }),
            rows: [],
            complete: true,
        });
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        expect(result.status).toBe('COMPLETE');
        expect(result.rowCount).toBe(0);
        // Invariant 5 bites at campaign CREATION, which refuses an empty
        // population. A snapshot is evidence, not a certificate — and the
        // execution records NOT_APPLICABLE so "no data" never reads as compliant.
        const exec = await prisma.integrationExecution.findUniqueOrThrow({
            where: { id: result.executionId! },
        });
        expect(exec.status).toBe('NOT_APPLICABLE');
    });
});

describe('oversharing', () => {
    it('drops the extra column, flags the connection, and stores NO value from it', async () => {
        const extra = [...COLUMNS, 'COST_CENTRE'];
        pullSnapshotMock.mockResolvedValue({
            manifest: manifest({
                columns: extra.map((name) => ({ name, type: 'string' as const, nullable: true })),
            }),
            rows: rows.map((r) => ({ ...r, COST_CENTRE: 'CC-4412' })),
            complete: true,
        });
        // The mapping was confirmed against the WIDER set, so this is oversharing
        // rather than drift — the server sends a column the projection excluded.
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: {
                configJson: {
                    endpointUrl: 'https://legacy.example.com/rpc',
                    legacyAccessMapping: {
                        ...MAPPING,
                        columnSetFingerprint: computeColumnSetFingerprint(extra),
                    },
                },
            },
        });

        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        expect(result.status).toBe('COMPLETE');
        expect(result.overshared).toEqual(['COST_CENTRE']);

        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        expect(conn.oversharingColumns).toEqual(['COST_CENTRE']);
        expect(conn.oversharingObservedAt).not.toBeNull();

        // The database check the hardening list asks for: no stored value anywhere
        // equals the overshared cell. Queried as raw rows so no select list can
        // hide it.
        const raw = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM "LegacyAccount" WHERE "tenantId" = $1`,
            TENANT
        );
        expect(JSON.stringify(raw)).not.toContain('CC-4412');
        expect(JSON.stringify(raw)).not.toContain('COST_CENTRE');
    });

    it('CLEARS the flag on a later clean pull, so the banner cannot go stale', async () => {
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: { oversharingObservedAt: new Date(), oversharingColumns: ['OLD'] },
        });
        pullSnapshotMock.mockResolvedValue({ manifest: manifest(), rows, complete: true });
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        expect(conn.oversharingColumns).toEqual([]);
        expect(conn.oversharingObservedAt).toBeNull();
    });
});

describe('every fault yields a snapshot that is not COMPLETE, with a named reason', () => {
    const cases: Array<[string, unknown, string]> = [
        [
            'an incomplete transport read',
            { manifest: manifest(), rows, complete: false, reason: { kind: 'torn-snapshot', message: 'pages disagreed' } },
            'TORN_SNAPSHOT',
        ],
        [
            'a timeout',
            { manifest: manifest(), rows: [], complete: false, reason: { kind: 'timeout', message: 'budget spent' } },
            'TIMEOUT',
        ],
        [
            'a cap exceeded',
            { manifest: manifest(), rows: [], complete: false, reason: { kind: 'cap-exceeded', message: 'too big' } },
            'CAP_EXCEEDED',
        ],
        [
            'a contract violation',
            { manifest: manifest(), rows: [], complete: false, reason: { kind: 'contract-violation', message: 'bad shape' } },
            'CONTRACT_VIOLATION',
        ],
        [
            'an SSRF refusal',
            { manifest: manifest(), rows: [], complete: false, reason: { kind: 'ssrf-blocked', message: 'private address' } },
            'SSRF_BLOCKED',
        ],
        [
            'schema drift',
            {
                manifest: manifest({
                    columns: [...COLUMNS, 'NEW_COL'].map((name) => ({ name, type: 'string' as const, nullable: true })),
                }),
                rows,
                complete: true,
            },
            'SCHEMA_DRIFT',
        ],
        [
            'a layout the mapping does not expect',
            { manifest: manifest({ layout: 'long' as const }), rows, complete: true },
            'SCHEMA_DRIFT',
        ],
        [
            'a row with no account key',
            { manifest: manifest(), rows: [{ ...rows[0], LOGIN: '' }], complete: true },
            'MISSING_ACCOUNT_KEY',
        ],
        [
            'a duplicate account key',
            { manifest: manifest(), rows: [rows[0], rows[0]], complete: true },
            'DUPLICATE_ACCOUNT_KEY',
        ],
        [
            'a secret-shaped value',
            { manifest: manifest(), rows: [{ ...rows[0], DISPLAY_NAME: 'AKIAIOSFODNN7EXAMPLE' }], complete: true },  // pragma: allowlist secret -- the AWS docs example key, a synthetic input proving the egress scan fires
            'SECRET_SHAPED_VALUE',
        ],
        [
            'no readable manifest',
            { manifest: null, rows: [], complete: false, reason: { kind: 'contract-violation', message: 'unparseable' } },
            'ROW_SCHEMA_INVALID',
        ],
    ];

    it.each(cases)('%s → PARTIAL, reason %s, and nothing stored', async (_label, pullResult, reason) => {
        pullSnapshotMock.mockResolvedValue(pullResult);
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });

        expect(result.status).toBe('PARTIAL');
        expect(result.refusalReason).toBe(reason);

        const snap = await prisma.legacyAccessSnapshot.findUniqueOrThrow({
            where: { id: result.snapshotId! },
        });
        expect(snap.status).not.toBe('COMPLETE');
        expect(snap.refusalReason).toBe(reason);
        expect(snap.refusalDetail).toBeTruthy();
        // No hash on a population we did not read whole — a verifier comparing
        // hashes would otherwise find it valid.
        expect(snap.payloadHash).toBeNull();

        // And NO accounts.
        const stored = await prisma.legacyAccount.count({ where: { tenantId: TENANT } });
        expect(stored).toBe(0);
    });

    it('a refusal records PARTIAL on the execution, not ERROR — the run reached a verdict', async () => {
        pullSnapshotMock.mockResolvedValue({
            manifest: manifest(), rows, complete: false,
            reason: { kind: 'torn-snapshot', message: 'pages disagreed' },
        });
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const exec = await prisma.integrationExecution.findUniqueOrThrow({
            where: { id: result.executionId! },
        });
        expect(exec.status).toBe('PARTIAL');
    });

    it('a refusal leaves the snapshot unverifiable rather than falsely verified', async () => {
        pullSnapshotMock.mockResolvedValue({
            manifest: manifest(), rows, complete: false,
            reason: { kind: 'torn-snapshot', message: 'pages disagreed' },
        });
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const ctx = makeRequestContext('AUDITOR', { tenantId: TENANT });
        const verdict = await verifySnapshotPayloadHash(ctx, result.snapshotId!);
        // "Nothing to compare" is not "verified".
        expect(verdict.verified).toBe(false);
        expect(verdict.storedHash).toBeNull();
    });
});

describe('authentication failure', () => {
    it('marks the connection credential bad on a 401, which the Test button never does', async () => {
        pullSnapshotMock.mockResolvedValue({
            manifest: null, rows: [], complete: false,
            reason: { kind: 'authentication-failed', message: 'rejected' },
        });
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        // Only a background pull is entitled to record this conclusion — a
        // half-typed token in the operator Test box must not flag the integration
        // as down, which is why `validateConnection` never calls it.
        expect(conn.authFailedAt).not.toBeNull();
        expect(conn.authFailureReason).toContain('invalid_token');
    });

    it('records the auth reason from a FIXED set, never the server own message', async () => {
        pullSnapshotMock.mockResolvedValue({
            manifest: null, rows: [], complete: false,
            reason: { kind: 'authentication-failed', message: 'your token sk-live-SHOULD-NOT-APPEAR is bad' },
        });
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        // `authFailureReason` is persisted verbatim and exempt from field
        // encryption on the grounds that it is system-generated.
        expect(conn.authFailureReason).not.toContain('SHOULD-NOT-APPEAR');
    });
});

describe('mapping preconditions', () => {
    it('refuses with MAPPING_MISSING and stores NO snapshot when no mapping is saved', async () => {
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: { configJson: { endpointUrl: 'https://legacy.example.com/rpc' } },
        });
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        expect(result.refusalReason).toBe('MAPPING_MISSING');
        expect(result.snapshotId).toBeNull();
        // No snapshot, because this path never dialled — a snapshot row would
        // claim we looked.
        const snaps = await prisma.legacyAccessSnapshot.count({ where: { tenantId: TENANT } });
        expect(snaps).toBe(0);
        expect(pullSnapshotMock).not.toHaveBeenCalled();
    });

    it('never dials when the connection does not exist', async () => {
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId: 'nope' });
        expect(result.status).toBe('NOT_APPLICABLE');
        expect(pullSnapshotMock).not.toHaveBeenCalled();
    });
});

describe('the connection lock', () => {
    it('a second concurrent pull does nothing rather than opening a rival snapshot', async () => {
        pullSnapshotMock.mockResolvedValue({ manifest: manifest(), rows, complete: true });
        // Two overlapping pulls would each open a snapshot against the same remote
        // snapshot id and each believe it held the whole table.
        const [first, second] = await Promise.all([
            runLegacyAccessPull({ tenantId: TENANT, connectionId }),
            runLegacyAccessPull({ tenantId: TENANT, connectionId }),
        ]);
        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual(['COMPLETE', 'SKIPPED_LOCKED']);
        const snaps = await prisma.legacyAccessSnapshot.count({ where: { tenantId: TENANT } });
        expect(snaps).toBe(1);
    });

    it('releases the lock, so the next pull is not wedged until the lease expires', async () => {
        pullSnapshotMock.mockResolvedValue({ manifest: manifest(), rows, complete: true });
        await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        await clearPullRows();
        const again = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        expect(again.status).toBe('COMPLETE');
    });
});

describe('the stored hash matches an independent computation', () => {
    it('equals computePayloadHash over the canonical accounts', async () => {
        pullSnapshotMock.mockResolvedValue({ manifest: manifest(), rows, complete: true });
        const result = await runLegacyAccessPull({ tenantId: TENANT, connectionId });
        const expected = computePayloadHash([
            {
                accountKey: 'bjones', username: null, displayName: 'Bea Jones', givenName: null,
                familyName: null, email: 'b@corp.test', employeeNumber: null, department: null,
                title: null, managerRef: null, status: 'DISABLED', lastLoginAt: null,
                createdAt: null, expiresAt: null, entitlements: ['admin'], isPrivileged: null,
                accountType: 'UNKNOWN',
            },
            {
                accountKey: 'jsmith', username: null, displayName: 'John Smith', givenName: null,
                familyName: null, email: 'j@corp.test', employeeNumber: null, department: null,
                title: null, managerRef: null, status: 'ACTIVE', lastLoginAt: null,
                createdAt: null, expiresAt: null, entitlements: ['reader'], isPrivileged: null,
                accountType: 'UNKNOWN',
            },
        ]);
        expect(result.payloadHash).toBe(expected);
    });
});
