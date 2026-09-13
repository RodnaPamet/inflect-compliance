/**
 * Epic P1 — Process Map optimistic concurrency.
 *
 * The behaviour:
 *   1. A save with no `expectedVersion` → succeeds (last-write-wins
 *      back-compat for older clients).
 *   2. A save with `expectedVersion = currentVersion` → succeeds,
 *      bumps version by 1.
 *   3. A save with `expectedVersion < currentVersion` (stale) →
 *      throws `staleData` carrying `{ currentVersion }` details. The
 *      route maps this to HTTP 409 / `STALE_DATA`.
 *   4. The graph at the time of the stale save is NOT mutated — the
 *      previous node/edge set remains intact. This proves the
 *      destructive delete-and-insert rolls back under the outer tx
 *      when the conditional updateMany or the up-front check
 *      refuses the write.
 *
 * These four behavioural anchors are what the unit-test layer
 * cannot reach: the conditional `updateMany` predicate + outer-tx
 * rollback only show up against a real Postgres.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `p1-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
let USER_ID = '';

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    const u = await globalPrisma.user.create({
        data: { email: `${SUITE_TAG}@example.test`, emailHash: SUITE_TAG },
    });
    USER_ID = u.id;
}

async function cleanup() {
    await globalPrisma.processMap.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    // AuditLog has an IMMUTABLE_AUDIT_LOG trigger that refuses
    // DELETE under regular role. Use the same
    // `session_replication_role = 'replica'` escape hatch the rest
    // of the integration suite uses to clean its audit fixtures.
    // We seed audit rows via the usecase layer (logEvent), so the
    // map creates + replaceGraph commits both write audit entries.
    await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
    await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

describeFn('Epic P1 — process map optimistic concurrency', () => {
    let mapId = '';

    beforeAll(async () => {
        await seed();
    });

    afterAll(async () => {
        await cleanup();
        await globalPrisma.$disconnect();
    });

    beforeEach(async () => {
        // Each test owns its own map so we don't accidentally bleed
        // version state across cases.
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        const map = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.create(db, ctx, {
                name: `P1 map ${randomUUID().slice(0, 6)}`,
                description: null,
                createdByUserId: USER_ID,
            }),
        );
        mapId = map.id;
        // Sanity: a freshly created map starts at v1.
        expect(map.version).toBe(1);
    });

    afterEach(async () => {
        await globalPrisma.processMap.deleteMany({
            where: { id: mapId, tenantId: TENANT_ID },
        });
    });

    it('1. omitting expectedVersion preserves last-write-wins back-compat', async () => {
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        const saved = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, {
                nodes: [],
                edges: [],
            }),
        );
        expect(saved).not.toBeNull();
        expect(saved!.version).toBe(2);
    });

    it('2. expectedVersion matches → save commits + version bumps by 1', async () => {
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        const saved = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, {
                nodes: [
                    {
                        nodeKey: 'n-1',
                        nodeType: 'processStep',
                        label: 'Step 1',
                        posX: 0,
                        posY: 0,
                    },
                ],
                edges: [],
                expectedVersion: 1,
            }),
        );
        expect(saved).not.toBeNull();
        expect(saved!.version).toBe(2);
        expect(saved!.nodes).toHaveLength(1);
    });

    it('3. stale expectedVersion → throws staleData with currentVersion details', async () => {
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        // First commit lands at v=2.
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, {
                nodes: [
                    {
                        nodeKey: 'first',
                        nodeType: 'processStep',
                        label: 'First',
                        posX: 0,
                        posY: 0,
                    },
                ],
                edges: [],
                expectedVersion: 1,
            }),
        );
        // Second commit claims it's still at v=1 — stale. Should
        // throw with details carrying the actual current version.
        const stalePromise = runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, {
                nodes: [
                    {
                        nodeKey: 'stale',
                        nodeType: 'processStep',
                        label: 'Stale',
                        posX: 10,
                        posY: 10,
                    },
                ],
                edges: [],
                expectedVersion: 1,
            }),
        );
        await expect(stalePromise).rejects.toMatchObject({
            code: 'STALE_DATA',
            status: 409,
            details: { currentVersion: 2 },
        });
    });

    it('4. graph at the time of a stale save is preserved (outer-tx rollback)', async () => {
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        // First commit lands "first" node.
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, {
                nodes: [
                    {
                        nodeKey: 'first',
                        nodeType: 'processStep',
                        label: 'First',
                        posX: 0,
                        posY: 0,
                    },
                ],
                edges: [],
                expectedVersion: 1,
            }),
        );
        // Stale save tries to install "intruder" — must NOT land.
        await expect(
            runInTenantContext(ctx, (db) =>
                ProcessMapRepository.replaceGraph(db, ctx, mapId, {
                    nodes: [
                        {
                            nodeKey: 'intruder',
                            nodeType: 'processStep',
                            label: 'Intruder',
                            posX: 9,
                            posY: 9,
                        },
                    ],
                    edges: [],
                    expectedVersion: 1,
                }),
            ),
        ).rejects.toMatchObject({ code: 'STALE_DATA' });
        // The graph still carries "first", not "intruder". This is
        // the rollback proof — without it, the destructive
        // delete-and-insert at the top of `replaceGraph` would have
        // wiped "first" before the conditional updateMany aborted.
        const afterStale = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.getByIdWithGraph(db, ctx, mapId),
        );
        expect(afterStale?.nodes.map((n) => n.nodeKey)).toEqual(['first']);
        expect(afterStale?.version).toBe(2);
    });
});
