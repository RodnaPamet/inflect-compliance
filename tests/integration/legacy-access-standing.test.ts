/**
 * The latest legacy snapshot's standing, over HTTP — the real route, the real
 * usecase, the real database.
 *
 * The connection page reads this to show when the accounts were last read,
 * whether that read was complete, its counts, and whether it is matched, and it
 * sends the snapshot id it names to "Match to people". So two properties matter
 * beyond the shape of the answer:
 *
 *   - the counts come from rows: `rowCount` is the snapshot's own column, and
 *     the matching counts are the LATEST run's resolution rows, per outcome;
 *   - the snapshot it names is the one campaign creation builds from, so what
 *     the page calls matched is what a campaign finds matched.
 *
 * Only `getTenantCtx` is mocked, because it is the one thing in the path that
 * needs a browser session; `requirePermission`, the usecase, RLS and the audit
 * row a refusal writes are all real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { GET } from '@/app/api/t/[tenantSlug]/admin/legacy-access/snapshot/route';
import { getLegacySnapshotStanding } from '@/app-layer/usecases/legacy-access-standing';
import { createLegacyAccessReview } from '@/app-layer/usecases/access-review-legacy';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `lstd-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OTHER = `t2-${SUITE}`;
const ADMIN = `u-adm-${SUITE}`;
const EDITOR = `u-ed-${SUITE}`;
const REVIEWER = `u-rev-${SUITE}`;
const USERS = [ADMIN, EDITOR, REVIEWER];

let connectionId = '';
let siblingConnectionId = '';
let otherTenantConnectionId = '';

const ctxFor = (userId: string, role: string, over: Partial<RequestContext> = {}) =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId, ...over });

const get = (query: string): NextRequest =>
    new NextRequest(`http://localhost/api/t/${TENANT}/admin/legacy-access/snapshot${query}`);

const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: TENANT }) });

const denials = () => prisma.auditLog.count({ where: { tenantId: TENANT, action: 'AUTHZ_DENIED' } });

async function clearRows(): Promise<void> {
    for (const tenantId of [TENANT, OTHER]) {
        const t = { tenantId };
        await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
        await prisma.accessReview.deleteMany({ where: t });
        await prisma.legacyAccountResolution.deleteMany({ where: t });
        await prisma.legacyAccount.deleteMany({ where: t });
        await prisma.legacyAccessSnapshot.deleteMany({ where: t });
        await prisma.integrationExecution.deleteMany({ where: t });
    }
}

async function seedSnapshot(opts: {
    tenantId?: string;
    connection?: string;
    status?: 'COMPLETE' | 'PARTIAL' | 'PENDING';
    completedAt?: Date | null;
    accountKeys?: string[];
    refusalReason?: 'TORN_SNAPSHOT' | null;
    refusalDetail?: string | null;
    rowsReceived?: number;
} = {}) {
    const tenantId = opts.tenantId ?? TENANT;
    const keys = opts.accountKeys ?? [];
    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId,
            connectionId: opts.connection ?? connectionId,
            remoteSnapshotId: `snap-${SUITE}-${randomUUID().slice(0, 6)}`,
            mappingVersion: 1,
            columnSetFingerprint: 'f'.repeat(64),
            payloadHash: opts.status === 'COMPLETE' || opts.status === undefined ? 'b'.repeat(64) : null,
            rowCount: keys.length,
            rowsReceived: opts.rowsReceived ?? keys.length,
            status: opts.status ?? 'COMPLETE',
            refusalReason: opts.refusalReason ?? null,
            refusalDetail: opts.refusalDetail ?? null,
            completedAt: opts.completedAt === undefined ? new Date() : opts.completedAt,
        },
    });
    for (const accountKey of keys) {
        await prisma.legacyAccount.create({
            data: {
                tenantId, snapshotId: snap.id, accountKey,
                displayName: accountKey, email: `${accountKey}@${SUITE}.test`,
                status: 'ACTIVE', accountType: 'HUMAN', isPrivileged: false,
                entitlements: [], lastLoginAt: new Date(),
            },
        });
    }
    return snap;
}

type Outcome = 'LINKED' | 'SUGGESTED' | 'AMBIGUOUS' | 'UNMATCHED' | 'NON_PERSON';

/** One reconcile run over `snapshotId`, writing one resolution per entry. */
async function seedRun(snapshotId: string, outcomes: Record<string, Outcome>, at: Date) {
    const exec = await prisma.integrationExecution.create({
        data: {
            tenantId: TENANT, connectionId, status: 'PASSED',
            provider: 'legacy-mcp', automationKey: 'legacy-mcp.reconcile',
            executedAt: at, completedAt: at,
        },
    });
    for (const [accountKey, outcome] of Object.entries(outcomes)) {
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: TENANT, executionId: exec.id, snapshotId, accountKey, outcome,
                method: outcome === 'LINKED' ? 'EMAIL_EXACT' : 'NO_CANDIDATES',
                signalsJson: [], candidatesJson: [], vetoesJson: [],
                createdAt: at,
            },
        });
    }
    return exec;
}

describeFn('GET /admin/legacy-access/snapshot (real route, real usecase, real DB)', () => {
    beforeAll(async () => {
        for (const id of [TENANT, OTHER]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        for (const [id, role] of [[ADMIN, 'ADMIN'], [EDITOR, 'EDITOR'], [REVIEWER, 'READER']] as const) {
            await prisma.user.upsert({
                where: { id }, update: {},
                create: { id, email: `${id}@example.test`, name: id },
            });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: TENANT, userId: id } },
                update: { role, status: 'ACTIVE' },
                create: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }
        const conn = (tenantId: string, name: string) =>
            prisma.integrationConnection.create({
                data: { tenantId, provider: 'legacy-mcp', name: `${name}-${SUITE}`, configJson: {} },
            });
        connectionId = (await conn(TENANT, 'ledger')).id;
        siblingConnectionId = (await conn(TENANT, 'payroll')).id;
        otherTenantConnectionId = (await conn(OTHER, 'ledger')).id;
    });

    beforeEach(async () => {
        await clearRows();
        getTenantCtxMock.mockReset();
        getTenantCtxMock.mockResolvedValue(ctxFor(ADMIN, 'ADMIN'));
    });

    afterAll(async () => {
        await clearRows();
        await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
        await deleteAuditRowsForTenants(prisma, [TENANT, OTHER]);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER] } } });
        await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    });

    it('a connection that was never read answers { snapshot: null }', async () => {
        const res = await GET(get(`?connectionId=${connectionId}`), routeArgs());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ snapshot: null });
    });

    it('names the latest snapshot, with its row count, coverage, and the LATEST run\'s counts per outcome', async () => {
        await seedSnapshot({ accountKeys: ['old1'], completedAt: new Date(Date.now() - 3_600_000) });
        const snap = await seedSnapshot({ accountKeys: ['a', 'b', 'c', 'd'] });
        // A sibling connection's snapshot is newer still, and is not this one's.
        await seedSnapshot({ connection: siblingConnectionId, accountKeys: ['z'] });

        // Two runs over the snapshot. The older one's verdicts are history; the
        // page reports the newer run, as campaign creation reads it.
        await seedRun(snap.id, { a: 'UNMATCHED', b: 'UNMATCHED', c: 'UNMATCHED', d: 'UNMATCHED' },
            new Date(Date.now() - 60_000));
        const latest = await seedRun(snap.id, { a: 'LINKED', b: 'LINKED', c: 'SUGGESTED', d: 'NON_PERSON' },
            new Date());

        const res = await GET(get(`?connectionId=${connectionId}`), routeArgs());
        expect(res.status).toBe(200);
        const { snapshot } = await res.json();
        expect(snapshot).toMatchObject({
            id: snap.id,
            status: 'COMPLETE',
            rowCount: 4,
            rowsReceived: 4,
            refusalReason: null,
            populationCoverage: 'UNKNOWN',
            reconciliation: {
                executionId: latest.id,
                status: 'PASSED',
                resolved: 4,
                byOutcome: { LINKED: 2, SUGGESTED: 1, NON_PERSON: 1 },
            },
        });
        expect(snapshot.reconciliation.byOutcome).not.toHaveProperty('UNMATCHED');
        expect(typeof snapshot.completedAt).toBe('string');
    });

    it('a refused read carries its named reason, its detail and the rows it received; nothing is matched', async () => {
        const snap = await seedSnapshot({
            status: 'PARTIAL',
            refusalReason: 'TORN_SNAPSHOT',
            refusalDetail: 'page 3 of 7 came from a different snapshot',
            rowsReceived: 250,
        });

        const { snapshot } = await (await GET(get(`?connectionId=${connectionId}`), routeArgs())).json();
        expect(snapshot).toMatchObject({
            id: snap.id,
            status: 'PARTIAL',
            rowCount: 0,
            rowsReceived: 250,
            refusalReason: 'TORN_SNAPSHOT',
            refusalDetail: 'page 3 of 7 came from a different snapshot',
            reconciliation: null,
        });
    });

    it('names the snapshot campaign creation builds from, so "matched" here is matched there', async () => {
        const older = await seedSnapshot({ accountKeys: ['kpatel'], completedAt: new Date(Date.now() - 3_600_000) });
        await seedRun(older.id, { kpatel: 'UNMATCHED' }, new Date(Date.now() - 3_000_000));
        const newer = await seedSnapshot({ accountKeys: ['kpatel', 'jsmith'] });
        await seedRun(newer.id, { kpatel: 'UNMATCHED', jsmith: 'LINKED' }, new Date());

        const admin = ctxFor(ADMIN, 'ADMIN');
        const { snapshot } = await getLegacySnapshotStanding(admin, connectionId);
        const created = await createLegacyAccessReview(admin, {
            name: `Legacy ${SUITE}`, connectionId, reviewerUserId: REVIEWER,
        });

        expect(snapshot?.id).toBe(newer.id);
        expect(created.snapshotId).toBe(snapshot?.id);
        expect(created.subjectCount).toBe(snapshot?.rowCount);
    });

    it('a read still in progress (no completedAt) is the latest for both readers', async () => {
        const done = await seedSnapshot({ accountKeys: ['kpatel'], completedAt: new Date(Date.now() - 60_000) });
        await seedRun(done.id, { kpatel: 'UNMATCHED' }, new Date(Date.now() - 30_000));
        const pending = await seedSnapshot({ status: 'PENDING', completedAt: null });

        const admin = ctxFor(ADMIN, 'ADMIN');
        const { snapshot } = await getLegacySnapshotStanding(admin, connectionId);
        expect(snapshot).toMatchObject({ id: pending.id, status: 'PENDING', completedAt: null, reconciliation: null });

        await expect(createLegacyAccessReview(admin, {
            name: `Legacy ${SUITE}`, connectionId, reviewerUserId: REVIEWER,
        })).rejects.toThrow(/^SNAPSHOT_INCOMPLETE: /);
    });

    it('another tenant\'s snapshot is not readable through its connection id', async () => {
        await seedSnapshot({ tenantId: OTHER, connection: otherTenantConnectionId, accountKeys: ['x'] });

        const res = await GET(get(`?connectionId=${otherTenantConnectionId}`), routeArgs());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ snapshot: null });
    });

    it('a member without admin.manage is refused at the gate: 403 and one AUTHZ_DENIED naming the key', async () => {
        await seedSnapshot({ accountKeys: ['a'] });
        getTenantCtxMock.mockResolvedValue(ctxFor(EDITOR, 'EDITOR'));
        const before = await denials();

        const res = await GET(get(`?connectionId=${connectionId}`), routeArgs());

        expect(res.status).toBe(403);
        expect(await denials()).toBe(before + 1);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entityId).toBe('admin.manage');
    });

    it('the usecase holds its own floor: an EDITOR context is refused', async () => {
        await expect(getLegacySnapshotStanding(ctxFor(EDITOR, 'EDITOR'), connectionId)).rejects.toThrow();
    });

    it('a request with no connectionId is a 400', async () => {
        const res = await GET(get(''), routeArgs());
        expect(res.status).toBe(400);
    });
});
