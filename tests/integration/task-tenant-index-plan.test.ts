/**
 * B3-5 (b) — dropping `Task_tenantId_idx` did not cost the planner an
 * access path.
 *
 * The bare `@@index([tenantId])` on `Task` was a strict prefix of
 * `@@unique([tenantId, key])` and of eleven `[tenantId, …]` composites.
 * Postgres can serve a `WHERE "tenantId" = $1` predicate from the LEADING
 * column of any of them, so the single-column index was never the only
 * viable path — it was pure write amplification (one extra index to
 * maintain on every Task INSERT/UPDATE) plus its own heap footprint.
 *
 * This test proves the claim behaviourally rather than asserting it in
 * prose. It seeds a skewed distribution (one tenant holding a small
 * fraction of the rows, so `tenantId` is genuinely selective), ANALYZEs,
 * and asks the planner what it would do:
 *
 *   - the bare index is gone, AND
 *   - a tenant-scoped count still resolves via an *index* scan, not a
 *     Seq Scan.
 *
 * It therefore fails if a future change removes the remaining
 * tenantId-leading composites and leaves per-tenant reads sequential —
 * which is the regression the dropped index used to mask.
 *
 * Everything runs inside a transaction that is rolled back, so the test
 * leaves no rows behind and never mutates the shared schema.
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';

const d = DB_AVAILABLE ? describe : describe.skip;

/** Rows seeded for the experiment; skewed 99.75% / 0.25% across two tenants. */
const TOTAL_ROWS = 20_000;
const SELECTIVE_ROWS = 50;

d('Task tenantId access path after dropping the prefix index', () => {
    const prisma = prismaTestClient();

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('no longer has the redundant single-column Task_tenantId_idx', async () => {
        const rows: Array<{ indexname: string }> = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'Task'`,
        );
        const names = rows.map((r) => r.indexname);

        // Sanity: the Task table really is indexed (if this collapsed to
        // an empty list the assertion below would vacuously pass).
        expect(names.length).toBeGreaterThan(5);
        expect(names).not.toContain('Task_tenantId_idx');
    });

    it('still has at least one tenantId-LEADING index to serve the predicate', async () => {
        const rows: Array<{ indexdef: string }> = await prisma.$queryRawUnsafe(
            `SELECT indexdef FROM pg_indexes WHERE tablename = 'Task'`,
        );
        // `... ON public."Task" USING btree ("tenantId", ...)` — tenantId first.
        const leading = rows.filter((r) =>
            /\(\s*"?tenantId"?\s*[,)]/.test(r.indexdef),
        );
        expect(leading.length).toBeGreaterThan(0);
    });

    it('plans a selective per-tenant read as an index scan, not a Seq Scan', async () => {
        const tenants: Array<{ id: string }> = await prisma.$queryRawUnsafe(
            `SELECT id FROM "Tenant" LIMIT 2`,
        );
        const users: Array<{ id: string }> = await prisma.$queryRawUnsafe(
            `SELECT id FROM "User" LIMIT 1`,
        );
        if (tenants.length < 2 || users.length < 1) {
            throw new Error(
                'Fixture precondition failed: need >=2 Tenant rows and >=1 User row. ' +
                    'Seed the test DB before running this suite.',
            );
        }
        const [bulkTenant, selectiveTenant] = tenants;
        const author = users[0];

        // Interactive transaction so the seeded rows and the ANALYZE are
        // rolled back; the planner still sees them while inside it.
        await expect(
            prisma.$transaction(
                async (tx: typeof prisma) => {
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "Task"
                           (id, "tenantId", title, "createdByUserId",
                            status, type, severity, priority, "createdAt", "updatedAt")
                         SELECT 'idxplan' || g,
                                CASE WHEN g <= ${SELECTIVE_ROWS} THEN $2 ELSE $1 END,
                                'idxplan' || g, $3,
                                'OPEN', 'TASK', 'MEDIUM', 'P2', now(), now()
                         FROM generate_series(1, ${TOTAL_ROWS}) g`,
                        bulkTenant.id,
                        selectiveTenant.id,
                        author.id,
                    );
                    await tx.$executeRawUnsafe(`ANALYZE "Task"`);

                    const plan: Array<Record<string, unknown>> =
                        await tx.$queryRawUnsafe(
                            `EXPLAIN (FORMAT JSON)
                             SELECT count(*) FROM "Task" WHERE "tenantId" = $1`,
                            selectiveTenant.id,
                        );

                    const planText = JSON.stringify(plan);
                    const usesIndex = /"Node Type":"[^"]*Index[^"]*Scan"/.test(
                        planText,
                    );
                    const usesSeqScan = /"Node Type":"Seq Scan"/.test(planText);

                    // Roll the transaction back regardless of outcome by
                    // throwing a sentinel carrying the verdict.
                    throw Object.assign(new Error('ROLLBACK_SENTINEL'), {
                        usesIndex,
                        usesSeqScan,
                        planText,
                    });
                },
                { timeout: 120_000 },
            ),
        ).rejects.toMatchObject({
            message: 'ROLLBACK_SENTINEL',
            usesIndex: true,
            usesSeqScan: false,
        });

        // The rows are gone — the transaction was rolled back.
        const leftover: Array<{ n: bigint }> = await prisma.$queryRawUnsafe(
            `SELECT count(*)::bigint AS n FROM "Task" WHERE id LIKE 'idxplan%'`,
        );
        expect(Number(leftover[0].n)).toBe(0);
    }, 180_000);
});
